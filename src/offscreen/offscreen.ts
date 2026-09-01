// offscreen 文档：承载 sandbox 内核 iframe，并中转 SW ↔ kernel 消息。
// M6 完善：SW 调用 chrome.offscreen.createDocument 打开本页，本页 iframe 载入 kernel.html。
const iframe = document.getElementById("kernel") as HTMLIFrameElement;
iframe.src = chrome.runtime.getURL("kernel/kernel.html");

// 中转到 SW（sandbox iframe 返回的结果经此上抛）
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg && msg.kind && ev.source === iframe.contentWindow) {
    chrome.runtime.sendMessage({ from: "kernel", ...msg }).catch(() => {});
  }
});

// SW → 内核：kernel-bridge.ts 经此转发（M6）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to === "kernel" && iframe.contentWindow) {
    iframe.contentWindow.postMessage(msg.payload, chrome.runtime.getURL("kernel/kernel.html"));
    sendResponse({ forwarded: true });
  }
  return true;
});
