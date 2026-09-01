import type { CommandName, PopupRequest } from "../shared/types";

interface TemplateListItem {
  id: string;
  name: string;
  version?: string;
  description?: string;
  category?: string;
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
}

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

function sourceLabel(item: TemplateListItem): string {
  if (item.builtin) return "随扩展发布";
  const source = item.source ?? {};
  if (source.type === "github") return "GitHub · " + source.repo + "/" + source.path + "@" + (source.ref ?? "main");
  if (source.type === "url") return String(source.url ?? "URL");
  return "本地安装";
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
  const state = document.createElement("span");
  state.className = "badge " + (item.enabled === false ? "off" : "ok");
  state.textContent = item.enabled === false ? "已停用" : "已启用";
  badges.append(state);
  if (item.builtin) {
    const builtin = document.createElement("span");
    builtin.className = "badge";
    builtin.textContent = "内置";
    badges.append(builtin);
  }
  head.append(title, badges);

  const description = document.createElement("div");
  description.textContent = item.description ?? "";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = item.id + " · " + sourceLabel(item) +
    (item.updatedAt ? " · 更新于 " + new Date(item.updatedAt).toLocaleString() : "") +
    (item.capabilities?.length ? " · 能力：" + item.capabilities.join(", ") : "");

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
  } else if (!item.builtin) {
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
      if (!confirm("确定卸载模板 “" + item.name + "” 吗？")) return;
      await templateCommand("uninstall_template", { id: item.id });
      status("模板已卸载：" + item.id);
      await refreshTemplates();
    }, "danger"));
  }

  card.append(head, description, meta, actions);
  return card;
}

async function refreshTemplates(): Promise<void> {
  const list = await templateCommand<TemplateListItem[]>("list_templates");
  const root = $("template-list");
  root.replaceChildren(...list.map((item) => renderCard({ ...item, installed: true })));
  const installed = list.filter((item) => !item.builtin).length;
  $("template-summary").textContent = list.length + " 个模板（内置 " + (list.length - installed) + "，已安装 " + installed + "）";
}

async function searchRegistry(refresh = false): Promise<void> {
  const query = $<HTMLInputElement>("template-search").value.trim();
  const result = await templateCommand<{ templates: TemplateListItem[]; registry: { syncedAt: number } }>("search_templates", { query, refresh });
  $("registry-results").replaceChildren(...result.templates.map(renderCard));
  status("找到 " + result.templates.length + " 个候选模板；目录同步于 " + new Date(result.registry.syncedAt).toLocaleString());
}

$("search-registry").addEventListener("click", async () => {
  try { await searchRegistry(false); } catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$("sync-registry").addEventListener("click", async () => {
  try { await templateCommand("sync_registry"); await searchRegistry(false); }
  catch (e) { status(e instanceof Error ? e.message : String(e), true); }
});

$<HTMLInputElement>("template-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void searchRegistry(false).catch((e) => status(e instanceof Error ? e.message : String(e), true));
});

$("refresh-templates").addEventListener("click", async () => {
  try { await refreshTemplates(); status("模板列表已刷新"); }
  catch (e) { status(e instanceof Error ? e.message : String(e), true); }
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
