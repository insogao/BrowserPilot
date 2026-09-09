// groq_transcribe 命令实现：SW 拉媒体字节（带站点 Cookie，host_permissions 使跨域+Cookie 可用）
// → FormData POST 给 Groq Whisper。不做转码/抽轨（offscreen 方案因页面加载问题弃用）。
// B站特殊路径：视频页 URL 时从 SSR HTML 提取 __playinfo__ 的音轨直链（仅音频，体积小）。
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_BYTES = 25 * 1024 * 1024;

export async function transcribeMedia(args: { url?: string; language?: string; model?: string }): Promise<unknown> {
  let url = (args.url || "").trim();
  if (!url) throw new Error("groq_transcribe 需要 args.url（媒体直链或 B站视频页链接）");
  const key = (await chrome.storage.local.get("groqApiKey")).groqApiKey as string | undefined;
  if (!key) throw new Error("groq_no_key: 未配置 Groq API Key——请在插件弹窗「Groq API Key」中粘贴并保存");

  const isBiliPage = /bilibili\.com\/video\/(BV|av)/.test(url);
  if (isBiliPage) {
    const pageResp = await fetch(url, { credentials: "include" });
    if (!pageResp.ok) throw new Error("B站页面拉取失败: HTTP " + pageResp.status);
    const html = await pageResp.text();
    const piMatch = html.match(/window\.__playinfo__=([\s\S]*?)<\/script>/);
    if (!piMatch) throw new Error("页面未包含 __playinfo__（视频可能受限或仅 APP 端可播）");
    let audioUrl: string | undefined;
    try {
      const pi = JSON.parse(piMatch[1]);
      audioUrl = pi.data?.dash?.audio?.[0]?.baseUrl || pi.data?.dash?.audio?.[0]?.base_url;
    } catch { /* fallthrough */ }
    if (!audioUrl) throw new Error("页面未找到音轨直链（视频可能仅 APP 端可播）");
    url = audioUrl;
  }

  const mediaResp = await fetch(url, { credentials: "include" });
  if (!mediaResp.ok) throw new Error("媒体拉取失败: HTTP " + mediaResp.status + "（直链可能过期或需要特定来源）");
  const bytes = new Uint8Array(await mediaResp.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("audio-too-large: 媒体 " + Math.round(bytes.byteLength / 1048576) + "MB 超过 25MB 上限——请使用更短的视频");
  }

  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "audio/mpeg" }), "media.mp3");
  fd.append("model", args.model || "whisper-large-v3-turbo");
  fd.append("response_format", "verbose_json");
  if (args.language && /^[a-z]{2}(-[A-Za-z]{2})?$/i.test(String(args.language))) fd.append("language", String(args.language));

  const groqResp = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: fd,
  });
  const text = await groqResp.text();
  if (!groqResp.ok) throw new Error("groq-http-" + groqResp.status + ": " + text.slice(0, 200));

  let parsed: { text?: string; duration?: number };
  try { parsed = JSON.parse(text); } catch { parsed = { text: text }; }
  return {
    transcribed: true,
    text: parsed.text || "",
    textLength: (parsed.text || "").length,
    durationSec: Math.round(parsed.duration || 0),
    mediaBytes: bytes.byteLength,
    sourceUrl: url,
  };
}
