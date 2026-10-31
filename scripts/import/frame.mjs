// Length-prefixed JSON framing for the local pipe between the BrowserPilot
// native host relay and the Browser CLI cookie-import target.
//
// Wire format: 4-byte little-endian unsigned length, then that many UTF-8 JSON
// bytes. The native messaging framing between Chrome and the host uses the same
// 4-byte prefix, but is handled by Chrome/host.js; this module is only for the
// host <-> target named pipe.
//
// Node-only. The Chromium target has an equivalent implementation in
// chromium/patches/proposed/034-browser-cli-cookie-import.patch.
import { MAX_FRAME_BYTES } from "./contract.mjs";

export function encodeFrame(value) {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MAX_FRAME_BYTES) {
    const err = new Error("frame too large");
    err.code = "too-large";
    throw err;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function createFrameReader(onFrame, { maxBytes = MAX_FRAME_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > maxBytes) {
        const err = new Error("frame too large");
        err.code = "too-large";
        throw err;
      }
      if (buffer.length < 4 + length) return;
      const text = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        const err = new Error("bad frame json");
        err.code = "protocol-mismatch";
        throw err;
      }
      onFrame(value);
    }
  };
}
