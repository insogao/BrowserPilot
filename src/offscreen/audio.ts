// offscreen 音频转写管线：解码视频/音频容器 → 降采样 16kHz 单声道 → 压缩 MP3（失败降级 WAV）
// → FormData POST 到 Groq Whisper → 返回转写文本。
// 运行在 offscreen 文档里（SW 无 AudioContext），由 SW groq_transcribe 命令通过 runtime 消息驱动。
interface AudioJob {
  jobId: string;
  bytesB64: string;
  mime: string;
  apiKey: string;
  model: string;
  language?: string;
}
interface AudioJobResult {
  jobId: string;
  ok: boolean;
  text?: string;
  error?: string;
  audioKB?: number;
  audioFormat?: string;
  durationSec?: number;
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

function encodeWav16kMono(pcm: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); w(8, "WAVE");
  w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function encodeAudio(buffer: AudioBuffer): Promise<{ blob: Blob; format: string }> {
  // 先试 MP3（48kbps 单声道 16kHz——语音转写足够，体积约为原视频的 1/50）
  try {
    if ("AudioEncoder" in window) {
      const cfg = { codec: "mp3", sampleRate: 16000, numberOfChannels: 1, bitrate: 48000 };
      const support = await AudioEncoder.isConfigSupported(cfg);
      if (support.supported) {
        const chunks: Uint8Array[] = [];
        const encoder = new AudioEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            chunks.push(bytes);
          },
          error: () => {},
        });
        encoder.configure(cfg);
        const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
        const rendered = await ctx.startRendering();
        const data = rendered.getChannelData(0);
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: 16000,
          numberOfFrames: data.length,
          numberOfChannels: 1,
          timestamp: 0,
          data: data,
        });
        encoder.encode(audioData);
        audioData.close();
        await encoder.flush();
        encoder.close();
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        if (out.length > 1024) {
          return { blob: new Blob([out], { type: "audio/mpeg" }), format: "mp3-48kbps-mono-16k" };
        }
      }
    }
  } catch { /* 落到 WAV */ }
  // 降级：WAV 16kHz 单声道（体积约为 MP3 的 8 倍，但零依赖必成）
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return { blob: encodeWav16kMono(rendered.getChannelData(0), 16000), format: "wav-16k-mono" };
}

async function runJob(job: AudioJob): Promise<AudioJobResult> {
  try {
    if (!job.apiKey) return { jobId: job.jobId, ok: false, error: "no-api-key" };
    const bytes = b64ToBytes(job.bytesB64);
    const ctx = new AudioContext();
    const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const buffer = await ctx.decodeAudioData(arrayBuf);
    await ctx.close();
    const { blob, format } = await encodeAudio(buffer);
    if (blob.size > 25 * 1024 * 1024) {
      return { jobId: job.jobId, ok: false, error: "audio-too-large", audioKB: Math.round(blob.size / 1024), durationSec: Math.round(buffer.duration) };
    }
    const fd = new FormData();
    fd.append("file", blob, "audio." + (format.startsWith("mp3") ? "mp3" : "wav"));
    fd.append("model", job.model || "whisper-large-v3-turbo");
    fd.append("response_format", "verbose_json");
    if (job.language) fd.append("language", job.language);
    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + job.apiKey },
      body: fd,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return { jobId: job.jobId, ok: false, error: "groq-http-" + resp.status + ": " + text.slice(0, 200) };
    }
    let parsed: { text?: string; duration?: number };
    try { parsed = JSON.parse(text); } catch { parsed = { text: text }; }
    return {
      jobId: job.jobId,
      ok: true,
      text: parsed.text || "",
      audioKB: Math.round(blob.size / 1024),
      audioFormat: format,
      durationSec: Math.round(parsed.duration || buffer.duration || 0),
    };
  } catch (e) {
    return { jobId: job.jobId, ok: false, error: String((e as Error).message || e).slice(0, 200) };
  }
}

chrome.runtime.onMessage.addListener((msg: AudioJob & { target?: string }, _sender, sendResponse) => {
  if ((msg as { target?: string }).target !== "offscreen-audio") return false;
  void runJob(msg as AudioJob).then(sendResponse);
  return true; // 异步响应
});
