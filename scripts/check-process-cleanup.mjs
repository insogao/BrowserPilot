// 静态门禁：禁止“按镜像名”清理进程。
//
// 被禁模式的共同特征：不证明进程归属就开始杀，会命中用户自己的浏览器。
// 允许的做法只有两种（见 scripts/lib/test-process.mjs 与
// browsercli/tests/tools/win_job.py）：
//   1. Job Object（Windows）——句柄即所有权，关闭句柄只结束该 job 的进程树；
//   2. 验证式 PID 清理——先核验 PID + 创建时间 + 命令行 marker + 可执行路径，
//      再按 PID 清理。
//
// 用法：
//   node scripts/check-process-cleanup.mjs
//   node scripts/check-process-cleanup.mjs --root ../browsercli/tests
//   node scripts/check-process-cleanup.mjs --json
//
// 退出码：0 = 干净，1 = 发现违规，2 = 用法错误。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), "..");
const SCAN_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".py", ".sh", ".bash", ".ps1", ".cmd", ".bat"]);
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".e2e-tmp",
  "build-logs",
  "coverage",
  ".cache",
  ".tmp",
  "chromium", // Chromium checkout: not ours to police
]);
// 行内豁免（必须写清理由）：// process-cleanup-allow: <reason>
const ALLOW_MARKER = "process-cleanup-allow";

// 每条规则只描述“无法证明归属”的清理方式。
const RULES = [
  {
    name: "taskkill-image-name",
    // taskkill 的 /IM（按镜像名）会匹配机器上所有同名进程。
    re: /\btaskkill(?:\.exe)?\b[^\r\n]*?\s\/IM\b/i,
    why: "按镜像名 taskkill 会误杀用户浏览器；只允许核验身份后按 PID 清理",
  },
  {
    name: "stop-process-name",
    re: /\bStop-Process\b[^\r\n]*-Name\b/i,
    why: "Stop-Process -Name 按进程名清理；只允许验证式 -Id",
  },
  {
    name: "get-process-pipe-stop",
    re: /\bGet-Process\b[^\r\n|]*\|\s*Stop-Process\b/i,
    why: "Get-Process | Stop-Process 按名称批量清理",
  },
  {
    name: "pkill-browser",
    re: /\bpkill\b[^\r\n]*(?:chrome|chromium|backlight|browser-?cli|electron)/i,
    why: "pkill 按模式匹配浏览器进程，无法证明归属",
  },
  {
    name: "killall-browser",
    re: /\bkillall\b[^\r\n]*(?:chrome|chromium|backlight|browser-?cli|electron)/i,
    why: "killall 按名称清理浏览器进程，无法证明归属",
  },
  {
    name: "pgrep-xargs-kill",
    re: /\b(?:pgrep|ps)\b[^\r\n]*\|\s*(?:xargs\s+)?kill\b/i,
    why: "按名称管道到 kill；只允许核验身份后按 PID 清理",
  },
  {
    name: "wmic-process-delete",
    re: /\bwmic\b[^\r\n]*\bdelete\b/i,
    why: "wmic process delete 按查询条件批量终止进程",
  },
];

function parseArgs(argv) {
  const roots = [];
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法: node scripts/check-process-cleanup.mjs [--root DIR]... [--json]",
          "",
          "静态扫描源码中的进程清理写法，禁止无法证明归属的按名称/镜像清理。",
          "  --root DIR  追加扫描根目录（可重复，默认扫描本仓库根）",
          "  --json      以 JSON 输出结果",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[++index];
      if (!value) {
        console.error("check-process-cleanup: --root 需要参数");
        process.exit(2);
      }
      roots.push(path.resolve(value));
      continue;
    }
    console.error("check-process-cleanup: 未知参数 " + arg);
    process.exit(2);
  }
  return { roots: roots.length ? roots : [DEFAULT_ROOT], json };
}

function walk(dir, files, errors) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    errors.push({ file: dir, error: String(error.message) });
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name.toLowerCase())) continue;
      walk(full, files, errors);
      continue;
    }
    if (!entry.isFile()) continue;
    if (path.resolve(full) === path.resolve(SELF)) continue; // 本门禁自身的规则文本
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(full);
  }
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function main() {
  const { roots, json } = parseArgs(process.argv.slice(2));
  const files = [];
  const errors = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.error("check-process-cleanup: 扫描根不存在: " + root);
      process.exit(2);
    }
    walk(root, files, errors);
  }

  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      errors.push({ file, error: String(error.message) });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.includes(ALLOW_MARKER)) continue;
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          const root = roots.find((candidate) => path.resolve(file).startsWith(path.resolve(candidate) + path.sep))
            || roots[0];
          violations.push({
            rule: rule.name,
            why: rule.why,
            file,
            relative: relative(root, file),
            line: index + 1,
            text: line.trim().slice(0, 240),
          });
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ roots, filesScanned: files.length, violations, errors }, null, 2));
  } else {
    for (const violation of violations) {
      console.log(
        "VIOLATION " + violation.relative + ":" + violation.line +
          " [" + violation.rule + "] " + violation.text,
      );
      console.log("          " + violation.why);
    }
    for (const error of errors) {
      console.log("WARN 无法读取 " + error.file + ": " + error.error);
    }
    console.log(
      "process cleanup gate: " + (violations.length ? "FAIL" : "OK") +
        " (" + files.length + " file(s) scanned, " + violations.length + " violation(s))",
    );
  }

  if (errors.length) return 2;
  return violations.length ? 1 : 0;
}

process.exit(main());
