// sandbox 内核（M6）：Blob Worker 里 eval 任意 JS，串行执行、可 cancel/reset/abort。
// sandbox 页面不能用 chrome.*，只能通过 postMessage 与父页面（offscreen）通信。
// M1/M2 只搭骨架：响应 ping / run（run 返回尚未实现）。
type KernelMsg = { kind: "ping" } | { kind: "run"; id: string; code: string };

window.addEventListener("message", (ev: MessageEvent<KernelMsg>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  const target = ev.source as Window | null;
  if (msg.kind === "ping") {
    target?.postMessage({ kind: "pong", from: "kernel", at: Date.now() }, "*");
  } else if (msg.kind === "run") {
    // TODO(M6): Blob Worker + eval(code)，支持 cancel/abort
    target?.postMessage({ kind: "result", id: msg.id, ok: false, error: "run 在 M6 实现" }, "*");
  }
});
