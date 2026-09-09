// groq_transcribe 命令实现：SW 拉媒体字节（带站点 Cookie）→ offscreen 文档解码/压缩/转写。
// 音频解码不能用 AudioContext（SW 不可用），走 MV3 offscreen 标准模式。
import { ensureAudioOffscreen } from "./offscreen-ctl";


function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function transcribeMedia(args: { url?: string; language?: string; model?: string }): Promise<unknown> {
  const url = (args.url || "").trim();
  if (!url) throw new Error("groq_transcribe 需要 args.url（媒体直链）");
  const key = (await chrome.storage.local.get("groqApiKey")).groqApiKey as string | undefined;
  if (!key) throw new Error("groq_no_key: 未配置 Groq API Key——请在插件弹窗「Groq API Key」中粘贴并保存");

  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error("媒体拉取失败: HTTP " + resp.status);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const mime = resp.headers.get("content-type") || "video/mp4";

  await ensureAudioOffscreen();

  const result = await new Promise<{ ok: boolean; text?: string; error?: string; audioKB?: number; audioFormat?: string; durationSec?: number }>((resolve) => {
    chrome.runtime.sendMessage(
      { target: "offscreen-audio", jobId: "j" + Date.now(), bytesB64: bytesToB64(bytes), mime: mime, apiKey: key, model: args.model || "whisper-large-v3-turbo", language: args.language || "" },
      (res) => {
        void chrome.runtime.lastError; // offscreen 关闭等错误在 res 上体现
        resolve(res as { ok: boolean; text?: string; error?: string });
      },
    );
  });

  if (!result || !result.ok) {
    const err = result?.error || "offscreen 无响应（文档可能被提前关闭，重试一次）";
    throw new Error("groq_transcribe 失败: " + err);
  }
  return {
    transcribed: true,
    text: result.text || "",
    textLength: (result.text || "").length,
    audioKB: result.audioKB,
    audioFormat: result.audioFormat,
    durationSec: result.durationSec,
    sourceUrl: url,
  };
}
