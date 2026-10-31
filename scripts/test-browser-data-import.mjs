#!/usr/bin/env node
// End-to-end tests for scripts/import/browser-data-import.mjs.
//
// All fixtures are synthetic profiles under a temp directory. The test never
// reads or writes a real browser profile, never starts a browser, and asserts
// that source files are byte-identical after every command.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { validateBookmarkFile } from "./import/lib/bookmarks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(REPO, "scripts", "import", "browser-data-import.mjs");

const COOKIE_CANARY = "COOKIE-CANARY-DO-NOT-LEAK-7f3a";
const PASSWORD_CANARY = "PASSWORD-CANARY-DO-NOT-LEAK-91bc";
const AUTOFILL_CANARY = "AUTOFILL-CANARY-5d20";
const FIREFOX_LOGIN_CANARY = "FF-LOGIN-CANARY-2e77";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.error(`FAIL ${name}: ${err && err.stack ? err.stack.split("\n")[0] : err}`);
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function openDb(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  return db;
}

function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        out[path.relative(root, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

function readAllText(dir) {
  let text = "";
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) text += readAllText(p);
    else if (ent.isFile()) text += fs.readFileSync(p, "utf8");
  }
  return text;
}

function run(args, { expect = 0, env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, BP_IMPORT_TEST_MODE: "1", ...env },
    timeout: 120000,
    windowsHide: true,
  });
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  if (expect !== null) {
    assert.equal(
      res.status,
      expect,
      `command failed (${res.status}): ${args.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return { ...res, combined };
}

function makeChromiumRoot(root) {
  writeJson(path.join(root, "Local State"), {
    profile: {
      info_cache: {
        Default: { name: "Test Person" },
        "Profile 1": { name: "Second Profile" },
      },
    },
  });
  const def = path.join(root, "Default");
  fs.mkdirSync(def, { recursive: true });
  writeJson(path.join(def, "Preferences"), {
    homepage: "https://example.test/",
    homepage_is_newtabpage: false,
    session: { restore_on_startup: 4, startup_urls: ["https://example.test/start"] },
  });
  writeJson(path.join(def, "Bookmarks"), {
    checksum: "ignored",
    roots: {
      bookmark_bar: {
        children: [
          { date_added: "13200000000000000", id: "11", name: "Example", type: "url", url: "https://example.test/a" },
          {
            children: [
              { date_added: "13200000000000000", id: "13", name: "Skipped", type: "url", url: "place:sort=8" },
              { date_added: "13200000000000000", id: "14", name: "JS", type: "url", url: "javascript:alert(1)" },
            ],
            date_added: "13200000000000000",
            id: "12",
            name: "Folder A",
            type: "folder",
          },
        ],
        date_added: "13200000000000000",
        id: "1",
        name: "Bookmarks bar",
        type: "folder",
      },
      other: { children: [], id: "2", name: "Other bookmarks", type: "folder" },
      synced: { children: [], id: "3", name: "Mobile bookmarks", type: "folder" },
    },
    version: 1,
  });

  const history = openDb(path.join(def, "History"));
  history.exec(
    "CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0, favicon_id INTEGER DEFAULT 0);" +
      "CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL);",
  );
  history
    .prepare("INSERT INTO urls VALUES (?,?,?,?,?,?,?,?)")
    .run(1, "https://example.test/a", "Example A", 3, 1, 13300000000000000, 0, 0);
  history
    .prepare("INSERT INTO urls VALUES (?,?,?,?,?,?,?,?)")
    .run(2, "https://example.test/b", "Example B", 1, 0, 13300000001000000, 0, 0);
  history.prepare("INSERT INTO visits VALUES (?,?,?,?,?)").run(1, 1, 13300000000000000, 0, 0);
  history.prepare("INSERT INTO visits VALUES (?,?,?,?,?)").run(2, 2, 13300000001000000, 0, 0);
  history.close();

  const cookies = openDb(path.join(def, "Cookies"));
  cookies.exec(
    "CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, has_cross_site_ancestor INTEGER NOT NULL);",
  );
  const ins = cookies.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.run(1, ".example.test", "", "sid", COOKIE_CANARY, new Uint8Array(), "/", 0, 1, 1, 1, 0, 0, 1, 2, 2, 443, 1, 0, 0);
  ins.run(2, ".example.test", "https://top.test", "part", "", Buffer.from("v20" + "deadbeef", "utf8"), "/", 0, 1, 0, 1, 1, 1, 1, 0, 2, 443, 1, 0, 1);
  ins.run(3, ".v10.test", "", "old", "", Buffer.from("v10" + "deadbeef", "utf8"), "/", 0, 0, 0, 1, 1, 1, 1, 0, 1, 80, 1, 0, 0);
  cookies.close();

  const login = openDb(path.join(def, "Login Data"));
  login.exec(
    "CREATE TABLE logins(id INTEGER PRIMARY KEY, origin_url VARCHAR NOT NULL, username_element VARCHAR, username_value VARCHAR, password_element VARCHAR, password_value BLOB, signon_realm VARCHAR NOT NULL, blacklisted_by_user INTEGER NOT NULL);",
  );
  login
    .prepare("INSERT INTO logins VALUES (?,?,?,?,?,?,?,?)")
    .run(1, "https://example.test", "user", "user@example.test", "pass", Buffer.from("v10" + PASSWORD_CANARY, "utf8"), "https://example.test", 0);
  login.close();

  const webdata = openDb(path.join(def, "Web Data"));
  webdata.exec("CREATE TABLE autofill(name VARCHAR, value VARCHAR, value_lower VARCHAR, date_created INTEGER, date_last_used INTEGER, count INTEGER);");
  webdata.prepare("INSERT INTO autofill VALUES (?,?,?,?,?,?)").run("email", AUTOFILL_CANARY, AUTOFILL_CANARY.toLowerCase(), 1, 2, 1);
  webdata.close();

  const extDir = path.join(def, "Extensions", "abcdefghijklmnopabcdefghijklmnop", "1.0.0");
  writeJson(path.join(extDir, "manifest.json"), { manifest_version: 3, name: "Test Extension", version: "1.0.0" });
  fs.mkdirSync(path.join(def, "Sessions"), { recursive: true });
  writeText(path.join(def, "Sessions", "Current Session"), "synthetic");

  const p1 = path.join(root, "Profile 1");
  fs.mkdirSync(p1, { recursive: true });
  writeJson(path.join(p1, "Preferences"), {});
  writeText(path.join(p1, "SingletonLock"), "test-host-1234");
  return def;
}

function makeFirefoxRoot(root) {
  writeText(
    path.join(root, "profiles.ini"),
    "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=FF Test\nIsRelative=1\nPath=Profiles/ff.default\nDefault=1\n",
  );
  const ff = path.join(root, "Profiles", "ff.default");
  fs.mkdirSync(ff, { recursive: true });
  const places = openDb(path.join(ff, "places.sqlite"));
  places.exec(
    "CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed INTEGER, hidden INTEGER, last_visit_date INTEGER);" +
      "CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);" +
      "CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, parent INTEGER, position INTEGER, title TEXT, fk INTEGER, dateAdded INTEGER);",
  );
  places.prepare("INSERT INTO moz_places VALUES (?,?,?,?,?,?,?)").run(1, "https://ff.test/one", "FF One", 2, 1, 0, 1700000000000000);
  places.prepare("INSERT INTO moz_places VALUES (?,?,?,?,?,?,?)").run(2, "https://ff.test/two", "FF Two", 1, 0, 0, 1700000001000000);
  places.prepare("INSERT INTO moz_historyvisits VALUES (?,?,?,?)").run(1, 1, 1700000000000000, 1);
  places.prepare("INSERT INTO moz_historyvisits VALUES (?,?,?,?)").run(2, 2, 1700000001000000, 1);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(2, 2, 0, 0, "menu", null, 0);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(3, 2, 0, 0, "toolbar", null, 0);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(4, 2, 0, 0, "unfiled", null, 0);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(6, 2, 0, 0, "mobile", null, 0);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(10, 2, 3, 0, "FF Folder", null, 1700000000000000);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(11, 1, 10, 0, "FF One", 1, 1700000000000000);
  places.prepare("INSERT INTO moz_bookmarks VALUES (?,?,?,?,?,?,?)").run(12, 1, 2, 0, "FF Two", 2, 1700000001000000);
  places.close();

  const cookies = openDb(path.join(ff, "cookies.sqlite"));
  cookies.exec(
    "CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, isPartitionedAttributeSet INTEGER);",
  );
  cookies
    .prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(1, "", "sid", COOKIE_CANARY, ".ff.test", "/", 0, 1, 1, 1, 1, 1);
  cookies.close();

  writeJson(path.join(ff, "logins.json"), {
    logins: [
      { hostname: "https://ff.test", username: FIREFOX_LOGIN_CANARY, encrypted: "synthetic-encrypted", timeCreated: 1 },
    ],
  });
  writeText(path.join(ff, "key4.db"), "synthetic-key4");
  const fh = openDb(path.join(ff, "formhistory.sqlite"));
  fh.exec("CREATE TABLE moz_formhistory(id INTEGER PRIMARY KEY, fieldname TEXT, value TEXT, timesUsed INTEGER, firstUsed INTEGER, lastUsed INTEGER);");
  fh.prepare("INSERT INTO moz_formhistory VALUES (?,?,?,?,?,?)").run(1, "email", AUTOFILL_CANARY, 1, 1, 2);
  fh.close();
  writeText(path.join(ff, "prefs.js"), 'user_pref("browser.startup.homepage", "https://ff.test/");\nuser_pref("browser.startup.page", 3);\n');
  fs.mkdirSync(path.join(ff, "extensions"), { recursive: true });
  writeText(path.join(ff, "extensions", "test@example.xpi"), "not-a-real-xpi");
  fs.mkdirSync(path.join(ff, "sessionstore-backups"), { recursive: true });
  writeText(path.join(ff, "sessionstore-backups", "recovery.jsonlz4"), "synthetic");
  return ff;
}

function makeEdgeRoot(root) {
  writeJson(path.join(root, "Local State"), { profile: { info_cache: { Default: { name: "Edge Person" } } } });
  const def = path.join(root, "Default");
  fs.mkdirSync(def, { recursive: true });
  writeJson(path.join(def, "Preferences"), {});
  writeJson(path.join(def, "Bookmarks"), {
    version: 1,
    roots: {
      bookmark_bar: { children: [], id: "1", name: "Bookmarks bar", type: "folder" },
      other: { children: [], id: "2", name: "Other bookmarks", type: "folder" },
      synced: { children: [], id: "3", name: "Mobile bookmarks", type: "folder" },
    },
  });
  return def;
}

function main() {
  const tmp = tempDir("bp-import-test-");
  const chromeRoot = path.join(tmp, "chrome-root");
  const edgeRoot = path.join(tmp, "edge-root");
  const ffRoot = path.join(tmp, "firefox-root");
  const braveRoot = path.join(tmp, "brave-root");
  const chromiumRoot = path.join(tmp, "chromium-root");
  const chromeProfile = makeChromiumRoot(chromeRoot);
  makeEdgeRoot(edgeRoot);
  const ffProfile = makeFirefoxRoot(ffRoot);
  fs.mkdirSync(braveRoot, { recursive: true });
  fs.mkdirSync(chromiumRoot, { recursive: true });

  const sourceHashBefore = {
    chrome: hashTree(chromeRoot),
    edge: hashTree(edgeRoot),
    firefox: hashTree(ffRoot),
  };

  const roots = [
    "--root",
    `chrome=${chromeRoot}`,
    "--root",
    `edge=${edgeRoot}`,
    "--root",
    `firefox=${ffRoot}`,
    "--root",
    `brave=${braveRoot}`,
    "--root",
    `chromium=${chromiumRoot}`,
  ];

  check("discover lists synthetic Chrome/Edge/Firefox profiles", () => {
    const res = run(["discover", "--inspect", "--json", ...roots]);
    const data = JSON.parse(res.stdout);
    const ids = data.profiles.map((p) => p.id);
    assert.ok(ids.includes("chrome:Default"), JSON.stringify(ids));
    assert.ok(ids.includes("chrome:Profile 1"), JSON.stringify(ids));
    assert.ok(ids.includes("edge:Default"), JSON.stringify(ids));
    assert.ok(ids.includes("firefox:ff.default"), JSON.stringify(ids));
    const c = data.profiles.find((p) => p.id === "chrome:Default");
    assert.equal(c.inventory.cookies.count.total, 3);
    assert.equal(c.inventory.cookies.encryption.appBoundV20, 1);
    assert.equal(c.inventory.cookies.encryption.dpapiV10, 1);
    assert.equal(c.inventory.cookies.count.httpOnly, 1);
    assert.equal(c.inventory.cookies.count.partitioned, 1);
    assert.equal(c.inventory.cookies.count.session, 1);
    assert.equal(c.inventory.passwords.count.logins, 1);
    assert.equal(c.inventory.bookmarks.count.urls, 3);
    assert.equal(c.inventory.history.count.urls, 2);
    assert.equal(c.inventory.extensions.count, 1);
    const p1 = data.profiles.find((p) => p.id === "chrome:Profile 1");
    assert.equal(p1.running.running, true);
    const ff = data.profiles.find((p) => p.id === "firefox:ff.default");
    assert.equal(ff.inventory.cookies.count.total, 1);
    assert.equal(ff.inventory.passwords.count.logins, 1);
    assert.equal(res.combined.includes(COOKIE_CANARY), false, "cookie value leaked to output");
    assert.equal(res.combined.includes(PASSWORD_CANARY), false, "password value leaked to output");
  });

  const bundle = path.join(tmp, "bundle");
  check("plan reports cookies/passwords as blocked/official-flow", () => {
    const res = run([
      "plan",
      "--source",
      "chrome:Default",
      "--target-profile",
      path.join(tmp, "target-plan"),
      "--items",
      "cookies,bookmarks,history,passwords,autofill,tabs,extensions",
      "--json",
      ...roots,
    ]);
    const plan = JSON.parse(res.stdout);
    assert.equal(plan.items.cookies.status, "blocked");
    assert.equal(plan.items.bookmarks.status, "ready");
    assert.equal(plan.items.history.status, "export-only");
    assert.equal(plan.items.passwords.status, "official-flow-required");
    assert.equal(plan.items.tabs.status, "blocked");
    assert.equal(res.combined.includes(COOKIE_CANARY), false);
    assert.equal(res.combined.includes(PASSWORD_CANARY), false);
  });

  check("export writes no cookie/password values and no forbidden DBs", () => {
    const res = run([
      "export",
      "--source",
      "chrome:Default",
      "--out",
      bundle,
      "--items",
      "cookies,bookmarks,history,passwords,tabs,extensions",
      "--json",
      ...roots,
    ]);
    const data = JSON.parse(res.stdout);
    assert.equal(data.manifest.items.bookmarks.status, "ok");
    assert.equal(data.manifest.items.history.status, "exported");
    assert.equal(data.manifest.items.cookies.status, "blocked");
    for (const name of ["Cookies", "Login Data", "Local State", "History", "key4.db", "logins.json"]) {
      assert.equal(fs.existsSync(path.join(bundle, name)), false, `bundle contains ${name}`);
    }
    const text = readAllText(bundle);
    assert.equal(text.includes(COOKIE_CANARY), false);
    assert.equal(text.includes(PASSWORD_CANARY), false);
    assert.equal(res.combined.includes(COOKIE_CANARY), false);
    assert.equal(res.combined.includes(PASSWORD_CANARY), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
    assert.equal(manifest.items.cookies.status, "blocked");
    const result = JSON.parse(fs.readFileSync(path.join(bundle, "result.json"), "utf8"));
    assert.equal(result.loginVerified.status, "not_verified");
    assert.equal(result.cookieImported.status, "blocked");
  });

  check("export autofill only when explicitly requested (values are personal data)", () => {
    const autoBundle = path.join(tmp, "bundle-autofill");
    run(["export", "--source", "chrome:Default", "--out", autoBundle, "--items", "autofill", ...roots]);
    const text = readAllText(autoBundle);
    assert.ok(text.includes(AUTOFILL_CANARY), "autofill export should contain the requested value");
  });

  const target = path.join(tmp, "target-profile");
  check("apply writes a valid Bookmarks file and never claims cookie/login success", () => {
    const res = run(["apply", "--bundle", bundle, "--target-profile", target, "--json"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.result.dataCopied.bookmarks, true);
    assert.equal(out.result.cookieImported.status, "blocked");
    assert.equal(out.result.loginVerified.status, "not_verified");
    const bookmarks = JSON.parse(fs.readFileSync(path.join(target, "Bookmarks"), "utf8"));
    assert.deepEqual(validateBookmarkFile(bookmarks), []);
    const folder = bookmarks.roots.other.children.find((n) => n.name.startsWith("Imported from Google Chrome"));
    assert.ok(folder, "import folder missing");
    assert.equal(folder.children[0].children.length, 2);
    assert.equal(res.combined.includes(COOKIE_CANARY), false);
    assert.equal(res.combined.includes(PASSWORD_CANARY), false);
  });

  check("re-apply refuses a non-empty target without --allow-existing", () => {
    const res = run(["apply", "--bundle", bundle, "--target-profile", target], { expect: 2 });
    assert.ok(res.combined.includes("target-not-empty") || res.combined.includes("not empty"));
  });

  check("re-apply with --allow-existing creates a backup and a unique folder", () => {
    const before = fs.readFileSync(path.join(target, "Bookmarks"));
    const res = run(["apply", "--bundle", bundle, "--target-profile", target, "--allow-existing", "--json"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    const backups = fs.readdirSync(target).filter((n) => n.startsWith("Bookmarks.bak."));
    assert.ok(backups.length >= 1, "no backup created");
    const after = JSON.parse(fs.readFileSync(path.join(target, "Bookmarks"), "utf8"));
    assert.deepEqual(validateBookmarkFile(after), []);
    const imported = after.roots.other.children.filter((n) => n.name.startsWith("Imported from Google Chrome"));
    assert.equal(imported.length, 2);
    assert.notEqual(imported[0].name, imported[1].name);
    assert.notEqual(before.toString(), fs.readFileSync(path.join(target, "Bookmarks")).toString());
  });

  check("apply refuses a target inside a real source-browser user data root", () => {
    if (process.platform !== "win32") return; // path-based policy is Windows-specific here
    const realChromeRoot = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
    const res = run(
      ["apply", "--bundle", bundle, "--target-profile", path.join(realChromeRoot, "Default", "evil")],
      { expect: 3 },
    );
    assert.ok(res.combined.includes("target-inside-source-browser"));
  });

  check("apply refuses the source profile itself", () => {
    const res = run(["apply", "--bundle", bundle, "--target-profile", chromeProfile], { expect: 2 });
    assert.ok(res.combined.includes("target-is-source"), res.combined);
  });

  check("apply refuses an existing target with encrypted bookmarks", () => {
    const encTarget = path.join(tmp, "target-encrypted");
    fs.mkdirSync(encTarget, { recursive: true });
    writeText(path.join(encTarget, "EncryptedBookmarks2"), "synthetic");
    const res = run(["apply", "--bundle", bundle, "--target-profile", encTarget, "--allow-existing"], { expect: 2 });
    assert.ok(res.combined.includes("encrypted"));
  });

  check("verify refuses to claim a login without explicit user action", () => {
    const res = run(
      ["verify", "--bundle", bundle, "--status", "user_confirmed", "--domain", "example.test"],
      { expect: 3 },
    );
    assert.ok(res.combined.includes("explicit-user-action-required"));
  });

  check("verify records an explicit user-confirmed login and never upgrades cookie/data states", () => {
    run([
      "verify",
      "--bundle",
      bundle,
      "--status",
      "user_confirmed",
      "--domain",
      "example.test",
      "--confirm-user-action",
    ]);
    const result = JSON.parse(fs.readFileSync(path.join(bundle, "result.json"), "utf8"));
    assert.equal(result.loginVerified.status, "user_confirmed");
    assert.equal(result.cookieImported.status, "blocked");
    assert.equal(result.dataCopied.history, false);
  });

  const ffTarget = path.join(tmp, "target-firefox-import");
  const ffBundle = path.join(tmp, "bundle-firefox");
  check("Firefox source exports bookmarks/history and applies bookmarks to a new target", () => {
    run([
      "export",
      "--source",
      "firefox:ff.default",
      "--out",
      ffBundle,
      "--items",
      "bookmarks,history,cookies,passwords",
      ...roots,
    ]);
    const bookmarks = JSON.parse(fs.readFileSync(path.join(ffBundle, "bookmarks.json"), "utf8"));
    assert.ok(bookmarks.roots.bookmark_bar.children.length >= 1);
    const text = readAllText(ffBundle);
    assert.equal(text.includes(COOKIE_CANARY), false);
    assert.equal(text.includes(FIREFOX_LOGIN_CANARY), false);
    assert.equal(text.includes(AUTOFILL_CANARY), false);
    const res = run(["apply", "--bundle", ffBundle, "--target-profile", ffTarget, "--json"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    const targetBookmarks = JSON.parse(fs.readFileSync(path.join(ffTarget, "Bookmarks"), "utf8"));
    assert.deepEqual(validateBookmarkFile(targetBookmarks), []);
  });

  check("source profiles are byte-identical after all commands (read-only proof)", () => {
    assert.deepEqual(hashTree(chromeRoot), sourceHashBefore.chrome);
    assert.deepEqual(hashTree(edgeRoot), sourceHashBefore.edge);
    assert.deepEqual(hashTree(ffRoot), sourceHashBefore.firefox);
  });

  check("migrate runs plan+export+apply end to end", () => {
    const out = path.join(tmp, "bundle-migrate");
    const tgt = path.join(tmp, "target-migrate");
    const res = run([
      "migrate",
      "--source",
      "chrome:Default",
      "--out",
      out,
      "--target-profile",
      tgt,
      "--items",
      "cookies,bookmarks",
      ...roots,
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(tgt, "Bookmarks")));
    const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
    assert.equal(result.dataCopied.bookmarks, true);
    assert.equal(result.cookieImported.status, "blocked");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n${f.error && f.error.stack ? f.error.stack : f.error}`);
    process.exitCode = 1;
  }
  // Keep temp dirs on failure for inspection; clean on success.
  if (failures.length === 0) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  } else {
    console.error(`fixtures kept at ${tmp}`);
  }
}

main();
