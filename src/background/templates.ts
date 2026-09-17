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
  checkStepExpect,
  TAB_SCOPED,
} from "../shared/template-schema";
import { pushEvent } from "./native-bridge";
import { getL0Snapshot } from "./content-bridge";
import { loadBundledTemplates } from "./bundled";
import { sleep } from "./cdp";

// ---------------------------------------------------------------------------
// 模版载体之「命令序列」的求值表达式构建（内联进 js 步骤，esbuild 会原样打包）。
// ---------------------------------------------------------------------------

/** 等待页面出现一个「可见的文本输入区」，聚焦并打上 data-bp-focus 标（供 fill 命中）。 */
function focusBestExpr(cands: string[]): string {
  const list = JSON.stringify(cands);
  return (
    "(async()=>{const cands=" + list +
    ";const start=Date.now();while(Date.now()-start<25000){" +
    "let el=null;for(const s of cands){const c=document.querySelector(s);if(c&&c.offsetParent!==null){el=c;break;}}" +
    "if(!el){const all=document.querySelectorAll('input[type=text],input[type=search],textarea,[contenteditable=true]');" +
    "for(const c of all){if(c.offsetParent!==null){el=c;break;}}}" +
    "if(el){el.focus();el.setAttribute('data-bp-focus','1');return true;}" +
    "await new Promise(r=>setTimeout(r,400));}return false;})()"
  );
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.map((x) => String(x)).filter(Boolean).slice(0, 30)
    : fallback;
}

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** 通用搜索结果抓取：站点差异由模板 args 声明，新增搜索引擎不需要改代码/重编译。
 *  excludeUrlPrefixes：模板声明的前缀排除（Google 搜索包用它剔除“翻译此页”等 UI 链接；
 *  不做全局内置——finance 等模板本来就要抓 /finance/quote 前缀的链接）。
 *  limit：目标结果条数（1..100，默认 10）。模板声明同名 input 即可由调用方指定。
 *  自动翻页：模板声明 nextSelector（下一页链接选择器，可选 nextText 文本过滤）后，当结果不足 limit
 *  时按 maxPages（默认按 limit/pageSize 估算，封顶 5；显式上限 10）在同页上下文顺序 fetch 后续页
 *  （credentials:include 复用登录态），合并去重；每页之间强制 pageDelayMs（默认 1500ms + 随机抖动）
 *  的礼貌间隔，任一页失败/无下一页/页数到顶即停，避免高频抓取触发风控。 */
function searchResultsExpr(options: {
  rootSelectors: string[];
  linkSelector?: string;
  minResults?: number;
  limit?: number;
  textLimit?: number;
  excludeUrlPrefixes?: string[];
  nextSelector?: string;
  nextText?: string;
  maxPages?: number;
  pageSize?: number;
  pageDelayMs?: number;
}): string {
  const roots = JSON.stringify(options.rootSelectors);
  const linkSelector = JSON.stringify(options.linkSelector || "a");
  const minResults = numberOption(options.minResults, 3, 1, 50);
  const limit = numberOption(options.limit, 10, 1, 100);
  const textLimit = numberOption(options.textLimit, 6000, 500, 50000);
  const pageSize = numberOption(options.pageSize, 10, 1, 50);
  const defaultMaxPages = Math.max(1, Math.min(Math.ceil(limit / pageSize), 5));
  const maxPages = numberOption(options.maxPages, defaultMaxPages, 1, 10);
  const pageDelayMs = numberOption(options.pageDelayMs, 1500, 500, 10000);
  const nextSelector = options.nextSelector ? JSON.stringify(options.nextSelector) : "null";
  const nextText = options.nextText ? JSON.stringify(options.nextText) : "null";
  const excluded = JSON.stringify((options.excludeUrlPrefixes ?? []).filter(Boolean));
  return (
    "(async()=>{const roots=" + roots + ";const linkSel=" + linkSelector + ";const min=" + minResults + ";const limit=" + limit + ";const textLimit=" + textLimit + ";const excluded=" + excluded + ";" +
    "const nextSel=" + nextSelector + ";const nextText=" + nextText + ";const maxPages=" + maxPages + ";const pageDelay=" + pageDelayMs + ";" +
    "const skip=(u)=>excluded.some(p=>u.indexOf(p)===0);" +
    "const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));" +
    "const pickRoot=(doc)=>{for(const s of roots){const el=doc.querySelector(s);if(el)return el;}return doc.body||doc.documentElement;};" +
    "const normalize=(href,base)=>{let u=href||'';if(u.startsWith('/url?q=')){try{u=decodeURIComponent(u.split('/url?q=')[1].split('&')[0]);}catch{}}" +
    "try{if(u.startsWith('/'))u=new URL(u,base||location.href).href;}catch{}return u;};" +
    "const titleOf=(a)=>{const h=a.querySelector('h3,h2,h4');const t=((h&&(h.innerText||h.textContent))||a.innerText||a.textContent||'').trim();return t;};" +
    "const extract=(doc,base)=>{const root=pickRoot(doc);const links=[];const seen=new Set();" +
    "for(const a of root.querySelectorAll(linkSel)){const href=a.getAttribute('href')||'';const url=normalize(href,base);const title=titleOf(a);" +
    "if(url&&title&&title.length>2&&(url.startsWith('http')||href.startsWith('/url'))){if(skip(url))continue;const key=url.split('#')[0];if(!seen.has(key)){seen.add(key);links.push({title:title.slice(0,150),url});}}" +
    "if(links.length>=limit)break;}" +
    "return {root,links};};" +
    "const start=Date.now();let result={links:[],root:document.body||document.documentElement};" +
    "try{result=extract(document,location.href);}catch{}while(Date.now()-start<12000&&result.links.length<min){await sleep(400);try{result=extract(document,location.href);}catch{}}" +
    "const seen=new Set(result.links.map(l=>l.url));const merged=result.links.slice();let doc=document;let base=location.href;let pages=1;" +
    "const pickNext=(d,b)=>{if(!nextSel)return null;const cands=[...d.querySelectorAll(nextSel)];if(!cands.length)return null;let a=cands[cands.length-1];" +
    "if(nextText){const hit=cands.find(x=>((x.innerText||x.textContent||'').indexOf(nextText)>=0));if(hit)a=hit;}" +
    "const href=a.getAttribute('href')||'';if(!href||href.charAt(0)==='#')return null;" +
    "try{const u=new URL(href,b||location.href).href;return u===(b||location.href)?null:u;}catch{return null;}};" +
    "while(merged.length<limit&&pages<maxPages){const next=pickNext(doc,base);if(!next)break;" +
    "await sleep(pageDelay+Math.floor(Math.random()*Math.min(800,Math.max(1,Math.floor(pageDelay/2)))));" +
    "let html=null;try{const resp=await fetch(next,{credentials:'include'});if(!resp.ok)break;html=await resp.text();}catch{break;}" +
    "if(!html||html.length<200)break;" +
    "let parsed=null;try{parsed=new DOMParser().parseFromString(html,'text/html');}catch{break;}" +
    "let added=[];try{added=extract(parsed,next).links;}catch{}" +
    "for(const l of added){if(merged.length>=limit)break;const key=l.url.split('#')[0];if(!seen.has(key)){seen.add(key);merged.push(l);}}" +
    "doc=parsed;base=next;pages++;}" +
    "return {count:merged.length,links:merged,text:((result.root.innerText||'').slice(0,textLimit).trim()),pages:pages,pagesRequested:maxPages,limit:limit};})()"
  );
}

/** 抓取 Google 搜索结果（未声明 rootSelectors 的模板走这里）：Google 自家 UI 链接内置排除，
 *  自动翻页用 #pnnext；其余行为与通用 searchResultsExpr 一致。 */
function googleResultsExpr(options: { limit?: number; textLimit?: number; nextSelector?: string; maxPages?: number; pageDelayMs?: number } = {}): string {
  const BAD = [
    "/search?", "/imgres", "/preferences", "/advanced_search", "/intl/", "/settings", "/webhp",
    "/maps", "/shopping", "/finance", "/news", "/videos", "/books", "/scholar", "/translate",
    "/travel", "/support", "/policies", "/accounts",
    "https://www.google.com/search?", "https://www.google.com/preferences", "https://www.google.com/intl/", "https://www.google.com/webhp",
  ];
  return searchResultsExpr({
    rootSelectors: ["#search", "#rso", "#center_col"],
    linkSelector: "a",
    minResults: 3,
    limit: options.limit,
    textLimit: options.textLimit,
    excludeUrlPrefixes: BAD,
    nextSelector: options.nextSelector ?? "#pnnext",
    maxPages: options.maxPages,
    pageDelayMs: options.pageDelayMs,
  });
}

/** AI 聊天模版的写步骤：先把 prompt 写进富文本编辑器（Gemini=Quill API、ChatGPT=ProseMirror 经 execCommand），
 *  同时把「发送前最后一条消息容器的消息 ID」记到 window.__bpPrevMsg（锚点），
 *  供 @chatCollect 用「文档顺序在锚点之后」判定真正属于本轮的内容——复用长会话时，锚点之前的旧回复（含旧图）一律排除。
 *  ChatGPT 每条消息容器带 data-message-id；Gemini 每轮对话容器是 div.conversation-container（id 属性=该轮消息 ID）。 */
function aiWriteExpr(mode: string, prompt: string): string {
  const p = JSON.stringify(prompt);
  const core = mode === "gemini" ? geminiQuillCore() : mode === "textarea" ? textareaWriteCore() : chatgptProseCore();
  // 锚点 = 发送前最后一个「消息/轮次」容器的消息 ID
  const anchorExpr = mode === "gemini"
    ? "(()=>{const c=[...document.querySelectorAll('div.conversation-container')];return c.length?(c[c.length-1].getAttribute('id')||''):'';})()"
    : "(()=>{const c=[...document.querySelectorAll('[data-message-author-role]')];return c.length?(c[c.length-1].getAttribute('data-message-id')||''):'';})()";
  return "(async()=>{const text=" + p + ";window.__bpPrevMsg=" + anchorExpr + ";" + core + "})()";
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
    "return {ok:true,method:'quill',prev:window.__bpPrevMsg,len:q.getLength(),sendReady:ok};}" +
    "if(rt){rt.focus();const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(rt);sel.removeAllRanges();sel.addRange(r);document.execCommand('delete');" +
    "try{document.execCommand('insertText',false,text);}catch{}" +
    "let ok=false;for(let i=0;i<30;i++){const b=document.querySelector(\"button[aria-label='Send message']\");if(b&&!b.disabled){ok=true;break;}await new Promise(r=>setTimeout(r,250));}" +
    "return {ok:true,method:'dom',prev:window.__bpPrevMsg,sendReady:ok};}" +
    "return {ok:false,prev:window.__bpPrevMsg};"
  );
}

/** 通用 textarea 写入主体（DeepSeek 等）：native setter + input 事件（React 受控组件也能感知）。
 *  写入前把当前 .ds-markdown 数量记到 window.__bpMdCount，供后续等待步骤判断"回复已开始渲染"。 */
function textareaWriteCore(): string {
  return (
    "window.__bpMdCount=document.querySelectorAll('.ds-markdown').length;" +
    "const ta=document.querySelector('textarea');" +
    "if(!ta)return {ok:false,error:'no-textarea',hint:'页面未渲染输入框（未登录或改版）'};" +
    "ta.focus();" +
    "let ok=false;try{ok=document.execCommand('insertText',false,text);}catch{}" +
    "if(!ok||(ta.value||'').length===0){try{const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;setter.call(ta,text);ta.dispatchEvent(new Event('input',{bubbles:true}));}catch{}}" +
    "return {ok:(ta.value||'').length>0,method:(ta.value||'').length>0?'textarea':'failed',len:(ta.value||'').length};"
  );
}

/** ChatGPT 的 ProseMirror 写入主体（引用变量 text）。ProseMirror 监听 beforeinput/input，execCommand('insertText')
 *  会触发它把文本写进编辑器 state（实测 innerText 生效、发送按钮点亮）。
 *  多段落文本按 \n 逐行 insertText + insertLineBreak——整段含换行一次性 insertText 会被 ProseMirror 处理坏
 *  （2026-09-09 外部 Agent 复现：769 字符多行 prompt 注入后发送无效）。
 *  写完后轮询等待发送按钮就绪，避免紧接的 click 因按钮未渲染而定位失败。 */
function chatgptProseCore(): string {
  return (
    "const pm=document.querySelector('.ProseMirror[contenteditable=\"true\"]')||document.querySelector('#prompt-textarea .ProseMirror')||document.querySelector('[contenteditable=\"true\"]');" +
    "if(!pm)return {ok:false,prev:window.__bpPrevMsg};" +
    "pm.focus();const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(pm);sel.removeAllRanges();sel.addRange(r);document.execCommand('delete');" +
    "const lines=String(text).split('\\n');let ins=true;" +
    "for(let i=0;i<lines.length;i++){" +
    "if(lines[i]){try{if(!document.execCommand('insertText',false,lines[i]))ins=false;}catch(e){ins=false;}}" +
    "if(i<lines.length-1){try{if(!document.execCommand('insertLineBreak'))ins=false;}catch(e){ins=false;}}}" +
    "let ok=false;for(let i=0;i<30;i++){const b=document.querySelector(\"button[data-testid='send-button']\");if(b&&!b.disabled){ok=true;break;}await new Promise(r=>setTimeout(r,250));}" +
    "return {ok:ins,method:'prosemirror',prev:window.__bpPrevMsg,sendReady:ok};"
  );
}

/** AI 聊天模版的回复回收：只回收**我发出的那条 user 消息之后**产生的内容，**等它完全说完/生成完**才返回
 *  （文本长度 + 图片集合稳定约 5s，覆盖「出图/生成中」）。
 *  锚点 = **我新发的那条 user 消息**。@write 已把发送前最后一条消息容器的 DOM id 写入 window.__bpPrevMsg（Gemini=
 *  div.conversation-container 的 id、ChatGPT=[data-message-id]）；@chatCollect 先把该 id 解析成元素，再**等待并取它之后
 *  出现的最后一条 user 消息**（Gemini=[...user-query]，ChatGPT=[data-message-author-role='user']）作为锚点。
 *  之所以不用「__bpPrevMsg 元素本身 / 运行时最后一个 user」当锚点：① 生成期间新 user 可能尚未插入，取运行时最后一个
 *  user 会把「最后一条旧回复（含旧图）」误判为本轮；② 上一轮回复的图（Gemini 在上一容器内 = 后代、ChatGPT 在上一
 *  user 之后的兄弟 imagegen 节点）都比「我这条消息」早，须以「我这条消息」为界才能一并排除。等待最多 60s，超时回退到
 *  最后一个 user。只有文档顺序在锚点**之后**的 assistant 文本与大图才被收集。
 *  after 判定为「严格在锚点之后且**不是锚点的后代**」：documentPosition 对锚点容器（user-query 之后的响应容器）里的
 *  元素也会同时置位 FOLLOWING，若不排除 CONTAINED_BY，会把锚点容器内的旧图误判为本轮。
 *  这正对应「我发消息后才产生的回复」语义，靠消息容器/ID 定位，不再用「容器个数」或「图片 src 差集」
 *  这种会被懒加载/复用索引误导的启发式。
 *  图片：文档顺序在锚点之后（且非其后代）的全页大图（naturalWidth>=512 且 naturalHeight>=256，排除头像/图标）。
 *  返回：text + images（data:/http:/blob: src 列表）。 */
function aiCollectExpr(mode: string): string {
  const roleSel = mode === "gemini" ? ".markdown" : "div[data-message-author-role='assistant']";
  const b = JSON.stringify(roleSel);
  const userSel = mode === "gemini" ? "user-query" : "[data-message-author-role='user']";
  const mineSel = mode === "gemini"
    ? "[...document.querySelectorAll('user-query')].pop()||null"
    : "[...document.querySelectorAll(\"[data-message-author-role='user']\")].pop()||null";
  const strip = mode === "gemini"
    ? ["Flash", "Gemini is AI", "Dictate", "Copy", "Listen", "Retry", "Show drafts"]
    : ["ChatGPT 也可能会犯错", "ChatGPT can make mistakes", "思考"];
  const S = JSON.stringify(strip);
  const PFX = JSON.stringify(["Gemini said", "ChatGPT said", "You said"]);
  return (
    "(async()=>{const roleSel=" + b + ";const ST=" + S + ";const PFX=" + PFX + ";" +
    "const mine=await (async()=>{const prev=window.__bpPrevMsg;let prevEl=null;" +
    (mode === "gemini"
      ? "if(prev)prevEl=document.getElementById(prev);"
      : "if(prev)prevEl=document.querySelector('[data-message-id=\"'+prev+'\"]');") +
    "const us=()=>[...document.querySelectorAll(\"" + userSel + "\")];" +
    "const ws=Date.now();while(Date.now()-ws<60000){const users=us();" +
    "if(prevEl){const aU=users.filter(u=>((prevEl.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING)!==0)&&((prevEl.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_CONTAINED_BY)===0));if(aU.length)return aU[aU.length-1];}" +
    "else if(users.length){return users[users.length-1];}" +
    "await new Promise(r=>setTimeout(r,400));}" +
    "return " + mineSel + ";})();" +
    "const after=(el)=>el&&mine?(((mine.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)!==0)&&((mine.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_CONTAINED_BY)===0)):false;" +
    "const start=Date.now();const timeout=120000;let last='';let lastImgs=[];let prevSig='';let stable=0;" +
    "const bigImgs=()=>{const out=[];const seen=new Set();" +
    "for(const i of document.querySelectorAll('img')){const s=i.currentSrc||i.src||'';if(!s)continue;" +
    "const w=i.naturalWidth||0;const h=i.naturalHeight||0;if(w>=512&&h>=256&&after(i)){if(!seen.has(s)){seen.add(s);out.push(s);}}}" +
    "return out;};" +
    "while(Date.now()-start<timeout){" +
    "const added=[...document.querySelectorAll(roleSel)].filter(after);" +
    "let rep='';for(let j=0;j<added.length;j++){const md=added[j].querySelector('.markdown')||added[j];" +
    "let t=(md.innerText||'');" +
    "for(const pf of PFX){if(t.startsWith(pf))t=t.slice(pf.length);}" +
    "for(const s of ST){const i=t.indexOf(s);if(i>=0)t=t.slice(0,i);}" +
    "t=t.trim();if(t)rep=rep?(rep+'\\n'+t):t;}" +
    "const imgs=bigImgs();" +
    "if(rep.length>2||imgs.length>0){last=rep;lastImgs=imgs;" +
    "const sig=rep.length+':'+imgs.join('|');" +
    "if(sig===prevSig){stable+=700;}else{prevSig=sig;stable=0;}if(stable>=5000)break;}" +
    "await new Promise(r=>setTimeout(r,700));}" +
    "return {text:last.slice(0,8000),images:lastImgs,url:location.href,title:document.title};})()"
  );
}

/** 续问前置校验：确认当前标签 URL 仍指向目标会话。
 *  传入 expectedUrl（会话 URL）时 strict 比对 location.href 是否以它开头（同会话=是）；
 *  expectedUrl 为空则跳过校验（走基线机制兜底，适合首次提问）。
 *  返回 "__BP_CONV_OK__"+href（通过）或 "__BP_CONV_BAD__"+href（不通过），配 expect:"__BP_CONV_OK__"。 */
function verifyConversationExpr(expectedUrl: string): string {
  const exp = JSON.stringify(expectedUrl || "");
  return (
    "(async()=>{const exp=" + exp + ";const href=location.href;" +
    "if(exp){const ok=href.indexOf(exp)===0;return ok?'__BP_CONV_OK__'+href:'__BP_CONV_BAD__'+href;}" +
    "return '__BP_CONV_OK__'+href;})()"
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
// 随扩展发布的模板包（registry/bundle.json → dist/templates.bundle.json）
// 全部模板开箱即用，不再硬编码单个内置模板；GitHub Registry 只用于发现更新与新增。
// ---------------------------------------------------------------------------

const GOOGLE_CANDS = ["textarea[name='q']", "input[name='q']", "input[type='search']", "input[type='text']"];

// ---------------------------------------------------------------------------
// 导入 / 导出 / 清单
// ---------------------------------------------------------------------------

const STORE_KEY = "browserpilot.templates.v2";
const LEGACY_STORE_KEY = "browserpilot.templates.v1";
const REGISTRY_CACHE_KEY = "browserpilot.registry.cache.v1";
// 仅约束 Registry 的 JSON/Markdown 定义，绝不约束模板引用或任务下载的图片/音视频资源。
const MAX_TEMPLATE_DEFINITION_BYTES = 1_000_000;

interface TemplateSource {
  type: "local" | "url" | "github";
  url?: string;
  repo?: string;
  path?: string;
  ref?: string;
}

interface TemplateRevision {
  template: Template;
  contentHash: string;
  updatedAt: number;
}

interface InstalledTemplateRecord {
  template: Template;
  enabled: boolean;
  source: TemplateSource;
  installedAt: number;
  updatedAt: number;
  contentHash: string;
  previous?: TemplateRevision;
}

async function hashTemplate(template: Template): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(template));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let legacyMigration: Promise<Record<string, InstalledTemplateRecord>> | null = null;

async function loadInstalled(): Promise<Record<string, InstalledTemplateRecord>> {
  const raw = await chrome.storage.local.get([STORE_KEY, LEGACY_STORE_KEY]);
  const current = (raw[STORE_KEY] as Record<string, InstalledTemplateRecord> | undefined) ?? {};
  // v2 key 即使是空对象也代表迁移已完成；不能因“全部卸载”而再次从 v1 复活旧模板。
  if (raw[STORE_KEY] !== undefined) return current;
  const legacy = (raw[LEGACY_STORE_KEY] as Record<string, Template> | undefined) ?? {};
  if (!Object.keys(legacy).length) return current;
  // 并发调用（如一次 dispatch 内多个模板命令）只做一次迁移，避免双写。
  legacyMigration ??= (async () => {
    const now = Date.now();
    const migrated: Record<string, InstalledTemplateRecord> = {};
    for (const [id, template] of Object.entries(legacy)) {
      migrated[id] = {
        template,
        enabled: true,
        source: { type: "local" },
        installedAt: now,
        updatedAt: now,
        contentHash: await hashTemplate(template),
      };
    }
    await saveInstalled(migrated);
    await chrome.storage.local.remove(LEGACY_STORE_KEY);
    return migrated;
  })();
  return legacyMigration;
}

async function saveInstalled(map: Record<string, InstalledTemplateRecord>): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: map });
}

async function resolveInstalledRecord(id: string): Promise<InstalledTemplateRecord | undefined> {
  const records = await loadInstalled();
  return records[id];
}

export async function resolveTemplateById(id: string, includeDisabled = false): Promise<Template | undefined> {
  const record = await resolveInstalledRecord(id);
  if (record && (includeDisabled || record.enabled)) return record.template;
  const bundled = await loadBundledTemplates();
  return bundled[id];
}

function templateCapabilities(template: Template): string[] {
  if (template.steps !== "commands") return [template.steps];
  return [...new Set((template.body as TemplateStep[]).map((step) => step.name))];
}

export async function listTemplates(): Promise<unknown[]> {
  const installed = await loadInstalled();
  const bundled = await loadBundledTemplates();
  const builtins = Object.values(bundled).filter((t) => !installed[t.id]).map((t) => ({
    id: t.id,
    name: t.name,
    version: t.version ?? "0.0.0",
    description: t.description,
    category: t.category,
    tags: t.tags ?? [],
    inputs: t.inputs,
    steps: t.steps,
    scope: t.scope,
    sites: t.scope?.sites ?? [],
    intents: t.discovery?.intents ?? [],
    keywords: t.discovery?.keywords ?? [],
    outputs: t.discovery?.outputs ?? [],
    risk: t.discovery?.risk ?? "write",
    aliases: t.discovery?.aliases ?? [],
    builtin: true,
    enabled: true,
    source: { type: "builtin" },
    updateAvailable: false,
    capabilities: templateCapabilities(t),
  }));
  const records = Object.values(installed).map((r) => ({
    id: r.template.id,
    name: r.template.name,
    version: r.template.version ?? "0.0.0",
    description: r.template.description,
    category: r.template.category,
    tags: r.template.tags ?? [],
    inputs: r.template.inputs,
    steps: r.template.steps,
    scope: r.template.scope,
    sites: r.template.scope?.sites ?? [],
    intents: r.template.discovery?.intents ?? [],
    keywords: r.template.discovery?.keywords ?? [],
    outputs: r.template.discovery?.outputs ?? [],
    risk: r.template.discovery?.risk ?? "write",
    aliases: r.template.discovery?.aliases ?? [],
    builtin: false,
    overridesBuiltin: !!bundled[r.template.id],
    fallbackBuiltin: !!bundled[r.template.id],
    enabled: r.enabled,
    source: r.source,
    installedAt: r.installedAt,
    updatedAt: r.updatedAt,
    contentHash: r.contentHash,
    canRollback: !!r.previous,
    capabilities: templateCapabilities(r.template),
  }));
  return [...builtins, ...records];
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

async function fetchSource(source: TemplateSource): Promise<string> {
  let url = source.url;
  if (source.type === "github") {
    const repo = String(source.repo ?? "");
    const filePath = String(source.path ?? "").replace(/^\/+/, "");
    const ref = String(source.ref ?? "main");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GitHub repo 必须是 owner/repo");
    if (!filePath || filePath.split("/").includes("..")) throw new Error("GitHub template path 无效");
    if (!/^[A-Za-z0-9_./-]+$/.test(ref)) throw new Error("GitHub ref 无效");
    url = "https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + filePath;
  }
  if (!url || !/^https:\/\//i.test(url)) throw new Error("模板来源需要 HTTPS URL");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("获取模板失败: HTTP " + response.status);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_TEMPLATE_DEFINITION_BYTES) throw new Error("模板定义文件超过 1MB 限制（媒体资源请使用外部 URL/下载通道）");
  const text = await response.text();
  if (text.length > MAX_TEMPLATE_DEFINITION_BYTES) throw new Error("模板定义文件超过 1MB 限制（媒体资源请使用外部 URL/下载通道）");
  return text;
}

function sourceFromArgs(args: Record<string, unknown>): TemplateSource {
  const raw = (args.source ?? {}) as Partial<TemplateSource>;
  if (raw.type === "github") return { type: "github", repo: raw.repo, path: raw.path, ref: raw.ref ?? "main" };
  if (raw.type === "url" || typeof args.url === "string") return { type: "url", url: String(raw.url ?? args.url ?? "") };
  return { type: "local" };
}

export async function installTemplate(cmd: Command): Promise<unknown> {
  const args = (cmd.args ?? {}) as Record<string, unknown>;
  const source = sourceFromArgs(args);
  const content = typeof args.content === "string" && args.content.trim()
    ? args.content
    : source.type !== "local"
      ? await fetchSource(source)
      : "";
  if (!content) throw new Error("install_template 需要 content、url 或 GitHub source");
  // fetchSource 对远端有同样限制；content 直传路径也必须受约束（媒体走 download 通道）。
  if (content.length > MAX_TEMPLATE_DEFINITION_BYTES) {
    throw new Error("模板定义文件超过 1MB 限制（媒体资源请使用外部 URL/下载通道）");
  }
  const template = parseTemplateContent(content);
  const records = await loadInstalled();
  const bundled = await loadBundledTemplates();
  const existing = records[template.id];
  const now = Date.now();
  const contentHash = await hashTemplate(template);
  records[template.id] = {
    template,
    enabled: existing?.enabled ?? true,
    source,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    contentHash,
    previous: existing
      ? { template: existing.template, contentHash: existing.contentHash, updatedAt: existing.updatedAt }
      : undefined,
  };
  await saveInstalled(records);
  return {
    installed: true,
    id: template.id,
    name: template.name,
    version: template.version ?? "0.0.0",
    source,
    contentHash,
    updated: !!existing,
    overridesBuiltin: !!bundled[template.id],
  };
}

export async function importTemplate(cmd: Command): Promise<unknown> {
  const args = (cmd.args ?? {}) as { id?: string; content?: string };
  if (args.id) {
    const t = await resolveTemplateById(args.id);
    if (!t) throw new Error("未找到要导入的模版: " + args.id);
    const installed = await resolveInstalledRecord(t.id);
    const bundled = await loadBundledTemplates();
    return { imported: true, id: t.id, builtin: !installed && !!bundled[t.id], name: t.name };
  }
  if (typeof args.content === "string" && args.content.trim()) {
    const installed = await installTemplate(cmd) as { id: string; name: string };
    return { imported: true, id: installed.id, builtin: false, name: installed.name };
  }
  throw new Error("import_template 需要 id 或 content");
}

export async function uninstallTemplate(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  if (!id) throw new Error("uninstall_template 需要 id");
  const records = await loadInstalled();
  if (!records[id]) {
    const bundled = await loadBundledTemplates();
    if (bundled[id]) throw new Error("随扩展发布的模板不能卸载");
    throw new Error("未安装模板: " + id);
  }
  delete records[id];
  await saveInstalled(records);
  const bundled = await loadBundledTemplates();
  return { uninstalled: true, id, restoredBuiltin: !!bundled[id] };
}

export async function setTemplateEnabled(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  const enabled = cmd.args?.enabled;
  if (!id || typeof enabled !== "boolean") throw new Error("set_template_enabled 需要 id 和 enabled:boolean");
  const records = await loadInstalled();
  if (!records[id]) {
    const bundled = await loadBundledTemplates();
    if (bundled[id]) throw new Error("随扩展发布的模板暂不支持禁用");
    throw new Error("未安装模板: " + id);
  }
  records[id].enabled = enabled;
  records[id].updatedAt = Date.now();
  await saveInstalled(records);
  const bundled = await loadBundledTemplates();
  return { id, enabled, fallbackBuiltinActive: !enabled && !!bundled[id] };
}

export async function checkTemplateUpdate(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  const record = await resolveInstalledRecord(id);
  if (!record) throw new Error("未安装模板: " + id);
  if (record.source.type === "local") return { id, updateAvailable: false, reason: "local_source" };
  const content = await fetchSource(record.source);
  const candidate = parseTemplateContent(content);
  if (candidate.id !== id) throw new Error("远端模板 id 不匹配: " + candidate.id);
  const remoteHash = await hashTemplate(candidate);
  return {
    id,
    updateAvailable: remoteHash !== record.contentHash,
    currentVersion: record.template.version ?? "0.0.0",
    remoteVersion: candidate.version ?? "0.0.0",
    currentHash: record.contentHash,
    remoteHash,
  };
}

function parseVersion(value: unknown): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function versionGreater(left: unknown, right: unknown): boolean {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** 模板看板/外部 Agent 的「检查更新」：对比 GitHub Registry 与本地全量模板（含随扩展发布的模板包），
 *  返回可更新与新增数量，由用户勾选后再 install_template。 */
export async function checkRegistryUpdates(cmd: Command): Promise<unknown> {
  const cache = await getRegistryCache(cmd);
  const local = await listTemplates() as Array<Record<string, unknown>>;
  const localById = new Map(local.map((item) => [String(item.id), item]));
  const updates: Array<Record<string, unknown>> = [];
  const added: Array<Record<string, unknown>> = [];
  for (const entry of cache.templates) {
    const id = String(entry.id ?? "");
    if (!id) continue;
    const source = { type: "github", repo: cache.repo, ref: cache.ref, path: String(entry.path ?? "") };
    const base = {
      id,
      name: String(entry.name ?? id),
      description: String(entry.description ?? ""),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      remoteVersion: String(entry.version ?? "0.0.0"),
      source,
    };
    const mine = localById.get(id);
    if (!mine) {
      added.push(base);
      continue;
    }
    const localVersion = String(mine.version ?? "0.0.0");
    if (versionGreater(base.remoteVersion, localVersion)) {
      updates.push({
        ...base,
        localVersion,
        builtin: !!mine.builtin,
        installed: !mine.builtin,
        overridesBuiltin: !!mine.overridesBuiltin,
      });
    }
  }
  return {
    registry: { repo: cache.repo, ref: cache.ref, syncedAt: cache.syncedAt, total: cache.templates.length },
    counts: { updates: updates.length, added: added.length, local: local.length },
    updates: updates.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    added: added.sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

export async function listTemplateCatalog(cmd: Command): Promise<unknown> {
  const repo = String(cmd.args?.repo ?? "insogao/BrowserPilot");
  const ref = String(cmd.args?.ref ?? "main");
  const catalogPath = String(cmd.args?.path ?? "registry/catalog.json");
  const text = await fetchSource({ type: "github", repo, ref, path: catalogPath });
  const parsed = JSON.parse(text) as { schemaVersion?: unknown; templates?: unknown };
  if (![1, 2].includes(Number(parsed.schemaVersion)) || !Array.isArray(parsed.templates)) throw new Error("不支持的模板目录格式");
  if (parsed.templates.length > 500) throw new Error("模板目录超过 500 项限制");
  const templates = parsed.templates.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("模板目录包含无效条目");
    const item = raw as Record<string, unknown>;
    const id = String(item.id ?? "");
    const itemPath = String(item.path ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(id) || !itemPath || itemPath.split("/").includes("..")) {
      throw new Error("模板目录条目 id/path 无效");
    }
    return {
      ...item,
      id,
      name: String(item.name ?? id),
      version: String(item.version ?? "0.0.0"),
      path: itemPath,
      description: String(item.description ?? ""),
    };
  });
  return { schemaVersion: Number(parsed.schemaVersion), repo, ref, path: catalogPath, templates };
}

interface RegistryCache {
  repo: string;
  ref: string;
  path: string;
  syncedAt: number;
  templates: Array<Record<string, unknown>>;
}

export async function syncRegistry(cmd: Command): Promise<unknown> {
  const result = await listTemplateCatalog(cmd) as { repo: string; ref: string; path: string; templates: Array<Record<string, unknown>> };
  const cache: RegistryCache = { ...result, syncedAt: Date.now() };
  await chrome.storage.local.set({ [REGISTRY_CACHE_KEY]: cache });
  return { synced: true, repo: cache.repo, ref: cache.ref, path: cache.path, syncedAt: cache.syncedAt, count: cache.templates.length };
}

async function getRegistryCache(cmd: Command): Promise<RegistryCache> {
  const repo = String(cmd.args?.repo ?? "insogao/BrowserPilot");
  const ref = String(cmd.args?.ref ?? "main");
  const catalogPath = String(cmd.args?.path ?? "registry/catalog.json");
  const raw = await chrome.storage.local.get(REGISTRY_CACHE_KEY);
  const cached = raw[REGISTRY_CACHE_KEY] as RegistryCache | undefined;
  const fresh = cached && cached.repo === repo && cached.ref === ref && cached.path === catalogPath && Date.now() - cached.syncedAt < 15 * 60_000;
  if (fresh && !cmd.args?.refresh) return cached;
  await syncRegistry({ ...cmd, args: { ...cmd.args, repo, ref, path: catalogPath } });
  const next = await chrome.storage.local.get(REGISTRY_CACHE_KEY);
  return next[REGISTRY_CACHE_KEY] as RegistryCache;
}

function textScore(query: string, item: Record<string, unknown>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const tokens = [...new Set([q, ...q.split(/[\s,，/]+/).filter(Boolean)])];
  const fields: Array<[unknown, number]> = [
    [item.id, 10], [item.name, 9], [item.aliases, 8], [item.intents, 8], [item.keywords, 7],
    [item.tags, 6], [item.sites, 6], [item.capabilities, 5], [item.description, 4], [item.category, 3],
  ];
  let score = 0;
  for (const token of tokens) {
    for (const [value, weight] of fields) {
      const haystack = Array.isArray(value) ? value.join(" ").toLowerCase() : String(value ?? "").toLowerCase();
      if (haystack === token) score += weight * 2;
      else if (haystack.includes(token)) score += weight;
    }
  }
  return score;
}

export async function searchTemplates(cmd: Command): Promise<unknown> {
  const query = String(cmd.args?.query ?? "");
  const cache = await getRegistryCache(cmd);
  const installed = await listTemplates() as Array<Record<string, unknown>>;
  const installedIds = new Set(installed.map((item) => String(item.id)));
  const remote: Array<Record<string, unknown>> = cache.templates.map((item) => ({ ...item, installed: installedIds.has(String(item.id)), source: { type: "github", repo: cache.repo, ref: cache.ref, path: item.path } }));
  const byId = new Map<string, Record<string, unknown>>();
  const combined: Array<Record<string, unknown>> = [...remote, ...installed.map((x) => ({ ...x, installed: true }))];
  for (const item of combined) byId.set(String(item.id), item);
  const results: Array<Record<string, unknown>> = [...byId.values()]
    .map((item): Record<string, unknown> => ({ ...item, score: textScore(query, item) }))
    .filter((item) => Number(item.score) > 0)
    .sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, Math.min(Number(cmd.args?.limit ?? 20), 100)));
  return { query, count: results.length, registry: { repo: cache.repo, ref: cache.ref, syncedAt: cache.syncedAt }, templates: results };
}

export async function getTemplateDetail(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  if (!id) throw new Error("get_template_detail 需要 id");
  const local = await resolveTemplateById(id, true);
  if (local) {
    const record = await resolveInstalledRecord(id);
    const bundled = await loadBundledTemplates();
    return {
      id,
      installed: !!record || !!bundled[id],
      builtin: !record && !!bundled[id],
      overridesBuiltin: !!record && !!bundled[id],
      fallbackBuiltin: !!bundled[id],
      template: local,
      markdown: toMarkdown(local),
      record,
    };
  }
  const cache = await getRegistryCache(cmd);
  const entry = cache.templates.find((item) => String(item.id) === id);
  if (!entry) throw new Error("Registry 未找到模板: " + id);
  const templateText = await fetchSource({ type: "github", repo: cache.repo, ref: cache.ref, path: String(entry.path) });
  const template = parseTemplateContent(templateText);
  let markdown = toMarkdown(template);
  if (entry.detailsPath) {
    try { markdown = await fetchSource({ type: "github", repo: cache.repo, ref: cache.ref, path: String(entry.detailsPath) }); }
    catch { /* 详情生成物可选，回退到 manifest 自动说明 */ }
  }
  return { id, installed: false, builtin: false, source: { type: "github", repo: cache.repo, ref: cache.ref, path: entry.path }, catalog: entry, template, markdown };
}

function asSet(value: unknown): Set<string> {
  return new Set((Array.isArray(value) ? value : []).map((x) => String(x).toLowerCase()));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((x) => b.has(x)).length;
  return intersection / (a.size + b.size - intersection || 1);
}

function catalogShape(item: Record<string, unknown>): Record<string, unknown> {
  const template = item.template as Template | undefined;
  if (!template) {
    const normalizeIo = (value: unknown) => (Array.isArray(value) ? value : []).map((x) => {
      if (x && typeof x === "object") {
        const io = x as Record<string, unknown>;
        return String(io.name ?? "") + ":" + String(io.type ?? "");
      }
      return String(x);
    });
    return { ...item, inputs: normalizeIo(item.inputs), outputs: normalizeIo(item.outputs) };
  }
  return {
    id: template.id,
    intents: template.discovery?.intents ?? [],
    sites: template.scope?.sites ?? [],
    capabilities: templateCapabilities(template),
    inputs: template.inputs.map((x) => x.name + ":" + x.type),
    outputs: template.discovery?.outputs.map((x) => x.name + ":" + x.type) ?? [],
  };
}

function compareShapes(leftRaw: Record<string, unknown>, rightRaw: Record<string, unknown>): Record<string, unknown> {
  const left = catalogShape(leftRaw);
  const right = catalogShape(rightRaw);
  const intents = jaccard(asSet(left.intents), asSet(right.intents));
  const sites = jaccard(asSet(left.sites), asSet(right.sites));
  const capabilities = jaccard(asSet(left.capabilities), asSet(right.capabilities));
  const io = (jaccard(asSet(left.inputs), asSet(right.inputs)) + jaccard(asSet(left.outputs), asSet(right.outputs))) / 2;
  const similarity = Number((intents * 0.35 + sites * 0.2 + capabilities * 0.25 + io * 0.2).toFixed(3));
  return { leftId: left.id, rightId: right.id, similarity, exactFingerprint: !!left.fingerprint && left.fingerprint === right.fingerprint, likelyDuplicate: similarity >= 0.82 };
}

export async function compareTemplates(cmd: Command): Promise<unknown> {
  const ids = Array.isArray(cmd.args?.ids) ? cmd.args.ids.map(String).slice(0, 10) : [];
  let cache: RegistryCache | undefined;
  const candidates: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const local = await resolveTemplateById(id, true);
    if (local) candidates.push({ id, template: local });
    else {
      cache ??= await getRegistryCache(cmd);
      const remote = cache.templates.find((item) => String(item.id) === id);
      if (remote) candidates.push(remote);
    }
  }
  if (cmd.args?.candidate && typeof cmd.args.candidate === "object") {
    candidates.push({ id: String((cmd.args.candidate as Record<string, unknown>).id ?? "candidate"), template: validateTemplate(cmd.args.candidate) });
  }
  if (candidates.length < 2) throw new Error("compare_templates 至少需要两个有效模板/candidate");
  const comparisons: Record<string, unknown>[] = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) comparisons.push(compareShapes(candidates[i], candidates[j]));
  return { count: comparisons.length, comparisons: comparisons.sort((a, b) => Number(b.similarity) - Number(a.similarity)) };
}

export async function updateTemplate(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  const record = await resolveInstalledRecord(id);
  if (!record) throw new Error("未安装模板: " + id);
  if (record.source.type === "local") throw new Error("本地模板没有可更新来源");
  const content = await fetchSource(record.source);
  const candidate = parseTemplateContent(content);
  if (candidate.id !== id) throw new Error("远端模板 id 不匹配: " + candidate.id);
  return installTemplate({ ...cmd, args: { content, source: record.source } });
}

export async function rollbackTemplate(cmd: Command): Promise<unknown> {
  const id = String(cmd.args?.id ?? "");
  const records = await loadInstalled();
  const record = records[id];
  if (!record) throw new Error("未安装模板: " + id);
  if (!record.previous) throw new Error("模板没有可回滚版本");
  const current: TemplateRevision = { template: record.template, contentHash: record.contentHash, updatedAt: record.updatedAt };
  record.template = record.previous.template;
  record.contentHash = record.previous.contentHash;
  record.updatedAt = Date.now();
  record.previous = current;
  await saveInstalled(records);
  return { rolledBack: true, id, version: record.template.version ?? "0.0.0", contentHash: record.contentHash };
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
  const t = await resolveTemplateById(id, true);
  if (!t) throw new Error("未找到要导出的模版: " + id);
  const asMd = String(args.as ?? "md") === "md";
  return asMd
    ? { id: t.id, name: t.name, markdown: toMarkdown(t) }
    : { id: t.id, name: t.name, template: t };
}

// ---------------------------------------------------------------------------
// run_template
// ---------------------------------------------------------------------------

let runner: ((cmd: Command) => Promise<unknown>) | null = null;
let runGeneration = 0;
export function cancelTemplateRuns(): void {
  runGeneration++;
}
/** 由 commands.ts 在模块加载时注入 dispatch，避免循环依赖（templates.ts 不 import commands.ts）。 */
export function setCommandRunner(fn: (cmd: Command) => Promise<unknown>): void {
  runner = fn;
}
function runOne(cmd: Command): Promise<unknown> {
  if (!runner) throw new Error("命令调度器未初始化");
  return runner(cmd);
}

const VISIBLE_BEFORE_STEP = new Set<string>([
  "snapshot", "readText", "screenshot", "scroll_screenshot", "js", "waitForURL", "waitForSelector", "pageInfo",
]);

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
      const failure = checkStepExpect(res, step.expect, step.expectations);
      if (failure) throw new Error(failure);
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
  const generation = runGeneration;
  const args = (cmd.args ?? {}) as {
    id?: string;
    params?: Record<string, unknown>;
    tabId?: number;
    background?: boolean;
    focus?: boolean;
    keepVisible?: boolean;
    visible?: boolean;
  };
  const id = String(args.id ?? "");
  const given = (args.params ?? {}) as Record<string, unknown>;
  const baseTab = typeof args.tabId === "number" ? Number(args.tabId) : undefined;
  // 可见性意图：默认后台（不恢复/不聚焦窗口）；显式 focus/keepVisible/visible/background:false 才走前台路径。
  const visibleRun = args.background === false || args.focus === true || args.keepVisible === true || args.visible === true;
  const tpl = await resolveTemplateById(id);
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
    if (generation !== runGeneration) throw new Error("template_cancelled");
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
      stepArgs.expression = focusBestExpr(stringList(stepArgs.selectors ?? params.focusSelectors, GOOGLE_CANDS));
    }
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@results") {
      const hasDeclaredSearch = Array.isArray(stepArgs.rootSelectors) || Array.isArray(params.resultRootSelectors);
      const optionalNumber = (value: unknown): number | undefined => {
        if (value === undefined || value === null || value === "") return undefined;
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
      };
      const resultOptions = {
        limit: Number(stepArgs.limit ?? params.limit ?? 10),
        textLimit: Number(stepArgs.textLimit ?? params.textLimit ?? 6000),
        maxPages: optionalNumber(stepArgs.maxPages ?? params.maxPages),
        pageDelayMs: optionalNumber(stepArgs.pageDelayMs ?? params.pageDelayMs),
        pageSize: optionalNumber(stepArgs.pageSize ?? params.pageSize),
      };
      if (hasDeclaredSearch) {
        stepArgs.expression = searchResultsExpr({
          rootSelectors: stringList(stepArgs.rootSelectors ?? params.resultRootSelectors, ["#search", "#rso", "#center_col"]),
          linkSelector: typeof stepArgs.linkSelector === "string" ? stepArgs.linkSelector : undefined,
          minResults: Number(stepArgs.minResults ?? params.minResults ?? 3),
          excludeUrlPrefixes: stringList(stepArgs.excludeUrlPrefixes ?? params.excludeUrlPrefixes, []),
          nextSelector: typeof (stepArgs.nextSelector ?? params.nextSelector) === "string"
            ? String(stepArgs.nextSelector ?? params.nextSelector)
            : undefined,
          nextText: typeof (stepArgs.nextText ?? params.nextText) === "string"
            ? String(stepArgs.nextText ?? params.nextText)
            : undefined,
          ...resultOptions,
        });
      } else {
        stepArgs.expression = googleResultsExpr({
          limit: resultOptions.limit,
          textLimit: resultOptions.textLimit,
          maxPages: resultOptions.maxPages,
          pageDelayMs: resultOptions.pageDelayMs,
        });
      }
    }
    // @write：把 $prompt 安全写入富文本编辑器（mode 决定 Gemini-Quill / ChatGPT-ProseMirror），并记录回复基线
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@write") {
      stepArgs.expression = aiWriteExpr(String(stepArgs.mode ?? params.mode ?? "gemini"), String(params.prompt ?? ""));
    }
    // @chatCollect：AI 聊天回复回收（只取基线后新增的最后一条回复）
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@chatCollect") {
      stepArgs.expression = aiCollectExpr(String(stepArgs.mode ?? params.mode ?? "gemini"));
    }
    // @verifyConv：续问前置校验（确认当前标签仍指向目标会话 URL；conversationUrl 空则跳过）
    if (typeof stepArgs.expression === "string" && stepArgs.expression === "@verifyConv") {
      stepArgs.expression = verifyConversationExpr(String(params.conversationUrl ?? ""));
    }
    if (TAB_SCOPED.has(step.name) && currentTab !== undefined && stepArgs.tabId === undefined) {
      stepArgs.tabId = currentTab;
    }
    // 可见运行会向下游 tab 切换/显式恢复步骤透传 visible 意图；模板可用 ensureVisible:true 强制单步前台。
    if (visibleRun && ["switch_tab", "ensure_visible"].includes(step.name)
      && stepArgs.background !== true && stepArgs.visible === undefined && stepArgs.focus === undefined && stepArgs.keepVisible === undefined) {
      stepArgs.visible = true;
    }
    const visibleTab = typeof stepArgs.tabId === "number" && Number.isFinite(stepArgs.tabId) ? Number(stepArgs.tabId) : currentTab;
    const shouldEnsureVisible = stepArgs.ensureVisible === true || (visibleRun && stepArgs.ensureVisible !== false);
    if (visibleTab !== undefined && VISIBLE_BEFORE_STEP.has(step.name) && shouldEnsureVisible) {
      await runOne({
        type: "command",
        name: "ensure_visible",
        args: { tabId: visibleTab },
        requestId: cmd.requestId + ":" + i + ":visible",
        space: cmd.space,
        _clientId: cmd._clientId,
        _foregroundLeaseToken: cmd._foregroundLeaseToken,
      });
    }
    const stepCmd: Command = {
      type: "command",
      name: step.name,
      args: stepArgs,
      requestId: cmd.requestId + ":" + i,
      space: cmd.space,
      _clientId: cmd._clientId,
      _foregroundLeaseToken: cmd._foregroundLeaseToken,
    };
    try {
      lastResult = await runStepWithRetry(step, stepCmd);
      if (generation !== runGeneration) throw new Error("template_cancelled");
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
