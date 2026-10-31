// Import-only relay for the BrowserPilot native messaging host.
//
// The host process is launched by the source extension with connectNative().
// In import mode it does not open a TCP listener, does not create auth.json or
// session files, and does not forward arbitrary commands. It:
//
//   1. accepts a one-time 160-bit ticket from the extension;
//   2. finds the matching Browser CLI session descriptor by ticket hash;
//   3. connects out to the target's named pipe / unix socket;
//   4. streams the job in bounded chunks and forwards count-only status back.
//
// Cookie values and tickets are held only in this process's memory and in the
// pipe frames. They are never logged and never written to disk.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as contract from "../scripts/import/contract.mjs";
import { createFrameReader, encodeFrame } from "../scripts/import/frame.mjs";

const CONNECT_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 8_000;
const ACCEPT_TIMEOUT_MS = 20_000;

export function defaultSessionDir() {
  if (process.env.BROWSER_CLI_IMPORT_SESSION_DIR) {
    return path.resolve(process.env.BROWSER_CLI_IMPORT_SESSION_DIR);
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "BrowserCLI", "import", "sessions");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BrowserCLI", "import", "sessions");
  }
  return path.join(
    process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"),
    "browser-cli-import",
    "sessions",
  );
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user/session.
    return err && err.code === "EPERM";
  }
}

function readDescriptorFiles(dir, { fsImpl = fs } = {}) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.slice(0, contract.MAX_DESCRIPTOR_FILES)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.size > contract.MAX_DESCRIPTOR_BYTES) continue;
      files.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore files that disappear or cannot be inspected.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function createImportRelay({
  send,
  log = () => {},
  sessionDir = defaultSessionDir(),
  now = () => Date.now(),
  connect = (options) => net.connect(options),
  fsImpl = fs,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  acceptTimeoutMs = ACCEPT_TIMEOUT_MS,
} = {}) {
  if (typeof send !== "function") throw new Error("send is required");
  const state = {
    phase: "hello",
    closed: false,
    hello: null,
    jobNonce: null,
    ticket: null,
    jobDigest: null,
    totalBytes: 0,
    chunkCount: 0,
    chunks: [],
    nextChunk: 0,
    socket: null,
    targetReader: null,
    targetReady: null,
    targetReject: null,
    targetInfo: null,
    accepted: null,
    terminal: false,
    failures: [],
    attempts: [],
    blockedUntil: 0,
  };

  function emit(message) {
    if (state.closed && message.type !== "error") return;
    try {
      send(message);
    } catch {
      close();
    }
  }

  function logSafe(line) {
    try {
      log(String(line).replace(/[\r\n]+/g, " "));
    } catch {
      // logging must never break the relay
    }
  }

  function blocked() {
    const current = now();
    if (state.blockedUntil > current) return true;
    state.failures = state.failures.filter((at) => current - at < contract.TICKET_FAILURE_WINDOW_MS);
    if (state.failures.length >= contract.MAX_TICKET_FAILURES) {
      state.blockedUntil = current + contract.RATE_LIMIT_BLOCK_MS;
      return true;
    }
    return false;
  }

  function recordFailure() {
    state.failures.push(now());
  }

  function fail(code, { fatal = true } = {}) {
    if (state.closed) return;
    if (fatal) recordFailure();
    if (blocked()) {
      emit({ type: "error", code: "rate-limited" });
      state.blockedUntil = now() + contract.RATE_LIMIT_BLOCK_MS;
      closeSocket();
      state.closed = true;
      return;
    }
    emit({ type: "error", code });
    if (fatal) close();
  }

  function clearJob() {
    state.chunks = [];
    state.nextChunk = 0;
    state.jobNonce = null;
    state.ticket = null;
    state.jobDigest = null;
    state.totalBytes = 0;
    state.chunkCount = 0;
    state.accepted = null;
    state.targetReady = null;
    state.targetReject = null;
    state.targetInfo = null;
  }

  function closeSocket() {
    if (state.socket) {
      try {
        state.socket.destroy();
      } catch {
        // ignored
      }
    }
    state.socket = null;
    state.targetReader = null;
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    state.terminal = true;
    clearJob();
    closeSocket();
  }

  function sendToTarget(message) {
    if (!state.socket || state.socket.destroyed) {
      const err = new Error("target-disconnected");
      err.code = "target-disconnected";
      throw err;
    }
    state.socket.write(encodeFrame(message));
  }

  function onTargetFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ready") {
      state.targetInfo = {
        sessionId: typeof frame.sessionId === "string" ? frame.sessionId : "",
        targetPid: Number.isInteger(frame.targetPid) ? frame.targetPid : null,
        targetProduct: typeof frame.targetProduct === "string" ? frame.targetProduct : "Browser CLI",
        targetVersion: typeof frame.targetVersion === "string" ? frame.targetVersion : "",
        native: frame.native === true,
        transport: "named-pipe",
      };
      if (state.targetReady) {
        const resolve = state.targetReady;
        state.targetReady = null;
        state.targetReject = null;
        resolve(state.targetInfo);
      }
      return;
    }
    if (frame.type === "accepted") {
      state.accepted = {
        jobId: typeof frame.jobId === "string" ? frame.jobId : "",
        state: typeof frame.state === "string" ? frame.state : "pending",
        totals: {
          cookies: Number(frame.totals?.cookies) || 0,
          domains: Number(frame.totals?.domains) || 0,
          selectedDomains: Number(frame.totals?.selectedDomains) || 0,
          sessionCookies: Number(frame.totals?.sessionCookies) || 0,
        },
        native: frame.native === true,
        authorization: frame.authorization || null,
      };
      logSafe(
        `import relay: accepted job ${state.accepted.jobId} ` +
          `(${state.accepted.totals.cookies} cookies / ${state.accepted.totals.domains} domains)`,
      );
      emit({ type: "accepted", ...state.accepted });
      return;
    }
    if (frame.type === "status") {
      const view = contract.sanitizePublicJobView(frame.view);
      if (!view) {
        fail("protocol-mismatch");
        return;
      }
      if (contract.TERMINAL_JOB_STATES.has(view.state)) state.terminal = true;
      emit({ type: "status", view });
      return;
    }
    if (frame.type === "cancel-ok") {
      emit({ type: "cancel-ok", state: typeof frame.state === "string" ? frame.state : "cancelling" });
      return;
    }
    if (frame.type === "error") {
      const code = contract.SESSION_ERROR_CODES.has(frame.code) ? frame.code : "internal";
      if (code === "ticket-consumed" || code === "ticket-expired" || code === "ticket-invalid") {
        recordFailure();
      }
      if (state.targetReject) {
        const reject = state.targetReject;
        state.targetReady = null;
        state.targetReject = null;
        reject(Object.assign(new Error(code), { code }));
        return;
      }
      emit({ type: "error", code });
      if (code === "ticket-consumed" || code === "ticket-expired" || code === "rate-limited") {
        close();
      }
      return;
    }
  }

  async function findTargetDescriptor(ticket) {
    for (const { file } of readDescriptorFiles(sessionDir, { fsImpl })) {
      let descriptor;
      try {
        const text = fsImpl.readFileSync(file, "utf8");
        descriptor = JSON.parse(text);
      } catch {
        continue;
      }
      const checked = contract.validateSessionDescriptor(descriptor, { now: now() });
      if (!checked.ok) continue;
      if (!(await contract.ticketMatchesHash(ticket, descriptor.ticketHash))) continue;
      if (!pidAlive(descriptor.targetPid)) continue;
      return descriptor;
    }
    return null;
  }

  async function openTarget(ticket, jobNonce, jobDigest, totalBytes, chunkCount) {
    const descriptor = await findTargetDescriptor(ticket);
    if (!descriptor) {
      const err = new Error("target-not-running");
      err.code = "target-not-running";
      throw err;
    }
    const targetPath = descriptor.transport === "named-pipe" ? descriptor.pipeName : descriptor.socketPath;
    if (!targetPath) {
      const err = new Error("target-not-running");
      err.code = "target-not-running";
      throw err;
    }
    await new Promise((resolve, reject) => {
      const socket = connect({ path: targetPath });
      state.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(Object.assign(new Error("target-not-running"), { code: "target-not-running" }));
      }, connectTimeoutMs);
      socket.setNoDelay?.(true);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(Object.assign(new Error("target-not-running"), { code: "target-not-running" }));
          return;
        }
        if (state.targetReject) {
          const rejectReady = state.targetReject;
          state.targetReady = null;
          state.targetReject = null;
          rejectReady(Object.assign(new Error("target-disconnected"), { code: "target-disconnected" }));
          return;
        }
        if (!state.terminal) emit({ type: "error", code: "target-disconnected" });
        closeSocket();
      });
      socket.on("close", () => {
        if (state.targetReject) {
          const rejectReady = state.targetReject;
          state.targetReady = null;
          state.targetReject = null;
          rejectReady(Object.assign(new Error("target-disconnected"), { code: "target-disconnected" }));
          return;
        }
        if (!state.terminal && !state.closed) {
          emit({ type: "error", code: "target-disconnected" });
          close();
        }
      });
      state.targetReader = createFrameReader(onTargetFrame);
      socket.on("data", (chunk) => {
        try {
          state.targetReader(chunk);
        } catch {
          fail("protocol-mismatch");
        }
      });
    });

    const ready = new Promise((resolve, reject) => {
      state.targetReady = resolve;
      state.targetReject = reject;
      setTimeout(() => {
        if (state.targetReject) {
          state.targetReady = null;
          state.targetReject = null;
          reject(Object.assign(new Error("target-not-running"), { code: "target-not-running" }));
        }
      }, readyTimeoutMs);
    });
    sendToTarget({
      type: "hello",
      protocol: contract.PROTOCOL_VERSION,
      ticket: contract.normalizeTicket(ticket),
      hostPid: process.pid,
      jobNonce,
      jobDigest,
      totalBytes,
      chunkCount,
    });
    return ready;
  }

  async function handleHello(message) {
    if (state.phase !== "hello") return fail("protocol-mismatch");
    if (message.protocol !== contract.PROTOCOL_VERSION || message.mode !== "cookie-import") {
      return fail("protocol-mismatch");
    }
    state.phase = "ready";
    emit({
      type: "hello-ok",
      protocol: contract.PROTOCOL_VERSION,
      host: "browserpilot-import-relay",
      maxFrameBytes: contract.MAX_FRAME_BYTES,
      maxJobBytes: contract.MAX_JOB_BYTES,
      ticketTtlMs: contract.TICKET_TTL_MS,
    });
  }

  async function handleBegin(message) {
    if (state.phase !== "ready") return fail("protocol-mismatch", { fatal: false });
    if (blocked()) return fail("rate-limited");
    const current = now();
    state.attempts = state.attempts.filter((at) => current - at < 60 * 60 * 1000);
    if (state.attempts.length >= contract.MAX_SESSIONS_PER_HOUR) {
      return fail("rate-limited");
    }
    state.attempts.push(current);

    const ticket = String(message.ticket || "");
    if (!contract.isValidTicket(ticket)) {
      recordFailure();
      // Keep the relay usable so the failure counter can reach the limit; the
      // extension treats ticket-invalid as fatal and opens a fresh host on
      // retry.
      return fail("ticket-invalid", { fatal: false });
    }
    if (typeof message.jobNonce !== "string" || !/^[a-f0-9]{32}$/.test(message.jobNonce)) {
      return fail("protocol-mismatch");
    }
    if (typeof message.jobDigest !== "string" || !/^[a-f0-9]{64}$/.test(message.jobDigest)) {
      return fail("protocol-mismatch");
    }
    const totalBytes = Number(message.totalBytes);
    const chunkCount = Number(message.chunkCount);
    if (
      !Number.isInteger(totalBytes) ||
      totalBytes <= 0 ||
      totalBytes > contract.MAX_JOB_BYTES ||
      !Number.isInteger(chunkCount) ||
      chunkCount <= 0 ||
      chunkCount > contract.MAX_CHUNKS
    ) {
      return fail("too-large");
    }
    state.jobNonce = message.jobNonce;
    state.ticket = contract.normalizeTicket(ticket);
    state.jobDigest = message.jobDigest;
    state.totalBytes = totalBytes;
    state.chunkCount = chunkCount;
    state.chunks = [];
    state.nextChunk = 0;
    try {
      const info = await openTarget(ticket, message.jobNonce, message.jobDigest, totalBytes, chunkCount);
      state.phase = "chunks";
      emit({
        type: "ready",
        protocol: contract.PROTOCOL_VERSION,
        jobNonce: state.jobNonce,
        target: {
          product: info.targetProduct,
          version: info.targetVersion,
          native: info.native === true,
          transport: "named-pipe",
        },
        targetNative: info.native === true,
      });
    } catch (err) {
      const code = err && contract.SESSION_ERROR_CODES.has(err.code) ? err.code : "target-disconnected";
      recordFailure();
      return fail(code);
    }
  }

  function handleChunk(message) {
    if (state.phase !== "chunks") return;
    if (message.jobNonce !== state.jobNonce) return fail("protocol-mismatch");
    if (!Number.isInteger(message.index) || message.index !== state.nextChunk) {
      return fail("chunk-missing");
    }
    if (typeof message.data !== "string" || message.data.length > contract.MAX_FRAME_BYTES) {
      return fail("too-large");
    }
    state.chunks.push(message.data);
    state.nextChunk += 1;
  }

  async function handleCommit(message) {
    if (state.phase !== "chunks") return fail("protocol-mismatch");
    if (message.jobNonce !== state.jobNonce) return fail("protocol-mismatch");
    if (state.chunks.length !== state.chunkCount) return fail("chunk-missing");
    let bytes;
    try {
      bytes = contract.assembleChunks(state.chunks, { maxBytes: state.totalBytes });
    } catch (err) {
      return fail(err && err.code ? err.code : "too-large");
    }
    if (bytes.length !== state.totalBytes) return fail("chunk-missing");
    const digest = await contract.sha256Hex(bytes);
    if (!contract.safeEqualString(digest, state.jobDigest)) {
      return fail("job-digest-mismatch");
    }
    let payload;
    try {
      payload = JSON.parse(contract.decodeUtf8(bytes));
    } catch {
      return fail("protocol-mismatch");
    }
    const checked = await contract.validateImportRequest(payload, { now: now() });
    if (!checked.ok) {
      // Never echo field paths that could contain user data; the target will
      // re-validate anyway. Report a single stable code.
      return fail("protocol-mismatch");
    }
    if (checked.normalized.jobNonce !== state.jobNonce) return fail("job-binding-mismatch");
    state.phase = "committed";
    try {
      sendToTarget({
        type: "job-begin",
        jobNonce: state.jobNonce,
        jobDigest: state.jobDigest,
        totalBytes: state.totalBytes,
        chunkCount: state.chunkCount,
      });
      for (let index = 0; index < state.chunks.length; index += 1) {
        sendToTarget({ type: "job-chunk", jobNonce: state.jobNonce, index, data: state.chunks[index] });
      }
      sendToTarget({ type: "job-commit", jobNonce: state.jobNonce });
    } catch (err) {
      return fail("target-disconnected");
    }
    // The target streams accepted/status frames on its own. Keep the job
    // payload until the target is terminal, then release it.
    state.chunks = [];
  }

  async function handleCancel(message) {
    if (!state.jobNonce || (message && message.jobNonce && message.jobNonce !== state.jobNonce)) {
      return emit({ type: "error", code: "job-binding-mismatch" });
    }
    try {
      sendToTarget({ type: "cancel", jobNonce: state.jobNonce });
    } catch {
      emit({ type: "error", code: "target-disconnected" });
      close();
    }
  }

  async function handle(message) {
    if (!message || typeof message !== "object") return;
    if (state.closed) return;
    if (message.type === "hello") return handleHello(message);
    if (state.phase === "hello") return fail("protocol-mismatch");
    if (message.type === "begin") return handleBegin(message);
    if (message.type === "chunk") return handleChunk(message);
    if (message.type === "commit") return handleCommit(message);
    if (message.type === "cancel") return handleCancel(message);
    if (message.type === "close") return close();
    return fail("protocol-mismatch");
  }

  return {
    handle,
    close,
    state,
    onTargetFrameForTest: onTargetFrame,
  };
}

// Exported for unit tests; not used by the product host.
export function readSessionDescriptorsForTest(dir, { fsImpl = fs } = {}) {
  return readDescriptorFiles(dir, { fsImpl });
}
