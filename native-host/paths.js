// host 与 client 共享的本机状态路径。
// session 文件（<port>.json，含 port/authToken/pid/updatedAt）是运行中 host 的唯一权威发现源，
// client 优先读它，避免与硬编码端口扫描/构建期 auth.json 产生第二真源。
import os from "node:os";
import path from "node:path";

export function sessionDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "BrowserPilot", "sessions");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BrowserPilot", "sessions");
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "BrowserPilot",
    "sessions",
  );
}
