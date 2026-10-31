// Bookmark export/import.
//
// Source: read-only parse of Chromium's Bookmarks JSON or Firefox's
// places.sqlite. Target: Chromium's Bookmarks JSON (version 1) written while
// the target profile is not in use.
//
// The target decoder (components/bookmarks/browser/bookmark_codec.cc) requires
// version=1, roots.bookmark_bar/other/synced, and for each child id/name/type
// (+url or children). GUIDs must be valid UUIDs or Chromium reassigns them and
// marks the model as requiring recovery. We therefore always emit valid UUIDs
// and never write the (currently unverified on load) checksum.
import crypto from "node:crypto";
import { readJsonIfExists } from "./fs-safe.mjs";
import { withReadOnlyCopy, tableExists, queryAll } from "./sqlite.mjs";

const ROOT_UUIDS = {
  bookmark_bar: "0bc5d13f-2cba-5d74-951f-3f233fe6c908",
  other: "82b081ec-3dd3-529c-8475-ab6c344590dd",
  mobile: "4cf2e351-0e85-532b-bb37-df045d8f8d0f",
};

const ROOT_IDS = { bookmark_bar: "1", other: "2", mobile: "3" };

const ALLOWED_URL_SCHEMES = new Set([
  "http:",
  "https:",
  "ftp:",
  "file:",
  "chrome:",
  "edge:",
  "brave:",
  "about:",
  "javascript:",
  "view-source:",
]);

export function readBookmarkTree(profile) {
  if (profile.family === "firefox") return readFirefoxBookmarkTree(profile);
  return readChromiumBookmarkTree(profile);
}

function emptyTree() {
  return {
    bookmark_bar: { name: "Bookmarks bar", children: [] },
    other: { name: "Other bookmarks", children: [] },
    mobile: { name: "Mobile bookmarks", children: [] },
  };
}

function readChromiumBookmarkTree(profile) {
  const entry = (profile.files || {})["Bookmarks"];
  if (!entry) return { ok: false, error: "bookmarks-missing" };
  const data = readJsonIfExists(entry.path, 128 * 1024 * 1024);
  if (!data) return { ok: false, error: "bookmarks-invalid-json" };
  const roots = data.roots && typeof data.roots === "object" ? data.roots : {};
  const tree = emptyTree();
  const stats = { urls: 0, folders: 0, skippedUrls: 0, invalidFolders: 0 };
  for (const key of ["bookmark_bar", "other", "mobile"]) {
    const srcKey = key === "mobile" ? "synced" : key;
    const node = roots[srcKey];
    if (!node || typeof node !== "object") continue;
    tree[key].children = normalizeChromiumChildren(node.children, stats);
    tree[key].name = typeof node.name === "string" && node.name ? node.name : tree[key].name;
  }
  return { ok: true, roots: tree, stats };
}

function normalizeChromiumChildren(children, stats) {
  if (!Array.isArray(children)) return [];
  const out = [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.type === "url") {
      const url = typeof child.url === "string" ? child.url : "";
      if (!isAllowedBookmarkUrl(url)) {
        stats.skippedUrls += 1;
        continue;
      }
      stats.urls += 1;
      out.push({
        type: "url",
        name: typeof child.name === "string" ? child.name : url,
        url,
        dateAdded: parseMicros(child.date_added),
      });
    } else if (child.type === "folder") {
      stats.folders += 1;
      out.push({
        type: "folder",
        name: typeof child.name === "string" && child.name ? child.name : "Folder",
        dateAdded: parseMicros(child.date_added),
        children: normalizeChromiumChildren(child.children, stats),
      });
    } else {
      stats.invalidFolders += 1;
    }
  }
  return out;
}

function readFirefoxBookmarkTree(profile) {
  const entry = (profile.files || {})["places.sqlite"];
  if (!entry) return { ok: false, error: "places-missing" };
  const res = withReadOnlyCopy(entry.path, (db) => {
    if (!tableExists(db, "moz_bookmarks")) return { error: "moz_bookmarks-missing" };
    const q = queryAll(
      db,
      "SELECT b.id, b.type, b.parent, b.position, b.title, p.url, b.dateAdded " +
        "FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id " +
        "WHERE b.type IN (1, 2) ORDER BY b.parent, b.position",
    );
    if (!q.ok) return { error: q.error };
    return { rows: q.rows };
  });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.value.error) return { ok: false, error: res.value.error };
  const rows = res.value.rows;
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row.parent);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(row);
  }
  const stats = { urls: 0, folders: 0, skippedUrls: 0, invalidFolders: 0 };
  const build = (parentId) => {
    const out = [];
    for (const row of byParent.get(parentId) || []) {
      const type = Number(row.type);
      if (type === 1) {
        const url = typeof row.url === "string" ? row.url : "";
        if (!isAllowedBookmarkUrl(url)) {
          stats.skippedUrls += 1;
          continue;
        }
        stats.urls += 1;
        out.push({
          type: "url",
          name: typeof row.title === "string" && row.title ? row.title : url,
          url,
          dateAdded: firefoxMicros(row.dateAdded),
        });
      } else if (type === 2) {
        stats.folders += 1;
        out.push({
          type: "folder",
          name: typeof row.title === "string" && row.title ? row.title : "Folder",
          dateAdded: firefoxMicros(row.dateAdded),
          children: build(Number(row.id)),
        });
      }
    }
    return out;
  };
  // Firefox root ids: 1 places, 2 menu, 3 toolbar, 4 unfiled, 5 tags, 6 mobile.
  const tree = emptyTree();
  tree.bookmark_bar.children = build(3);
  const otherChildren = [];
  const unfiled = build(4);
  otherChildren.push(...build(2));
  if (unfiled.length) {
    otherChildren.push({ type: "folder", name: "Unsorted bookmarks", children: unfiled, dateAdded: Date.now() });
    stats.folders += 1;
  }
  tree.other.children = otherChildren;
  tree.mobile.children = build(6);
  return { ok: true, roots: tree, stats };
}

function firefoxMicros(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return Math.floor(n / 1000);
}

function parseMicros(value) {
  // Chromium stores microseconds since 1601-01-01. Normalize to Unix ms.
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return Math.round(n / 1000) - 11644473600000;
}

export function isAllowedBookmarkUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2 * 1024 * 1024) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_URL_SCHEMES.has(parsed.protocol);
}

function toWindowsMicros(dateMs) {
  // 11644473600000 ms between 1601-01-01 and 1970-01-01.
  return String(BigInt(Math.trunc(dateMs) + 11644473600000) * 1000n);
}

function newNodeIdFactory(start = 1000) {
  let next = Math.max(1000, Number(start) || 1000);
  return () => String(next++);
}

function toTargetChildren(children, nextId) {
  const out = [];
  for (const node of children || []) {
    if (node.type === "url") {
      if (!isAllowedBookmarkUrl(node.url)) continue;
      out.push({
        date_added: toWindowsMicros(typeof node.dateAdded === "number" ? node.dateAdded : Date.now()),
        date_last_used: "0",
        guid: crypto.randomUUID(),
        id: nextId(),
        name: String(node.name || node.url).slice(0, 4096),
        type: "url",
        url: node.url,
      });
    } else if (node.type === "folder") {
      out.push({
        children: toTargetChildren(node.children, nextId),
        date_added: toWindowsMicros(typeof node.dateAdded === "number" ? node.dateAdded : Date.now()),
        date_modified: toWindowsMicros(Date.now()),
        guid: crypto.randomUUID(),
        id: nextId(),
        name: String(node.name || "Folder").slice(0, 4096),
        type: "folder",
      });
    }
  }
  return out;
}

function permanentNode(key, children) {
  return {
    children,
    date_added: toWindowsMicros(Date.now()),
    date_modified: toWindowsMicros(Date.now()),
    guid: ROOT_UUIDS[key],
    id: ROOT_IDS[key],
    name: key === "bookmark_bar" ? "Bookmarks bar" : key === "other" ? "Other bookmarks" : "Mobile bookmarks",
    type: "folder",
  };
}

export function newBookmarkFile() {
  return {
    version: 1,
    roots: {
      bookmark_bar: permanentNode("bookmark_bar", []),
      other: permanentNode("other", []),
      mobile: permanentNode("mobile", []),
    },
  };
}

export function uniqueFolderName(parentChildren, base) {
  const names = new Set((parentChildren || []).map((n) => (typeof n.name === "string" ? n.name : "")));
  if (!names.has(base)) return base;
  let i = 1;
  while (names.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

export function buildImportFolder(tree, sourceLabel, nextId = newNodeIdFactory(), folderId = null) {
  const children = [];
  for (const key of ["bookmark_bar", "other", "mobile"]) {
    const items = toTargetChildren(tree[key]?.children || [], nextId);
    if (!items.length) continue;
    children.push({
      children: items,
      date_added: toWindowsMicros(Date.now()),
      date_modified: toWindowsMicros(Date.now()),
      guid: crypto.randomUUID(),
      id: nextId(),
      name: tree[key]?.name || key,
      type: "folder",
    });
  }
  return {
    children,
    date_added: toWindowsMicros(Date.now()),
    date_modified: toWindowsMicros(Date.now()),
    guid: crypto.randomUUID(),
    id: folderId || nextId(),
    name: String(sourceLabel || "Imported bookmarks").slice(0, 512),
    type: "folder",
  };
}

export function maxBookmarkId(targetFile) {
  let max = 3;
  const walk = (node) => {
    const id = Number(node && node.id);
    if (Number.isFinite(id) && id > max) max = id;
    if (node && Array.isArray(node.children)) for (const child of node.children) walk(child);
  };
  for (const key of ["bookmark_bar", "other", "mobile"]) {
    const root = targetFile && targetFile.roots ? targetFile.roots[key] : null;
    if (root) walk(root);
  }
  return max;
}

export function addImportFolder(targetFile, tree, { sourceLabel, placement = "other" }) {
  const rootKey = placement === "bar" ? "bookmark_bar" : "other";
  const root = targetFile.roots[rootKey];
  const name = uniqueFolderName(root.children || [], sourceLabel);
  const nextId = newNodeIdFactory(maxBookmarkId(targetFile) + 1);
  // Reserve the folder id from the same factory so child ids cannot collide.
  const folderId = nextId();
  const folder = buildImportFolder(tree, name, nextId, folderId);
  root.children = root.children || [];
  root.children.push(folder);
  return folder;
}

// Sanity checks that mirror what BookmarkCodec::Decode requires.
export function validateBookmarkFile(value) {
  const errors = [];
  if (!value || typeof value !== "object") return ["not-an-object"];
  if (value.version !== 1) errors.push("version-must-be-1");
  if (!value.roots || typeof value.roots !== "object") {
    errors.push("roots-missing");
    return errors;
  }
  for (const key of ["bookmark_bar", "other", "mobile"]) {
    const node = value.roots[key];
    if (!node || typeof node !== "object") {
      errors.push(`roots.${key}-missing`);
      continue;
    }
    if (node.type !== "folder" || !Array.isArray(node.children)) errors.push(`roots.${key}-invalid`);
    validateChildren(node.children, `roots.${key}.children`, errors);
  }
  return errors;
}

function validateChildren(children, where, errors) {
  if (!Array.isArray(children)) {
    errors.push(`${where}-not-array`);
    return;
  }
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (!node || typeof node !== "object") {
      errors.push(`${where}[${i}]-not-object`);
      continue;
    }
    if (typeof node.id !== "string" || !/^\d+$/.test(node.id)) errors.push(`${where}[${i}]-bad-id`);
    if (typeof node.guid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(node.guid)) {
      errors.push(`${where}[${i}]-bad-guid`);
    }
    if (typeof node.name !== "string") errors.push(`${where}[${i}]-bad-name`);
    if (node.type === "url") {
      if (typeof node.url !== "string" || !isAllowedBookmarkUrl(node.url)) errors.push(`${where}[${i}]-bad-url`);
    } else if (node.type === "folder") {
      if (!Array.isArray(node.children)) errors.push(`${where}[${i}]-bad-children`);
      else validateChildren(node.children, `${where}[${i}].children`, errors);
    } else {
      errors.push(`${where}[${i}]-bad-type`);
    }
  }
}
