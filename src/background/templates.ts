// M9 插件化操作模版：import_template / list_templates / export_template / run_template + failback。
// 设计对齐功能文档 §4.9（F8-1~F8-5）与技术路径 §4.11：
//   - 模版 = 编排描述（命令序列 | 脚本 | 提示词），附元信息 + 省token策略 + 适用范围；
//   - run_template 把 params 代入 → 命令序列逐条走 commands.ts 分派（此处经 setCommandRunner 注入 dispatch）；
//   - failback：任一步失败 → 返回结构化失败上下文（快照 + 出错命令 + 错误）+ 发 template_failed 事件。
import type { Command } from "../shared/types";
import {
  Template,
  TemplateStep,
  validateTemplate,
  TAB_SCOPED,
} from "../shared/template-schema";
import { pushEvent } from "./native-bridge";
import { getL0Snapshot } from "./content-bridge";
import { sleep } from "./cdp";

// ---------------------------------------------------------------------------
// 模版载体之「命令序列」的求值表达式构建（内联进 js 步骤，esbuild 会原样打包）。
// ---------------------------------------------------------------------------

/** 等待页面出现一个「可见的文本输入区」，聚焦并打上 data-ego-focus 标（供 fill 命中）。 */
function focusBestExpr(cands: string[]): string {
  const list = JSON.stringify(cands);
  return (
    "(async()=>{const cands=" + list +
    ";const start=Date.now();while(Date.now()-start<25000){" +
    "let el=null;for(const s of cands){const c=document.querySelector(s);if(c&&c.offsetParent!==null){el=c;break;}}" +
    "if(!el){const all=document.querySelectorAll('input[type=text],input[type=search],textarea,[contenteditable=true]');" +
    "for(const c of all){if(c.offsetParent!==null){el=c;break;}}}" +
    "if(el){el.focus();el.setAttribute('data-ego-focus','1');return true;}" +
    "await new Promise(r=>setTimeout(r,400));}return false;})()"
  );
}

/** 抓取 Google 搜索结果：等待结果容器内出现 ≥3 条真实结果链接后，取前 10 条（标题 + 链接 + 正文摘要）。 */
function googleResultsExpr(): string {
  return (
    "(async()=>{const start=Date.now();" +
    "const hasResults=()=>{const s=document.querySelector('#search')||document.querySelector('#rso')||document.querySelector('#center_col');" +
    "if(!s)return false;const as=s.querySelectorAll('a');let n=0;for(const a of as){const h=a.getAttribute('href')||'';" +
    "if(h.startsWith('http')||h.startsWith('/url?q=')){if((a.innerText||'').trim().length>2)n++;}}return n>=3;};" +
    "while(Date.now()-start<12000){if(hasResults())break;await new Promise(r=>setTimeout(r,400));}" +
    "const root=document.querySelector('#search')||document.querySelector('#rso')||document.querySelector('#center_col')||document.body;" +
    "const links=[];const seen=new Set();" +
    "for(const a of root.querySelectorAll('a')){const href=a.getAttribute('href')||'';let u=href;" +
    "if(href.startsWith('/url?q=')){try{u=decodeURIComponent(href.split('/url?q=')[1].split('&')[0]);}catch{}}" +
    "const t=(a.innerText||'').trim();" +
    "if(u&&t&&t.length>2&&(u.startsWith('http')||href.startsWith('/url'))){" +
    "const key=u;if(!seen.has(key)){seen.add(key);links.push({title:t.slice(0,150),url:u});}" +
    "if(links.length>=10)break;}}" +
    "const text=(root.innerText||'').slice(0,6000).trim();" +
    "return {count:links.length,links,text};})()"
  );
}

/** AI 聊天模版的写步骤：先把 prompt 写进富文本编辑器（Gemini=Quill API、ChatGPT=ProseMirror 经 execCommand），
 *  同时**记录回复基线**（发送前已存在的 AI 回复容器数）到 window.__egoAiBase，供 @chatCollect 判断「真正新增的回复」，
 *  避免复用长会话时把上一条旧回复当成本次回复。 */
function aiWriteExpr(mode: string, prompt: string): string {
  const p = JSON.stringify(prompt);
  // 回复容器基线：gemini 用 .markdown（实测=每条助手回复，`.model-response` 类时有时无、不可靠），chatgpt 用 [data-message-author-role=assistant]
  const baseSel = mode === "gemini" ? ".markdown" : "div[data-message-author-role='assistant']";
  const b = JSON.stringify(baseSel);
  const core = mode === "gemini" ? geminiQuillCore() : chatgptProseCore();
  return "(async()=>{const text=" + p + ";window.__egoAiBase=document.querySelectorAll(" + b + ").length;" + core + "})()";
}

/** Gemini 的 Quill 写入主体（引用变量 text）。关键：Input.insertText 只改 DOM、不进 Delta 模型，
 *  必须 q.setText(text,'user')（source='user' 触发 Gemini 的 text-change，点亮发送按钮）。
 *  写完后轮询等待发送按钮就绪，避免紧接的 click 因按钮未渲染而定位失败。 */
function geminiQuillCore(): string {
  return (
    "const rt=document.querySelector('rich-textarea')||document.querySelector('.ql-editor')||document.querySelector('[contenteditable=true]');" +
    "let q=rt&&rt.__quill;" +
    "if(!q&&document.querySelector('.ql-container'))q=document.querySelector('.ql-container').__quill;" +
    "if(!q&&rt){let e=rt;for(let i=0;i<4&&e&&!q;i++){e=e.parentElement;if(e&&e.__quill)q=e.__quill;}}" +
    "if(q&&typeof q.setText==='function'){const ed=document.querySelector('.ql-editor')||rt;if(ed)ed.focus();q.setText(text,'user');" +
    "let ok=false;for(let i=0;i<30;i++){const b=document.querySelector(\"button[aria-label='Send message']\");if(b&&!b.disabled){ok=true;break;}await new Promise(r=>setTimeout(r,250));}" +
    "return {ok:true,method:'quill',base:window.__egoAiBase,len:q.getLength(),sendReady:ok};}" +
    "if(rt){rt.focus();const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(rt);sel.removeAllRanges();sel.addRange(r);document.execCommand('delete');" +
    "try{document.execCommand('insertText',false,text);}catch{}" +
    "let ok=false;for(let i=0;i<30;i++){const b=document.querySelector(\"button[aria-label='Send message']\");if(b&&!b.disabled){ok=true;break;}await new Promise(r=>setTimeout(r,250));}" +
    "return {ok:true,method:'dom',base:window.__egoAiBase,sendReady:ok};}" +
    "return {ok:false,base:window.__egoAiBase};"
  );
}

/** ChatGPT 的 ProseMirror 写入主体（引用变量 text）。ProseMirror 监听 beforeinput/input，execCommand('insertText')
 *  会触发它把文本写进编辑器 state（实测 innerText 生效、发送按钮点亮）。
 *  写完后轮询等待发送按钮就绪，避免紧接的 click 因按钮未渲染而定位失败。 */
function chatgptProseCore(): string {
  return (
    "const pm=document.querySelector('.ProseMirror[contenteditable=\"true\"]')||document.querySelector('#prompt-textarea .ProseMirror')||document.querySelector('[contenteditable=\"true\"]');" +
    "if(!pm)return {ok:false,base:window.__egoAiBase};" +
    "pm.focus();const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(pm);sel.removeAllRanges();sel.addRange(r);document.execCommand('delete');" +
    "let ins=false;try{ins=document.execCommand('insertText',false,text);}catch(e){}" +
    "let ok=false;for(let i=0;i<30;i++){const b=document.querySelector(\"button[data-testid='send-button']\");if(b&&!b.disabled){ok=true;break;}await new Promise(r=>setTimeout(r,250));}" +
    "return {ok:ins,method:'prosemirror',base:window.__egoAiBase,sendReady:ok};"
  );
}

/** AI 聊天模版的回复回收：只回收「基线之后新增」的最后一条 AI 回复，**等它完全说完/生成完**才返回。
 *  「完整」判定 = 文本长度 + 图片集合都不再变化并稳定约 5s（避免中途截断，也能覆盖「出图/生成中」）。
 *  gemini：直接取最后一个 .markdown（实测=每条助手回复，天然去掉「Gemini said」/Flash/免责宣传）。
 *  chatgpt：容器 [data-message-author-role=assistant] 内取 .markdown（去掉「ChatGPT 也可能会犯错」等尾部）。
 *  返回：text + images（回复容器里出现的图片 src，data:/http:，去重）。 */
function aiCollectExpr(mode: string): string {
  const baseSel = mode === "gemini" ? ".markdown" : "div[data-message-author-role='assistant']";
  const b = JSON.stringify(baseSel);
  const strip = mode === "gemini"
    ? ["Flash", "Gemini is AI", "Dictate", "Copy", "Listen", "Retry", "Show drafts"]
    : ["ChatGPT 也可能会犯错", "ChatGPT can make mistakes", "思考"];
  const S = JSON.stringify(strip);
  const PFX = JSON.stringify(["Gemini said", "ChatGPT said", "You said"]);
  return (
    "(async()=>{const base=window.__egoAiBase||0;const baseSel=" + b + ";const ST=" + S + ";const PFX=" + PFX + ";" +
    "const start=Date.now();const timeout=90000;let last='';let lastImgs=[];let prevSig='';let stable=0;" +
    "while(Date.now()-start<timeout){" +
    "const els=document.querySelectorAll(baseSel);" +
    "if(els.length>base){const el=els[els.length-1];const md=el.querySelector('.markdown')||el;" +
    "let rep=(md.innerText||'');" +
    "for(const pf of PFX){if(rep.startsWith(pf))rep=rep.slice(pf.length);}" +
    "for(const s of ST){const i=rep.indexOf(s);if(i>=0)rep=rep.slice(0,i);}" +
    "rep=rep.trim();" +
    "const imgs=[];const seen=new Set();const im=md.querySelectorAll('img');" +
    "for(let k=0;k<im.length;k++){let src=(im[k].currentSrc||im[k].src||'');if(!src)continue;if(!seen.has(src)){seen.add(src);imgs.push(src);}}" +
    "if(rep.length>2||imgs.length>0){last=rep;lastImgs=imgs;" +
    "const sig=rep.length+':'+imgs.join('|');" +
    "if(sig===prevSig){stable+=700;}else{prevSig=sig;stable=0;}if(stable>=5000)break;}}" +
    "await new Promise(r=>setTimeout(r,700));}" +
    "return {text:last.slice(0,8000),images:lastImgs,url:location.href,title:document.title};})()"
  );
}

/** 等待回复文本「流式结束」：以提交后渲染完成为基线，仅把基线之后的增长当回复流；
 *  增长后需稳定 ~6s 判定结束（避免在模型"思考"间隙过早返回）。respSel 为空则取整页文本。 */
function collectFeedbackExpr(respSel: string): string {
  const sel = respSel ? JSON.stringify(respSel) : "null";
  return (
    "(async()=>{const respSel=" + sel + ";const start=Date.now();const timeout=60000;" +
    "const el=()=>respSel?document.querySelector(respSel):document.body;" +
    "const txt=()=>{const e=el();return e&&e.innerText?(e.innerText.trim()):'';};" +
    "let baseline=txt().length;let lastLen=baseline,stable=0,grew=false,text='';" +
    "while(Date.now()-start<timeout){text=txt();" +
    "if(text.length>lastLen){grew=true;lastLen=text.length;stable=0;}else stable+=500;" +
    "if(grew&&stable>=6000)break;await new Promise(r=>setTimeout(r,500));}" +
    "return {text:text.slice(0,20000),url:location.href,title:document.title};})()"
  );
}

// ---------------------------------------------------------------------------
// 内置模版
// ---------------------------------------------------------------------------

const GOOGLE_CANDS = ["textarea[name='q']", "input[name='q']", "input[type='search']", "input[type='text']"];
const AI_CANDS = ["div[role='textbox']", "[contenteditable='true']", "textarea", "input[type='text']"];

function builtinTemplates(): Template[] {
  return [
    {
      id: "search",
      name: "谷歌搜索",
      category: "search",
      description: "在 Google 搜索一个关键词，取回前 10 条结果（标题 + 链接 + 正文摘要）。",
      inputs: [{ name: "query", type: "string", required: true, description: "搜索关键词" }],
      steps: "commands",
      body: [
        { name: "open_tab", args: { url: "https://www.google.com" }, note: "打开 Google 首页" },
        { name: "js", args: { expression: "@focus" }, expect: "true", note: "等待并聚焦搜索框" },
        { name: "fill", args: { selector: "[data-ego-focus]", value: "$query" }, note: "填入关键词" },
        { name: "press", args: { key: "Enter" }, note: "提交搜索" },
        { name: "waitForURL", args: { pattern: "google.com/search", partial: true, timeoutMs: 20000 }, note: "等待结果页加载" },
        { name: "js", args: { expression: "@results" }, note: "抓取搜索结果" },
      ],
      tokenStrategy: { defaultL0: true },
    },
    {
      id: "gemini-ask",
      name: "Gemini 提问",
      category: "ai-chat",
      description: "向 gemini.google.com/app 提问，等待回复流式结束并回收反馈文本。",
      inputs: [
        { name: "prompt", type: "string", required: true, description: "要问的问题" },
        { name: "tabId", type: "number", required: false, description: "已打开的 Gemini 标签；提供则复用，不再新开" },
        { name: "responseSelector", type: "string", required: false, default: "", description: "回复容器 CSS 选择器；留空则取整页文本" },
      ],
      steps: "commands",
      body: [
        { name: "open_tab", args: { url: "https://gemini.google.com/app" }, skipWhenParam: "tabId", note: "打开 Gemini" },
        { name: "switch_tab", args: {}, note: "激活 Gemini 标签（后台标签不渲染回复，需前台）" },
        { name: "js", args: { expression: "@write", mode: "gemini" }, note: "写入问题并记录回复基线（Quill API）" },
        { name: "click", args: { selector: "button[aria-label='Send message']" }, note: "点击发送按钮" },
        { name: "js", args: { expression: "@chatCollect", mode: "gemini" }, note: "回收回复文本（取基线后新增的最后一条回复）" },
      ],
      tokenStrategy: { defaultL0: true },
    },
    {
      id: "chatgpt-ask",
      name: "ChatGPT 提问",
      category: "ai-chat",
      description: "向 chatgpt.com 提问，等待回复流式结束并回收反馈文本。",
      inputs: [
        { name: "prompt", type: "string", required: true, description: "要问的问题" },
        { name: "tabId", type: "number", required: false, description: "已打开的 ChatGPT 标签；提供则复用，不再新开" },
        { name: "responseSelector", type: "string", required: false, default: "", description: "回复容器 CSS 选择器；留空则取整页文本" },
      ],
      steps: "commands",
      body: [
        { name: "open_tab", args: { url: "https://chatgpt.com/" }, skipWhenParam: "tabId", note: "打开 ChatGPT" },
        { name: "switch_tab", args: {}, note: "激活 ChatGPT 标签（后台标签不渲染回复，需前台）" },
        { name: "js", args: { expression: "@write", mode: "chatgpt" }, note: "写入问题并记录回复基线（ProseMirror）" },
        { name: "click", args: { selector: "button[data-testid='send-button']" }, note: "点击发送按钮" },
        { name: "js", args: { expression: "@chatCollect", mode: "chatgpt" }, note: "回收回复文本" },
      ],
      tokenStrategy: { defaultL0: true },
    },
  ];
}

// 内置模版 registry（id → Template）
const BUILTINS: Record<string, Template> = Object.fromEntries(builtinTemplates().map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// 导入 / 导出 / 清单
// ---------------------------------------------------------------------------

const STORE_KEY = "egolite.templates.v1";

async function loadImported(): Promise<Record<string, Template>> {
  const raw = await chrome.storage.local.get(STORE_KEY);
  return (raw[STORE_KEY] as Record<string, Template>) ?? {};
}

async function saveImported(map: Record<string, Template>): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: map });
}

export function resolveTemplateById(id: string): Template | undefined {
  return BUILTINS[id] ?? undefined;
}

export async function listTemplates(): Promise<unknown[]> {
  const map = { ...BUILTINS, ...(await loadImported()) };
  return Object.values(map).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    inputs: t.inputs,
    steps: t.steps,
    scope: t.scope,
  }));
}

function toMarkdown(t: Template): string {
  const lines: string[] = [];
  lines.push("# " + t.name + " (`" + t.id + "`)");
  lines.push("");
  lines.push("> " + (t.description ?? ""));
  lines.push("");
  lines.push("- 分类：" + t.category);
  lines.push("- 载体类型：" + t.steps);
  if (t.inputs.length) {
    lines.push("- 输入参数：");
    for (const i of t.inputs) {
      lines.push("  - `" + i.name + "`（" + i.type + (i.required ? ", 必填" : ", 可选") + "）：" + (i.description ?? ""));
    }
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(t, null, 2));
  lines.push("```");
  return lines.join("\n");
}

export async function importTemplate(cmd: Command): Promise<unknown> {
  const args = (cmd.args ?? {}) as { id?: string; content?: string };
  if (args.id) {
    const t = resolveTemplateById(args.id);
    if (!t) throw new Error("未找到要导入的模版: " + args.id);
    return { imported: true, id: t.id, builtin: true, name: t.name };
  }
  if (typeof args.content === "string" && args.content.trim()) {
    const t = parseTemplateContent(args.content);
    const imported = await loadImported();
    imported[t.id] = t;
    await saveImported(imported);
    return { imported: true, id: t.id, builtin: false, name: t.name };
  }
  throw new Error("import_template 需要 id 或 content");
}

function parseTemplateContent(content: string): Template {
  const trimmed = content.trim();
  let jsonText = trimmed;
  const fence = /```json\s+([\s\S]*?)```/i.exec(trimmed);
  if (fence && fence[1]) jsonText = fence[1];
  if (trimmed.startsWith("{")) {
    // 直接是 JSON 对象
  } else if (fence && fence[1]) {
    // 已提取
  } else {
    throw new Error("无法解析模版内容（需 JSON 或 markdown 内嵌 ```json 块）");
  }
  const obj = JSON.parse(jsonText);
  return validateTemplate(obj);
}

export async function exportTemplate(cmd: Command): Promise<unknown> {
  const args = (cmd.args ?? {}) as { id?: string; as?: string };
  const id = String(args.id ?? "");
  const t = resolveTemplateById(id);
  if (!t) throw new Error("未找到要导出的模版: " + id);
  const asMd = String(args.as ?? "md") === "md";
  return { id: t.id, name: t.name, template: t, markdown: toMarkdown(t) };
}

// ---------------------------------------------------------------------------
// run_template
// ---------------------------------------------------------------------------

let runner: ((cmd: Command) => Promise<unknown>) | null = null;
/** 由 commands.ts 在模块加载时注入 dispatch，避免循环依赖（templates.ts 不 import commands.ts）。 */
export function setCommandRunner(fn: (cmd: Command) => Promise<unknown>): void {
  runner = fn;
}
function runOne(cmd: Command): Promise<unknown> {
  if (!runner) throw new Error("命令调度器未初始化");
  return runner(cmd);
}

function substValue(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}|\$([A-Za-z0-9_]+)/g, (m, a, b) => {
      const name = a || b;
      const v = params[name];
      return v === undefined || v === null ? m : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((x) => substValue(x, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substValue(v, params);
    return out;
  }
  return value;
}

function buildParams(tpl: Template, given: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const inp of tpl.inputs) {
    params[inp.name] = given[inp.name] !== undefined ? given[inp.name] : inp.default;
  }
  for (const k of Object.keys(given)) if (!(k in params)) params[k] = given[k];
  for (const inp of tpl.inputs) {
    const v = params[inp.name];
    if (inp.required && (v === undefined || v === null || v === "")) {
      throw new Error("缺少必填参数: " + inp.name);
    }
  }
  return params;
}

async function runStepWithRetry(step: TemplateStep, stepCmd: Command): Promise<unknown> {
  const retry = step.retry ?? 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await runOne(stepCmd);
      if (step.expect) {
        const s = JSON.stringify(res ?? {});
        if (!s.includes(step.expect)) throw new Error("expect 未命中: " + step.expect);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retry) await sleep(1200);
    }
  }
  throw lastErr;
}

async function buildFailback(
  tpl: Template,
  step: TemplateStep,
  err: unknown,
  tabId: number | undefined
): Promise<Error> {
  const error = err instanceof Error ? err.message : String(err);
  let snapshot = "";
  if (tabId !== undefined) {
    try {
      const s = await getL0Snapshot(tabId);
      snapshot = (s.content || "").slice(0, 2000);
    } catch {
      /* 快照失败不影响 failback 上报 */
    }
  }
  pushEvent("template_failed", { id: tpl.id, step: step.name, step_note: step.note ?? "", error });
  const payload = JSON.stringify({
    template_failed: true,
    id: tpl.id,
    step: step.name,
    step_note: step.note ?? "",
    error,
    snapshot_content: snapshot,
    hint: "模版失灵：以上是现场快照与出错步骤。外部 AI 可据此重写为_新 id 的模版并 import_template 后再次运行（failback）。",
  });
  return new Error(payload);
}

export async function runTemplate(cmd: Command): Promise<unknown> {
  const args = (cmd.args ?? {}) as { id?: string; params?: Record<string, unknown>; tabId?: number };
  const id = String(args.id ?? "");
  const given = (args.params ?? {}) as Record<string, unknown>;
  const baseTab = typeof args.tabId === "number" ? Number(args.tabId) : undefined;
  const tpl = resolveTemplateById(id);
  if (!tpl) throw new Error("未找到模版: " + id);

  if (tpl.steps === "prompt") {
    const params = buildParams(tpl, given);
    const text = String(tpl.body).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}|\$([A-Za-z0-9_]+)/g, (m, a, b) => {
      const v = params[a || b];
      return v === undefined || v === null ? m : String(v);
    });
    return { kind: "prompt", prompt: text };
  }
  if (tpl.steps === "script") {
    throw new Error("脚本模版在 v2 执行（run_script）");
  }

  const steps = tpl.body as TemplateStep[];
  const params = buildParams(tpl, given);
  // 顶层 tabId（run_template 的 args.tabId）并入 params，让 skipWhenParam:tabId 与后续 TAB_SCOPED 注入生效
  if (params.tabId == null && typeof baseTab === "number") params.tabId = baseTab;
  let currentTab: number | undefined =
    typeof params.tabId === "number" && Number.isFinite(params.tabId) ? Number(params.tabId) : baseTab;

  let lastResult: unknown = undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.skipWhenParam && params[step.skipWhenParam]) continue;

    const stepArgs = substValue(step.args ?? {}, params) as Record<string, unknown>;
    // @collect：整段表达式替换为 collectFeedbackExpr(运行时 responseSelector)
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@collect") {
      const rs = String(stepArgs.responseSelector ?? params.responseSelector ?? "");
      stepArgs.expression = collectFeedbackExpr(rs);
    }
    // @focus：搜索框聚焦表达式；@results：搜索结果抓取表达式
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@focus") {
      stepArgs.expression = focusBestExpr(GOOGLE_CANDS);
    }
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@results") {
      stepArgs.expression = googleResultsExpr();
    }
    // @write：把 $prompt 安全写入富文本编辑器（mode 决定 Gemini-Quill / ChatGPT-ProseMirror），并记录回复基线
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@write") {
      stepArgs.expression = aiWriteExpr(String(stepArgs.mode ?? params.mode ?? "gemini"), String(params.prompt ?? ""));
    }
    // @chatCollect：AI 聊天回复回收（只取基线后新增的最后一条回复）
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@chatCollect") {
      stepArgs.expression = aiCollectExpr(String(stepArgs.mode ?? params.mode ?? "gemini"));
    }
    if (TAB_SCOPED.has(step.name) && currentTab !== undefined && stepArgs.tabId === undefined) {
      stepArgs.tabId = currentTab;
    }
    const stepCmd: Command = {
      type: "command",
      name: step.name,
      args: stepArgs,
      requestId: cmd.requestId + ":" + i,
      space: cmd.space,
    };
    try {
      lastResult = await runStepWithRetry(step, stepCmd);
    } catch (e) {
      const fbTab = currentTab ?? baseTab ?? (typeof params.tabId === "number" ? Number(params.tabId) : undefined);
      throw await buildFailback(tpl, step, e, fbTab);
    }
    if (step.name === "open_tab" && lastResult && typeof (lastResult as { tabId?: unknown }).tabId === "number") {
      currentTab = (lastResult as { tabId: number }).tabId;
    }
  }
  return lastResult;
}
