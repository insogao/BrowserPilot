// Native messaging transport for the source extension.
//
// The extension never opens an HTTP endpoint. It connects to the existing
// BrowserPilot native messaging host, which runs in an import-only relay mode:
// no loopback TCP listener, no generic command forwarding. The relay finds the
// running Browser CLI import session by ticket hash, connects to the target's
// named pipe and forwards the job.
//
// Cookie values live only in this service worker's memory and in the native
// messaging/pipe frames. They are never written to storage or logged.
import * as contract from "./contract.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

export class NativeTransportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createNativeTransport({
  connectNative = globalThis.chrome?.runtime?.connectNative?.bind(globalThis.chrome.runtime),
  hostName = contract.HOST_NAME,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof connectNative !== "function") throw new NativeTransportError("native-messaging-unavailable");
  let port = null;
  let closed = false;
  let statusListener = null;
  const waiters = new Set();

  function dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "status" && statusListener) {
      const sanitized = contract.sanitizePublicJobView(message.view);
      if (sanitized) statusListener(sanitized);
      return;
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
  }

  function failAll(code) {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new NativeTransportError(code));
    }
  }

  function ensurePort() {
    if (port) return port;
    if (closed) throw new NativeTransportError("transport-closed");
    port = connectNative(hostName);
    if (!port || typeof port.postMessage !== "function") {
      port = null;
      throw new NativeTransportError("native-messaging-unavailable");
    }
    port.onMessage.addListener(dispatch);
    port.onDisconnect.addListener(() => {
      const error = port?.error?.message;
      port = null;
      statusListener = null;
      failAll(error ? "target-disconnected" : "transport-closed");
    });
    return port;
  }

  function waitFor(predicate, code = "internal") {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new NativeTransportError(code));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  }

  function send(message) {
    const current = ensurePort();
    current.postMessage(message);
  }

  async function submit({ ticket, payloadText, jobNonce, digest, onStatus }) {
    if (!contract.isValidTicket(ticket)) throw new NativeTransportError("ticket-invalid");
    if (typeof payloadText !== "string" || payloadText.length === 0) {
      throw new NativeTransportError("job-empty");
    }
    const bytes = new TextEncoder().encode(payloadText);
    if (bytes.length > contract.MAX_JOB_BYTES) throw new NativeTransportError("too-large");
    const chunks = contract.chunkJobPayload(payloadText);
    if (chunks.length === 0 || chunks.length > contract.MAX_CHUNKS) {
      throw new NativeTransportError("too-large");
    }
    statusListener = typeof onStatus === "function" ? onStatus : null;
    send({
      type: "hello",
      protocol: contract.PROTOCOL_VERSION,
      mode: "cookie-import",
      extensionVersion: globalThis.chrome?.runtime?.getManifest?.().version || "unknown",
    });
    const hello = await waitFor((m) => m.type === "hello-ok" || m.type === "error", "protocol-mismatch");
    if (hello.type === "error") throw new NativeTransportError(hello.code || "internal");

    send({
      type: "begin",
      jobNonce,
      ticket,
      jobDigest: digest,
      totalBytes: bytes.length,
      chunkCount: chunks.length,
    });
    const ready = await waitFor(
      (m) => m.type === "ready" || m.type === "error",
      "target-not-running",
    );
    if (ready.type === "error") throw new NativeTransportError(ready.code || "internal");

    for (let index = 0; index < chunks.length; index += 1) {
      send({ type: "chunk", jobNonce, index, data: chunks[index] });
    }
    send({ type: "commit", jobNonce });
    const accepted = await waitFor((m) => m.type === "accepted" || m.type === "error", "timeout");
    if (accepted.type === "error") throw new NativeTransportError(accepted.code || "internal");
    return {
      jobId: accepted.jobId,
      state: accepted.state,
      totals: accepted.totals,
      targetNative: accepted.native === true,
      targetAuthorization: accepted.authorization || null,
    };
  }

  async function cancel(jobNonce) {
    send({ type: "cancel", jobNonce });
    const res = await waitFor((m) => m.type === "cancel-ok" || m.type === "error", "timeout");
    if (res.type === "error") throw new NativeTransportError(res.code || "internal");
    return { ok: true, state: res.state || "cancelling" };
  }

  function close() {
    closed = true;
    statusListener = null;
    failAll("transport-closed");
    if (port) {
      try {
        port.postMessage({ type: "close" });
      } catch {
        // ignored: port already gone
      }
      try {
        port.disconnect();
      } catch {
        // ignored: port already gone
      }
      port = null;
    }
  }

  return { submit, cancel, close };
}
