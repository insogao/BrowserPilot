// offscreen 文档生命周期管理（MV3）：保证 audio offscreen 页存在。
export const AUDIO_OFFSCREEN_PATH = "offscreen/audio.html";

export async function ensureAudioOffscreen(): Promise<void> {
  const ctxTypes = (chrome.runtime as unknown as {
    ContextType?: { OFFSCREEN_DOCUMENT?: string };
  }).ContextType;
  const offscreenType = ctxTypes?.OFFSCREEN_DOCUMENT ?? "offscreen_document";
  const contexts = (await (chrome.runtime as unknown as {
    getContexts: (opts: { contextTypes: string[] }) => Promise<{ contextType: string }[]>;
  }).getContexts({ contextTypes: [offscreenType] })) as { contextType: string }[];
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: AUDIO_OFFSCREEN_PATH,
    reasons: ["AUDIO_PLAYBACK" as chrome.offscreen.Reason],
    justification: "解码视频音轨并压缩后转写（Groq Whisper）",
  });
}
