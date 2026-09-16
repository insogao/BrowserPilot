// 单测 register-host-mac.mjs：目标发现、幂等、安全拒绝、自定义 user-data-dir、注销与 CLI。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOST_NAME,
  WRAPPER_MARKER,
  browserTargets,
  extensionIdFromRepo,
  parseArgs,
  registerHost,
  registeredIdFromHostManifest,
  unregisterHost,
} from "./register-host-mac.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_EXTENSION_ID = "nnollghpaggbcdkkgoieneffnlijinio";
const ORIGIN = "chrome-extension://" + FIXED_EXTENSION_ID + "/";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log("PASS | " + name);
  } else {
    failed++;
    console.log("FAIL | " + name + (detail ? " :: " + detail : ""));
  }
}

const tempDirs = [];
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败，避免掩盖测试结果
    }
  }
}
process.on("exit", cleanup);

function makeHome(browsers = ["Google/Chrome", "Google/ChromeForTesting", "Google/Chrome for Testing", "Chromium", "BraveSoftware/Brave-Browser"]) {
  const home = temp("browserpilot-register-home-");
  for (const relative of browsers) {
    fs.mkdirSync(path.join(home, "Library", "Application Support", relative), { recursive: true });
  }
  return home;
}

function makeRepo({ wrapper } = {}) {
  const repo = temp("browserpilot register repo ");
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(repo, "manifest.json"));
  fs.mkdirSync(path.join(repo, "native-host"), { recursive: true });
  fs.copyFileSync(path.join(root, "native-host", "host.js"), path.join(repo, "native-host", "host.js"));
  fs.copyFileSync(path.join(root, "native-host", "host.manifest.json"), path.join(repo, "native-host", "host.manifest.json"));
  if (wrapper !== undefined) {
    fs.mkdirSync(path.join(repo, "native-host", "dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "native-host", "dist", "host-mac.sh"), wrapper);
  }
  return repo;
}

function support(home) {
  return path.join(home, "Library", "Application Support");
}
function nativeDir(home, relative) {
  return path.join(support(home), relative, "NativeMessagingHosts");
}
function manifestFile(dir) {
  return path.join(dir, HOST_NAME + ".json");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const noop = () => {};

// 1. 扩展 ID 固定且与 host.manifest.json 一致。
check("extensionIdFromRepo 推导固定扩展 ID", extensionIdFromRepo(root) === FIXED_EXTENSION_ID, extensionIdFromRepo(root));
check("host.manifest.json 的 origins 与推导一致", registeredIdFromHostManifest(root) === FIXED_EXTENSION_ID);

// 2. 目标发现：Chrome for Testing 两种产品目录都覆盖，未安装的浏览器不注册。
{
  const home = makeHome();
  const discovered = browserTargets(home);
  const labels = discovered.map(([label]) => label);
  const dirs = discovered.map(([, dir]) => dir);
  check("发现 Google Chrome", dirs.includes(path.join(support(home), "Google", "Chrome", "NativeMessagingHosts")));
  check("发现官方 Chrome for Testing", dirs.includes(path.join(support(home), "Google", "ChromeForTesting", "NativeMessagingHosts")));
  check("发现品牌化 Chrome for Testing 产品目录", dirs.includes(path.join(support(home), "Google", "Chrome for Testing", "NativeMessagingHosts")));
  check("发现 Chromium 与 Brave", labels.includes("Chromium") && labels.includes("Brave Browser"));
  check("未安装的 Edge 不注册", !labels.includes("Microsoft Edge"));

  const empty = makeHome([]);
  const fallback = browserTargets(empty);
  check("无任何浏览器目录时回退 Chrome", fallback.length === 1 && fallback[0][0] === "Google Chrome");
}

// 3. 注册：manifest / wrapper 路径、扩展 ID、node 引用与可执行位。
{
  const home = makeHome();
  const repo = makeRepo();
  const wrapperPath = path.join(repo, "native-host", "dist", "host-mac.sh");
  const hostEntry = path.join(repo, "native-host", "host.js");
  const result = registerHost({ root: repo, home, nodePath: "/opt/fake node/bin/node", log: noop });
  const files = [
    manifestFile(nativeDir(home, "Google/Chrome")),
    manifestFile(nativeDir(home, "Google/ChromeForTesting")),
    manifestFile(nativeDir(home, "Google/Chrome for Testing")),
    manifestFile(nativeDir(home, "Chromium")),
    manifestFile(nativeDir(home, "BraveSoftware/Brave-Browser")),
  ];
  check("register 返回固定扩展 ID", result.extensionId === FIXED_EXTENSION_ID);
  check("全部发现目标均写入 manifest", files.every((file) => fs.existsSync(file)));
  const first = readJson(files[0]);
  check(
    "manifest 字段正确",
    first.name === HOST_NAME &&
      first.description === "BrowserPilot native messaging host" &&
      first.type === "stdio" &&
      first.path === wrapperPath &&
      JSON.stringify(first.allowed_origins) === JSON.stringify([ORIGIN]),
    JSON.stringify(first),
  );
  check("各目标 manifest 内容一致", files.every((file) => fs.readFileSync(file, "utf8") === fs.readFileSync(files[0], "utf8")));
  check("wrapper 生成且带可执行位", fs.existsSync(wrapperPath) && (fs.statSync(wrapperPath).mode & 0o111) !== 0);
  const wrapperText = fs.readFileSync(wrapperPath, "utf8");
  check("wrapper 首行为 shebang + 生成标记", wrapperText.startsWith("#!/bin/sh\n# " + WRAPPER_MARKER));
  check("wrapper 正确引用含空格的 node 与 host.js", wrapperText.includes('exec "/opt/fake node/bin/node" "' + hostEntry + '" "$@"'), wrapperText.trim());
  check("register 报告 created", result.targets.every((target) => target.status === "created") && result.wrapperStatus === "created");
}

// 4. 幂等：二次注册全部 unchanged 且字节不变。
{
  const home = makeHome();
  const repo = makeRepo();
  const wrapperPath = path.join(repo, "native-host", "dist", "host-mac.sh");
  registerHost({ root: repo, home, nodePath: "/opt/fake node/bin/node", log: noop });
  const snapshots = [manifestFile(nativeDir(home, "Google/Chrome")), manifestFile(nativeDir(home, "Google/ChromeForTesting"))].map((file) => [file, fs.readFileSync(file, "utf8")]);
  const wrapperBefore = fs.readFileSync(wrapperPath, "utf8");
  const result = registerHost({ root: repo, home, nodePath: "/opt/fake node/bin/node", log: noop });
  check("二次注册全部 unchanged", result.targets.every((target) => target.status === "unchanged") && result.wrapperStatus === "unchanged");
  check("二次注册未改任何字节", snapshots.every(([file, text]) => fs.readFileSync(file, "utf8") === text) && fs.readFileSync(wrapperPath, "utf8") === wrapperBefore);
}

// 5. 安全：非 BrowserPilot manifest 默认拒绝、不部分写入，--force 才覆盖。
{
  const home = makeHome(["Google/Chrome", "Google/ChromeForTesting"]);
  const repo = makeRepo();
  const target = manifestFile(nativeDir(home, "Google/Chrome"));
  const foreign = JSON.stringify({ name: "com.example.other", description: "other", path: "/tmp/other", type: "stdio", allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }, null, 2) + "\n";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, foreign);
  let error;
  try {
    registerHost({ root: repo, home, log: noop });
  } catch (caught) {
    error = caught;
  }
  check("非 BrowserPilot manifest 触发拒绝", Boolean(error) && /冲突/.test(error.message), error?.message);
  check("拒绝时无关 manifest 保持原样", fs.readFileSync(target, "utf8") === foreign);
  check(
    "拒绝时无部分写入",
    !fs.existsSync(manifestFile(nativeDir(home, "Google/ChromeForTesting"))) && !fs.existsSync(path.join(repo, "native-host", "dist", "host-mac.sh")),
  );
  registerHost({ root: repo, home, force: true, log: noop });
  check("--force 覆盖为本仓库 manifest", readJson(target).path === path.join(repo, "native-host", "dist", "host-mac.sh"));
}

// 6. 安全：同宿主名但属于其它扩展 ID 的 manifest 同样拒绝。
{
  const home = makeHome(["Google/Chrome"]);
  const repo = makeRepo();
  const target = manifestFile(nativeDir(home, "Google/Chrome"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ name: HOST_NAME, description: "other build", path: "/tmp/other", type: "stdio", allowed_origins: ["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"] }));
  let error;
  try {
    registerHost({ root: repo, home, log: noop });
  } catch (caught) {
    error = caught;
  }
  check("同宿主名但其它扩展 ID 也拒绝", Boolean(error) && /冲突/.test(error.message));
}

// 7. 安全：目标 wrapper 不是本脚本生成的也拒绝，且不写 manifest。
{
  const home = makeHome(["Google/Chrome"]);
  const repo = makeRepo({ wrapper: "#!/bin/sh\necho not ours\n" });
  let error;
  try {
    registerHost({ root: repo, home, log: noop });
  } catch (caught) {
    error = caught;
  }
  check("未知 wrapper 触发拒绝", Boolean(error) && /冲突/.test(error.message));
  check("拒绝时未写 manifest", !fs.existsSync(manifestFile(nativeDir(home, "Google/Chrome"))));
}

// 8. 自定义 user-data-dir：Chrome 从 <user-data-dir>/NativeMessagingHosts 查找；不存在则拒绝。
{
  const home = makeHome([]);
  const repo = makeRepo();
  const udd = path.join(temp("browserpilot user data "), "profile dir");
  fs.mkdirSync(udd, { recursive: true });
  const result = registerHost({ root: repo, home, userDataDirs: [udd, udd], log: noop });
  const customDir = path.join(udd, "NativeMessagingHosts");
  check("自定义 user-data-dir 去重后只注册一次", result.targets.filter((target) => target.dir === customDir).length === 1);
  check("manifest 落在 <user-data-dir>/NativeMessagingHosts", fs.existsSync(manifestFile(customDir)));
  check("自定义目标 manifest 与本仓库一致", readJson(manifestFile(customDir)).path === path.join(repo, "native-host", "dist", "host-mac.sh"));

  const missing = path.join(temp("browserpilot-missing-"), "nope");
  let error;
  try {
    registerHost({ root: repo, home, userDataDirs: [missing], log: noop });
  } catch (caught) {
    error = caught;
  }
  check("不存在的 user-data-dir 拒绝", Boolean(error) && /user-data-dir 不存在/.test(error.message), error?.message);
  check("拒绝时不创建 NativeMessagingHosts", !fs.existsSync(path.join(missing, "NativeMessagingHosts")));
}

// 9. 注销：只删 BrowserPilot manifest 与本脚本 wrapper，无关文件保持原样。
{
  const home = makeHome(["Google/Chrome", "Google/ChromeForTesting"]);
  const repo = makeRepo();
  registerHost({ root: repo, home, log: noop });
  const chromeFile = manifestFile(nativeDir(home, "Google/Chrome"));
  const cftFile = manifestFile(nativeDir(home, "Google/ChromeForTesting"));
  const foreign = '{ "name": "com.example.other" }\n';
  fs.writeFileSync(chromeFile, foreign);
  const result = unregisterHost({ root: repo, home, log: noop });
  check("注销删除 BrowserPilot manifest", !fs.existsSync(cftFile));
  check("注销保留无关 manifest", fs.readFileSync(chromeFile, "utf8") === foreign);
  check("注销删除 wrapper", !fs.existsSync(path.join(repo, "native-host", "dist", "host-mac.sh")));
  check("注销报告 removed/skipped", result.targets.some((target) => target.status === "removed") && result.targets.some((target) => target.status === "skipped"));
}

// 10. dry-run：只报告不落盘。
{
  const home = makeHome(["Google/Chrome"]);
  const repo = makeRepo();
  const result = registerHost({ root: repo, home, dryRun: true, log: noop });
  check("dry-run 标记与 planned 状态", result.dryRun === true && result.targets.every((target) => target.status === "created"));
  check("dry-run 不写 manifest 与 wrapper", !fs.existsSync(manifestFile(nativeDir(home, "Google/Chrome"))) && !fs.existsSync(path.join(repo, "native-host", "dist", "host-mac.sh")));
}

// 11. 参数解析。
{
  const parsed = parseArgs(["--user-data-dir=/tmp/a", "--user-data-dir", "/tmp/b c", "--force", "--dry-run", "--unregister"]);
  check("parseArgs 解析两种赋值形态与开关", parsed.unregister && parsed.force && parsed.dryRun && parsed.userDataDirs.length === 2 && parsed.userDataDirs[1] === "/tmp/b c");
  check("parseArgs --help", parseArgs(["--help"]).help === true);
  let unknown;
  try {
    parseArgs(["--nope"]);
  } catch (caught) {
    unknown = caught;
  }
  let missing;
  try {
    parseArgs(["--user-data-dir"]);
  } catch (caught) {
    missing = caught;
  }
  check("parseArgs 未知参数/缺参数报错", Boolean(unknown) && Boolean(missing));
}

// 12. CLI 端到端：复制到隔离仓库 + 隔离 HOME，注册/注销/错误参数。
{
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  const script = path.join(repo, "scripts", "register-host-mac.mjs");
  fs.copyFileSync(path.join(root, "scripts", "register-host-mac.mjs"), script);
  const home = makeHome(["Google/Chrome", "Google/ChromeForTesting"]);
  const udd = path.join(temp("browserpilot-cli-user-data-"), "profile");
  fs.mkdirSync(udd, { recursive: true });
  const env = { ...process.env, HOME: home };
  const registered = spawnSync(process.execPath, [script, "--user-data-dir", udd], { env, encoding: "utf8" });
  check("CLI 注册 exit 0", registered.status === 0, registered.stderr);
  check("CLI 输出固定扩展 ID", registered.stdout.includes('"extensionId": "' + FIXED_EXTENSION_ID + '"'));
  check("CLI 注册写入 Chrome for Testing 目录", fs.existsSync(manifestFile(nativeDir(home, "Google/ChromeForTesting"))));
  check("CLI 注册写入自定义 user-data-dir", fs.existsSync(manifestFile(path.join(udd, "NativeMessagingHosts"))));
  const unregistered = spawnSync(process.execPath, [script, "--unregister", "--user-data-dir", udd], { env, encoding: "utf8" });
  check("CLI 注销 exit 0", unregistered.status === 0, unregistered.stderr);
  check("CLI 注销移除 manifest 与 wrapper", !fs.existsSync(manifestFile(path.join(udd, "NativeMessagingHosts"))) && !fs.existsSync(path.join(repo, "native-host", "dist", "host-mac.sh")));
  const bogus = spawnSync(process.execPath, [script, "--bogus"], { env, encoding: "utf8" });
  check("CLI 未知参数 exit 1", bogus.status === 1 && bogus.stderr.includes("未知参数"));
  const help = spawnSync(process.execPath, [script, "--help"], { env, encoding: "utf8" });
  check("CLI --help exit 0 且含用法", help.status === 0 && help.stdout.includes("--user-data-dir"));
}

cleanup();
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
