// Non-destructive Chrome E2E: auth, imported template, stale-ref guard and emergency Stop detach.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const { authToken } = JSON.parse(fs.readFileSync(path.join("native-host", "auth.json"), "utf8"));

async function tryConnect(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let probeBuf = "";
    const done = (value) => {
      if (settled) return;
      settled = true;
      s.removeAllListeners("data");
      s.removeAllListeners("error");
      if (!value) s.destroy();
      resolve(value);
    };
    s.setTimeout(700, () => done(undefined));
    s.once("connect", () => s.write(JSON.stringify({ type: "command", name: "version", args: {}, requestId: "probe", authToken }) + "\n"));
    s.on("data", (d) => {
      probeBuf += d.toString("utf8");
      const nl = probeBuf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(probeBuf.slice(0, nl));
        done(msg.ok === true ? s : undefined);
      } catch { done(undefined); }
    });
    s.once("error", () => done(undefined));
  });
}

let socket;
for (let port = 47001; port <= 47060 && !socket; port++) socket = await tryConnect(port);
assert.ok(socket, "no BrowserPilot host found");
socket.setTimeout(0);
socket.on("error", () => {});
let buf = "";
const waiters = new Map();
socket.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === "result" && waiters.has(msg.requestId)) {
      waiters.get(msg.requestId)(msg);
      waiters.delete(msg.requestId);
    }
  }
});

let seq = 0;
function command(name, args = {}, authenticate = false) {
  const requestId = "live-" + (++seq);
  const msg = { type: "command", name, args, requestId, ...(authenticate ? { authToken } : {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error("timeout: " + name)); }, 30000);
    waiters.set(requestId, (result) => { clearTimeout(timer); resolve(result); });
    socket.write(JSON.stringify(msg) + "\n");
  });
}

try {
  const tabsResult = await command("list_tabs");
  assert.equal(tabsResult.ok, true);
  const page = tabsResult.data.tabs.find((t) => /^https?:/i.test(t.url || ""));
  assert.ok(page, "no http(s) tab available for non-destructive snapshot test");
  await command("uninstall_template", { id: "_bp-live-prompt-test" });
  const cleanupCheck1 = await command("list_templates");
  const cleanupCheck2 = await command("list_templates");
  assert.equal(cleanupCheck1.data.some((item) => item.id === "_bp-live-prompt-test"), false);
  assert.equal(cleanupCheck2.data.some((item) => item.id === "_bp-live-prompt-test"), false, "legacy template resurrected after v2 became empty");

  const template = {
    id: "bp-live-prompt-test",
    name: "BrowserPilot live prompt test",
    version: "1.0.0",
    description: "Non-destructive registry integration test",
    category: "generic",
    inputs: [{ name: "value", type: "string", required: true }],
    steps: "prompt",
    body: "echo:$value",
  };
  const forbidden = { ...template, id: "bp-live-forbidden", body: [{ name: "reload", args: {} }], steps: "commands" };
  const rejected = await command("install_template", { content: JSON.stringify(forbidden) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /不允许调用命令/);
  await command("uninstall_template", { id: template.id }).catch(() => undefined);
  assert.equal((await command("install_template", { content: JSON.stringify(template) })).ok, true);
  const listed = await command("list_templates");
  const installed = listed.data.find((item) => item.id === template.id);
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.enabled, true);
  const detail = await command("get_template_detail", { id: template.id });
  assert.equal(detail.data.template.version, "1.0.0");
  const duplicate = await command("compare_templates", { ids: [template.id], candidate: { ...template, id: "bp-live-prompt-copy" } });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.data.comparisons[0].likelyDuplicate, true);
  const localUpdate = await command("check_template_update", { id: template.id });
  assert.equal(localUpdate.data.reason, "local_source");
  assert.equal((await command("sync_registry", { repo: "insogao/BrowserPilot", ref: "main", refresh: true })).ok, true);
  const search = await command("search_templates", { query: "registry", repo: "insogao/BrowserPilot", ref: "main" });
  assert.equal(search.ok, true);
  assert.ok(search.data.templates.some((item) => item.id === "browserpilot-example-prompt"));
  const remoteDetail = await command("get_template_detail", { id: "browserpilot-example-prompt", repo: "insogao/BrowserPilot", ref: "main" });
  assert.equal(remoteDetail.ok, true);
  const remoteCompare = await command("compare_templates", {
    ids: ["browserpilot-example-prompt"],
    candidate: { ...remoteDetail.data.template, id: "browserpilot-example-prompt-copy" },
    repo: "insogao/BrowserPilot",
    ref: "main",
  });
  assert.equal(remoteCompare.data.comparisons[0].likelyDuplicate, true);
  assert.equal((await command("set_template_enabled", { id: template.id, enabled: false })).ok, true);
  assert.equal((await command("run_template", { id: template.id, params: { value: "blocked" } })).ok, false);
  assert.equal((await command("set_template_enabled", { id: template.id, enabled: true })).ok, true);
  const run = await command("run_template", { id: template.id, params: { value: "ok" } });
  assert.equal(run.ok, true);
  assert.equal(run.data.prompt, "echo:ok");
  const exported = await command("export_template", { id: template.id, as: "json" });
  assert.equal(exported.ok, true);
  assert.equal(exported.data.template.id, template.id);
  const v2 = { ...template, version: "2.0.0", body: "echo-v2:$value" };
  assert.equal((await command("install_template", { content: JSON.stringify(v2) })).ok, true);
  assert.equal((await command("rollback_template", { id: template.id })).ok, true);
  const rolledBack = await command("export_template", { id: template.id, as: "json" });
  assert.equal(rolledBack.data.template.version, "1.0.0");

  const snap = await command("snapshot", { level: "L0", tabId: page.tabId });
  assert.equal(snap.ok, true);
  const ref = Object.keys(snap.data.refs)[0];
  if (ref) {
    assert.equal((await command("js", { tabId: page.tabId, expression: "(()=>{const n=document.createElement('i');n.id='bp-live-mutation';n.hidden=true;document.body.appendChild(n);return true})()" })).ok, true);
    await new Promise((r) => setTimeout(r, 0));
    const stale = await command("click", { tabId: page.tabId, ref, snapshotId: snap.data.snapshotId });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /page_updated/);
    await command("js", { tabId: page.tabId, expression: "document.getElementById('bp-live-mutation')?.remove();true" });
  }

  const stopped = await command("stop");
  assert.equal(stopped.ok, true);
  assert.ok(stopped.data.detachedTabs.includes(page.tabId));
  assert.equal((await command("uninstall_template", { id: template.id })).ok, true);
  console.log("PASS live: registry lifecycle + stale ref + Stop detach");
} finally {
  await command("uninstall_template", { id: "bp-live-prompt-test" }).catch(() => undefined);
  socket.end();
}
