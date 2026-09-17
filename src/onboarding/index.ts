import type { CommandName, PopupRequest } from "../shared/types";

interface TemplateListItem {
  id: string;
  name: string;
  version?: string;
  description?: string;
  category?: string;
  tags?: string[];
  builtin?: boolean;
  enabled?: boolean;
  source?: { type?: string; repo?: string; path?: string; ref?: string; url?: string };
  updatedAt?: number;
  contentHash?: string;
  canRollback?: boolean;
  capabilities?: string[];
  installed?: boolean;
  intents?: string[];
  keywords?: string[];
  sites?: string[];
  inputs?: Array<{ name: string; type: string; required?: boolean; description?: string }>;
  overridesBuiltin?: boolean;
}

interface UpdateCandidate {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  localVersion?: string;
  remoteVersion?: string;
  source?: Record<string, unknown>;
  updated?: boolean;
}

interface RegistryUpdateResult {
  registry: { repo: string; ref: string; syncedAt: number; total: number };
  counts: { updates: number; added: number; local: number };
  updates: UpdateCandidate[];
  added: UpdateCandidate[];
}

const TAG_LABELS: Record<string, string> = {
  search: "搜索",
  finance: "财经",
  video: "视频",
  social: "社交",
  ai: "AI",
  download: "下载",
  news: "资讯",
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

async function templateCommand<T = unknown>(name: CommandName, args: Record<string, unknown> = {}): Promise<T> {
  const request: PopupRequest = { kind: "template_command", name, args };
  const result = await chrome.runtime.sendMessage(request) as T & { __bpError?: string };
  if (result && result.__bpError) throw new Error(result.__bpError);
  return result;
}

function status(message: string, error = false): void {
  const el = $("template-status");
  el.textContent = message;
  el.style.color = error ? "#b91c1c" : "#4b5563";
}

function button(label: string, action: () => Promise<void>, className = ""): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  el.className = className;
  el.addEventListener("click", async () => {
    el.disabled = true;
    try { await action(); }
    catch (e) { status(e instanceof Error ? e.message : String(e), true); }
    finally { el.disabled = false; }
  });
  return el;
}

function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

function sourceLabel(item: TemplateListItem): string {
  if (item.builtin) return "随扩展发布";
  const source = item.source ?? {};
  if (source.type === "github") return "GitHub · " + source.repo + "/" + source.path + "@" + (source.ref ?? "main");
  if (source.type === "url") return String(source.url ?? "URL");
  return "本地安装";
}

// ---------- 看板状态 ----------

let items: TemplateListItem[] = [];
let updatesById = new Map<string, string>();
const activeTags = new Set<string>();
let query = "";
let pendingCandidates: UpdateCandidate[] = [];

function matchesQuery(item: TemplateListItem): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.id, item.name, item.description, item.category,
    ...(item.tags ?? []), ...(item.sites ?? []), ...(item.keywords ?? []), ...(item.intents ?? []),
  ].join(" ").toLowerCase();
  return q.split(/[\s,，/]+/).filter(Boolean).every((token) => haystack.includes(token));
}

function matchesTags(item: TemplateListItem): boolean {
  if (!activeTags.size) return true;
  return (item.tags ?? []).some((tag) => activeTags.has(tag));
}

function sortForDisplay(list: TemplateListItem[]): TemplateListItem[] {
  return [...list].sort((a, b) => {
    const aUpdate = updatesById.has(a.id) ? 0 : 1;
    const bUpdate = updatesById.has(b.id) ? 0 : 1;
    if (aUpdate !== bUpdate) return aUpdate - bUpdate;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function renderSummary(): void {
  const installed = items.filter((item) => !item.builtin).length;
  const shown = items.filter((item) => matchesQuery(item) && matchesTags(item)).length;
  $("template-summary").textContent =
    "共 " + items.length + " 个模板（随扩展发布 " + (items.length - installed) + "，GitHub 安装 " + installed + "）· 当前显示 " + shown;
}

function renderTagFilter(): void {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const root = $("tag-filter");
  const makeChip = (label: string, key: string | null): HTMLButtonElement => {
    const chip = document.createElement("button");
    chip.className = "chip" + ((key === null && !activeTags.size) || (key !== null && activeTags.has(key)) ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (key === null) activeTags.clear();
      else if (activeTags.has(key)) activeTags.delete(key);
      else activeTags.add(key);
      renderTagFilter();
      renderList();
      renderSummary();
    });
    return chip;
  };
  const chips: HTMLButtonElement[] = [makeChip("全部 " + items.length, null)];
  for (const tag of Object.keys(TAG_LABELS)) {
    chips.push(makeChip(tagLabel(tag) + " " + (counts.get(tag) ?? 0), tag));
  }
  root.replaceChildren(...chips);
}

function renderCard(item: TemplateListItem): HTMLElement {
  const card = document.createElement("section");
  card.className = "template-card";

  const head = document.createElement("div");
  head.className = "template-head";
  const title = document.createElement("div");
  title.className = "template-title";
  title.textContent = item.name || item.id;
  const badges = document.createElement("div");
  const version = document.createElement("span");
  version.className = "badge";
  version.textContent = "v" + (item.version ?? "0.0.0");
  badges.append(version);
  const remoteVersion = updatesById.get(item.id);
  if (remoteVersion) {
    const upd = document.createElement("span");
    upd.className = "badge update";
    upd.textContent = "可更新 → v" + remoteVersion;
    badges.append(upd);
  }
  const state = document.createElement("span");
  state.className = "badge " + (item.enabled === false ? "off" : "ok");
  state.textContent = item.enabled === false ? "已停用" : "已启用";
  badges.append(state);
  if (item.builtin) {
    const builtin = document.createElement("span");
    builtin.className = "badge";
    builtin.textContent = "随扩展发布";
    badges.append(builtin);
  } else if (item.overridesBuiltin) {
    const override = document.createElement("span");
    override.className = "badge";
    override.textContent = "GitHub 版本";
    badges.append(override);
  }
  head.append(title, badges);

  const tagRow = document.createElement("div");
  for (const tag of item.tags ?? []) {
    const badge = document.createElement("span");
    badge.className = "badge tag";
    badge.textContent = tagLabel(tag);
    tagRow.append(badge);
  }

  const description = document.createElement("div");
  description.textContent = item.description ?? "";
  const paramText = (item.inputs ?? []).map((x) => x.name + (x.required ? "(必填)" : "")).join(", ");
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = item.id + " · " + sourceLabel(item) +
    (item.sites?.length ? " · 站点：" + item.sites.join(", ") : "") +
    (paramText ? " · 参数：" + paramText : "") +
    (item.updatedAt ? " · 更新于 " + new Date(item.updatedAt).toLocaleString() : "");
  description.className = "template-desc";

  const actions = document.createElement("div");
  actions.className = "toolbar";
  actions.append(button("查看", async () => {
    const result = await templateCommand<{ markdown?: string; template?: unknown }>("get_template_detail", { id: item.id });
    const text = result.markdown ?? JSON.stringify(result.template, null, 2);
    const win = window.open("", "_blank");
    if (!win) throw new Error("浏览器阻止了详情窗口");
    const pre = win.document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.padding = "20px";
    pre.textContent = text;
    win.document.body.append(pre);
  }));

  if (item.installed === false) {
    actions.append(button("安装", async () => {
      if (item.source?.type !== "github") throw new Error("该搜索结果没有可安装的 GitHub 来源");
      await templateCommand("install_template", { source: item.source });
      status("模板已安装：" + item.id);
      await refreshTemplates();
    }, "primary"));
  } else {
    if (!item.builtin) {
      actions.append(button(item.enabled === false ? "启用" : "停用", async () => {
        await templateCommand("set_template_enabled", { id: item.id, enabled: item.enabled === false });
        status("模板状态已更新：" + item.id);
        await refreshTemplates();
      }));
      if (item.source?.type === "github" || item.source?.type === "url") {
        actions.append(button("检查更新", async () => {
          const result = await templateCommand<{ updateAvailable?: boolean; remoteVersion?: string }>("check_template_update", { id: item.id });
          status(result.updateAvailable ? "发现新版本：" + (result.remoteVersion ?? "内容已变化") : "已是最新版本：" + item.id);
        }));
        actions.append(button("升级", async () => {
          await templateCommand("update_template", { id: item.id });
          status("模板已升级：" + item.id);
          await refreshTemplates();
        }));
      }
      if (item.canRollback) {
        actions.append(button("回滚", async () => {
          await templateCommand("rollback_template", { id: item.id });
          status("模板已回滚：" + item.id);
          await refreshTemplates();
        }));
      }
      actions.append(button("卸载", async () => {
        if (!confirm("确定卸载模板 “" + item.name + "” 吗？" + (item.overridesBuiltin ? "（将恢复随扩展发布的版本）" : ""))) return;
        await templateCommand("uninstall_template", { id: item.id });
        status("模板已卸载：" + item.id);
        await refreshTemplates();
      }, "danger"));
    } else if (updatesById.has(item.id)) {
      const candidate = pendingCandidates.find((x) => x.id === item.id);
      if (candidate) {
        actions.append(button("安装新版本", async () => {
          await templateCommand("install_template", { source: candidate.source });
          status("已安装 GitHub 新版本：" + item.id);
          updatesById.delete(item.id);
          await refreshTemplates();
        }, "primary"));
      }
    }
  }

  card.append(head, tagRow, description, meta, actions);
  return card;
}

function renderList(): void {
  const visible = sortForDisplay(items.filter((item) => matchesQuery(item) && matchesTags(item)));
  $("template-list").replaceChildren(...visible.map(renderCard));
}

function renderUpdatesPanel(result: RegistryUpdateResult): void {
  const panel = $("updates-panel");
  const list = $("updates-list");
  pendingCandidates = [];
  const rows: HTMLElement[] = [];

  const addRow = (candidate: UpdateCandidate, kind: "update" | "added"): void => {
    pendingCandidates.push(candidate);
    const row = document.createElement("label");
    row.className = "update-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.id = candidate.id;
    const text = document.createElement("span");
    const tags = (candidate.tags ?? []).map(tagLabel).join("/");
    text.textContent = candidate.name + "（" + candidate.id + "）" +
      (kind === "update" ? " " + candidate.localVersion + " → " + candidate.remoteVersion : " 新模板 v" + candidate.remoteVersion) +
      (tags ? " · " + tags : "");
    row.append(checkbox, text);
    rows.push(row);
  };

  for (const candidate of result.updates) addRow(candidate, "update");
  for (const candidate of result.added) addRow(candidate, "added");
  list.replaceChildren(...rows);
  panel.hidden = rows.length === 0;
  $("updates-title").textContent = "可用更新：" + result.counts.updates + " 个升级，" + result.counts.added + " 个新模板" +
    "（目录同步于 " + new Date(result.registry.syncedAt).toLocaleString() + "）";
  status(rows.length ? "发现可用更新，请勾选后安装。" : "已是最新：没有可更新或新增的模板。");
}

async function checkUpdates(): Promise<void> {
  const result = await templateCommand<RegistryUpdateResult>("check_registry_updates", { refresh: true });
  updatesById = new Map();
  for (const candidate of result.updates) if (candidate.remoteVersion) updatesById.set(candidate.id, candidate.remoteVersion);
  renderUpdatesPanel(result);
  renderList();
  renderSummary();
}

async function refreshTemplates(): Promise<void> {
  items = await templateCommand<TemplateListItem[]>("list_templates");
  renderTagFilter();
  renderList();
  renderSummary();
}

// ---------- 事件绑定 ----------

$<HTMLInputElement>("template-search").addEventListener("input", (event) => {
  query = (event.currentTarget as HTMLInputElement).value;
  renderList();
  renderSummary();
});

$("check-updates").addEventListener("click", async () => {
  try { await checkUpdates(); }
  catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$("install-selected").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll<HTMLInputElement>("#updates-list input[type=checkbox]")]
    .filter((el) => el.checked)
    .map((el) => el.dataset.id ?? "")
    .filter(Boolean);
  if (!checked.length) return status("没有勾选任何模板", true);
  let done = 0;
  for (const id of checked) {
    const candidate = pendingCandidates.find((x) => x.id === id);
    if (!candidate?.source) continue;
    try {
      await templateCommand("install_template", { source: candidate.source });
      done++;
    } catch (e) {
      status("安装失败 " + id + "：" + (e instanceof Error ? e.message : String(e)), true);
    }
  }
  status("已安装/升级 " + done + " 个模板");
  updatesById.clear();
  $("updates-panel").hidden = true;
  await refreshTemplates();
});

$("close-updates").addEventListener("click", () => {
  $("updates-panel").hidden = true;
});

$("install-content").addEventListener("click", async () => {
  const content = ($<HTMLTextAreaElement>("template-content")).value.trim();
  if (!content) return status("请先粘贴模板内容", true);
  try {
    await templateCommand("install_template", { content });
    status("本地模板安装成功");
    await refreshTemplates();
  } catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$("install-github").addEventListener("click", async () => {
  const repo = $<HTMLInputElement>("github-repo").value.trim();
  const filePath = $<HTMLInputElement>("github-path").value.trim();
  const ref = $<HTMLInputElement>("github-ref").value.trim() || "main";
  if (!repo || !filePath) return status("请填写 owner/repo 和模板路径", true);
  try {
    await templateCommand("install_template", { source: { type: "github", repo, path: filePath, ref } });
    status("GitHub 模板安装成功");
    await refreshTemplates();
  } catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$("load-catalog").addEventListener("click", async () => {
  const repo = $<HTMLInputElement>("github-repo").value.trim();
  const ref = $<HTMLInputElement>("github-ref").value.trim() || "main";
  if (!repo) return status("请填写 owner/repo", true);
  try {
    const result = await templateCommand<{ templates: Array<{ id: string; name: string; version: string; path: string }> }>("list_template_catalog", { repo, ref });
    const select = $<HTMLSelectElement>("catalog-template");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择仓库模板（" + result.templates.length + "）";
    const options = result.templates.map((item) => {
      const option = document.createElement("option");
      option.value = item.path;
      option.textContent = item.name + " · v" + item.version + " · " + item.id;
      return option;
    });
    select.replaceChildren(placeholder, ...options);
    status("已读取仓库模板目录");
  } catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$<HTMLSelectElement>("catalog-template").addEventListener("change", (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (value) $<HTMLInputElement>("github-path").value = value;
});

chrome.runtime.sendMessage({ kind: "get_status" }).catch(() => {});
void refreshTemplates().catch((e) => status(e instanceof Error ? e.message : String(e), true));
