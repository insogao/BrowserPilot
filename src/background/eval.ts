// M5 求值 / 等待 / 页面信息：js / waitForURL / waitForSelector / waitForTimeout / pageInfo。
import { ensureAttach, evalPage, sleep, wildcardToRegExp } from "./cdp";

type Args = Record<string, unknown>;

export async function jsEval(tabId: number, a: Args): Promise<unknown> {
  const expression = String(a.expression ?? "");
  if (!expression) throw new Error("js 需要 expression");
  const value = await evalPage(tabId, expression);
  return { value };
}

export async function waitForURL(tabId: number, a: Args): Promise<unknown> {
  const pattern = String(a.pattern ?? "");
  if (!pattern) throw new Error("waitForURL 需要 pattern");
  const re = wildcardToRegExp(pattern);
  const timeout = Number(a.timeoutMs ?? 15000);
  const start = Date.now();
  const partial = !!a.partial; // 默认精确匹配（^...$），partial 时用包含匹配
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url ?? tab?.pendingUrl ?? "";
    const hit = partial ? url.toLowerCase().includes(pattern.toLowerCase()) : re.test(url);
    if (hit) return { url, matched: true };
    await sleep(200);
  }
  throw new Error("waitForURL 超时: " + pattern);
}

export async function waitForSelector(tabId: number, a: Args): Promise<unknown> {
  const selector = String(a.selector ?? "");
  if (!selector) throw new Error("waitForSelector 需要 selector");
  await ensureAttach(tabId);
  const timeout = Number(a.timeoutMs ?? 10000);
  const visible = !!a.visible;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await evalPage(tabId, "(()=>{const el=document.querySelector(" + JSON.stringify(selector) + ");if(!el)return false;if(" + visible + "&&!el.getBoundingClientRect().width)return false;return true;})()");
    if (found) return { found: true, selector };
    await sleep(200);
  }
  throw new Error("waitForSelector 超时: " + selector);
}

export async function waitForTimeout(_tabId: number, a: Args): Promise<unknown> {
  const ms = Number(a.ms ?? a.timeoutMs ?? 1000);
  await sleep(Math.min(Math.max(ms, 0), 60000));
  return { waitedMs: ms };
}

/** wait_dom_idle：等"内容原地持续变化"的页面（AI 聊天流式输出）归于静默。
 *  MutationObserver 判定：连续 idleMs 无任何 childList/characterData 变化即静默；
 *  超时返回 idle:false（调用方自行决定是否继续）。waitForURL/Selector/Timeout 都覆盖不了这个场景。 */
export async function waitDomIdle(tabId: number, a: Args): Promise<unknown> {
  const idleMs = Math.max(300, Math.min(Number(a.idleMs ?? 3000), 30000));
  const timeoutMs = Math.max(idleMs + 500, Math.min(Number(a.timeoutMs ?? 60000), 300000));
  const selector = typeof a.selector === "string" && a.selector.trim() ? a.selector.trim() : "";
  const expr =
    "(async()=>{const idleMs=" + idleMs + ",timeoutMs=" + timeoutMs + ";" +
    "const root=" + (selector ? "document.querySelector(" + JSON.stringify(selector) + ")" : "document.body") + ";" +
    "if(!root)return {idle:false,error:'no-root',selector:" + JSON.stringify(selector) + "};" +
    "let last=Date.now(),mutations=0;" +
    "const obs=new MutationObserver(ms=>{last=Date.now();mutations+=ms.length;});" +
    "obs.observe(root,{childList:true,subtree:true,characterData:true});" +
    "const start=Date.now();" +
    "while(Date.now()-start<timeoutMs){if(Date.now()-last>=idleMs)break;await new Promise(r=>setTimeout(r,250));}" +
    "obs.disconnect();" +
    "const text=(root.innerText||'').trim();" +
    "return {idle:(Date.now()-last)>=idleMs,waitedMs:Date.now()-start,mutations:mutations,rootTextLen:text.length,tail:text.slice(-120)};" +
    "})()";
  const value = await evalPage(tabId, expr);
  return { tabId, idleMs, timeoutMs, selector: selector || "body", ...(value as Record<string, unknown>) };
}

export async function pageInfo(tabId: number): Promise<unknown> {
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    pendingUrl: tab.pendingUrl,
    windowId: tab.windowId,
  };
}
