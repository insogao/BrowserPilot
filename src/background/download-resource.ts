// download_resource 命令（通道 B）：页面上下文内取资源字节 -> data URL -> SW 用 chrome.downloads 落盘。
// 支持单张（args.url / args.selector）与多张（args.urls[]，AI 一次生成多张 / Gemini Choice A/B 全收），多张时文件名自动编号。
// 背景：AI 会话生成的图常是 blob:（页面内 fetch 常失败/被上下文隔离）或带登录态的同源 http
//（chrome.downloads.download 不携带 cookie 会「假成功」）；且 CLI→host→SW 的 native messaging 单条消息有 1MB 上限，
// 大图 base64 不能作为命令参数回传。本命令把「取字节」放在页面上下文里完成（CDP Runtime.evaluate，不经 native messaging），
// 只把结果 data URL 在 SW 内部交给 chrome.downloads.download 落盘，彻底绕开上述两个坑。
import { evalPage } from "./cdp";
import { resolveTargetTab } from "./tab-resolver";
import type { Command } from "../shared/types";

interface ResourceArg {
  url?: string;
  selector?: string;
}

/** 页面上下文表达式：把资源（data:/http:/blob:/selector）转成 data URL 字节串并带元信息返回。
 *  - data:       直接透传；
 *  - blob:       匹配页面里正在显示的 img（currentSrc===url / alt 含 AI generated / 大图）后 canvas 全尺寸无损提取（PNG）；
 *  - http(s):    页面内 fetch(url,{credentials:'include'}) 携带登录 cookie -> blob -> FileReader 转 data URL；失败回退到匹配 img canvas；
 *  - selector:   对该元素取 currentSrc/src/href 后再按上面规则处理。
 *  返回 {ok:true,data,mime,width,height,size,from} 或 {ok:false,error}。 */
function resourceToDataUrlExpr(arg: ResourceArg): string {
  const url = JSON.stringify(arg.url ?? "");
  const selector = JSON.stringify(arg.selector ?? "");
  return [
    "(async()=>{const url=" + url + ";const selector=" + selector + ";",
    "let source=url;",
    "if(!source&&selector){const el=document.querySelector(selector);if(!el)return {ok:false,error:'selector-not-found'};source=el.currentSrc||el.src||el.href||'';}",
    "if(!source)return {ok:false,error:'no-source'};",
    "const mimeOf=(d)=>{const c=d.indexOf(',');const s=d.indexOf(';');return (s>0&&s<c?d.slice(5,s):d.slice(5,c));};",
    "if(source.indexOf('data:')===0){return {ok:true,data:source,mime:mimeOf(source),size:source.length,from:'data'};}",
    "const pick=(pred)=>{const imgs=[...document.querySelectorAll('img')];for(const i of imgs){if(pred(i))return i;}return null;};",
    "const canvasData=(t)=>{const c=document.createElement('canvas');c.width=t.naturalWidth||t.width;c.height=t.naturalHeight||t.height;if(!c.width||!c.height)return {ok:false,error:'img-no-size'};const ctx=c.getContext('2d');ctx.drawImage(t,0,0);const d=c.toDataURL('image/png');return {ok:true,data:d,mime:'image/png',width:c.width,height:c.height,size:d.length,from:'canvas'};};",
    "if(source.indexOf('blob:')===0){",
    "const t=pick(i=>(i.currentSrc===source||i.src===source))||pick(i=>((i.alt||'').indexOf('AI generated')>=0&&(i.naturalWidth||0)>=512))||pick(i=>(i.naturalWidth||0)>=512&&(i.naturalHeight||0)>0);",
    "if(!t)return {ok:false,error:'no-blob-img'};const r=canvasData(t);if(!r.ok)return r;return {ok:true,data:r.data,mime:r.mime,width:r.width,height:r.height,size:r.size,from:'canvas-blob'};}",
    "if(/^https?:/i.test(source)){",
    "try{const resp=await fetch(source,{credentials:'include'});if(!resp.ok)throw new Error('http-'+resp.status);",
    "const blob=await resp.blob();const data=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=()=>rej(fr.error);fr.readAsDataURL(blob);});",
    "const mime=blob.type||mimeOf(data);return {ok:true,data:data,mime:mime,size:data.length,from:'fetch'};}",
    "catch(e){const t=pick(i=>(i.currentSrc===source||i.src===source));if(t){const r=canvasData(t);if(r.ok)return {ok:true,data:r.data,mime:r.mime,width:r.width,height:r.height,size:r.size,from:'canvas-fallback'};}return {ok:false,error:'fetch-failed:'+((e&&e.message)||e)};}}",
    "return {ok:false,error:'unsupported-source'};})()",
  ].join("");
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? "bin";
}

/** 生成落盘文件名：单张用传入 filename 或「download.ext」；多张时以 filename 去扩展名做前缀，按序编号 `prefix-1.ext`。 */
function buildFilename(filename: string | undefined, dataUrl: string, index: number, total: number): string {
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "";
  const ext = extFromMime(mime);
  const base = (filename ?? "").trim();
  if (base) {
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const givenExt = dot > 0 ? base.slice(dot + 1).trim() : "";
    const useExt = givenExt || ext;
    if (total > 1) return stem + "-" + (index + 1) + "." + useExt;
    return dot > 0 ? base : stem + "." + useExt;
  }
  if (total > 1) return "download-" + (index + 1) + "." + ext;
  return "download." + ext;
}

interface FetchResult {
  ok?: boolean;
  data?: string;
  mime?: string;
  width?: number;
  height?: number;
  size?: number;
  from?: string;
  error?: string;
}

export async function downloadResource(cmd: Command): Promise<unknown> {
  const tabId = await resolveTargetTab(cmd);
  const { url, selector, filename, urls } = (cmd.args ?? {}) as {
    url?: string;
    selector?: string;
    filename?: string;
    urls?: unknown;
  };
  let targets: string[] = [];
  if (Array.isArray(urls) && urls.length) {
    targets = urls.filter((u): u is string => typeof u === "string" && !!u.trim());
  } else if (typeof url === "string" && url.trim()) {
    targets = [url.trim()];
  }
  if (!targets.length && !selector) throw new Error("download_resource 需要 args.url / args.urls / args.selector");

  /** 对单个来源取 data URL 并落盘（文件名随 index/total 编号）。 */
  const one = async (src: string, index: number, total: number): Promise<Record<string, unknown>> => {
    const r = (await evalPage(tabId, resourceToDataUrlExpr({ url: src }))) as FetchResult;
    if (!r || !r.ok || !r.data) {
      throw new Error("第 " + (index + 1) + " 张取字节失败: " + String((r && r.error) ?? "未知"));
    }
    const fn = buildFilename(filename, r.data, index, total);
    const options: chrome.downloads.DownloadOptions = { url: r.data };
    if (fn) options.filename = fn;
    const downloadId = await chrome.downloads.download(options);
    return {
      downloaded: true,
      downloadId,
      tabId,
      filename: fn,
      mime: r.mime,
      width: r.width,
      height: r.height,
      size: r.size,
      from: r.from,
      source: src,
    };
  };

  if (targets.length) {
    const results: Record<string, unknown>[] = [];
    const failures: { index: number; source: string; error: string }[] = [];
    for (let i = 0; i < targets.length; i++) {
      try {
        results.push(await one(targets[i], i, targets.length));
      } catch (e) {
        failures.push({ index: i, source: targets[i], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!results.length) {
      throw new Error("download_resource 下载全部失败: " + failures.map((f) => "#" + (f.index + 1) + " " + f.error).join("; "));
    }
    return { downloaded: true, count: results.length, total: targets.length, results, failures: failures.length ? failures : undefined };
  }

  // selector 单资源路径
  const r = (await evalPage(tabId, resourceToDataUrlExpr({ selector }))) as FetchResult;
  if (!r || !r.ok || !r.data) {
    throw new Error("download_resource 未能取到资源字节: " + String((r && r.error) ?? "未知"));
  }
  const fn = buildFilename(filename, r.data, 0, 1);
  const options: chrome.downloads.DownloadOptions = { url: r.data };
  if (fn) options.filename = fn;
  const downloadId = await chrome.downloads.download(options);
  return {
    downloaded: true,
    downloadId,
    tabId,
    filename: fn,
    mime: r.mime,
    width: r.width,
    height: r.height,
    size: r.size,
    from: r.from,
    source: selector,
  };
}
