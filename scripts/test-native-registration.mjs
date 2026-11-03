// Windows native messaging 注册/回滚自动化测试（无 GUI、无浏览器依赖）。
//
// 覆盖：
//   - 模板不含机器绝对路径；扩展 ID 由 manifest.json key 推导；
//   - register.ps1 只写 Chrome、-IncludeEdge 才写 Edge、绝不写 HKLM；
//   - 修改前写 backup（host 名/旧值/时间/备注），unregister.ps1 按备份原样恢复；
//   - 无备份时删除本 host 键；重复注销幂等；
//   - fail closed：exe 不存在 / 扩展 ID 不一致 / 模板 origin 非法 / 非 HKCU 根全部拒绝且不改注册表；
//   - 不触碰同名邻居 host（com.egolite.browseragent）。
//
// 注册表隔离：所有写入都落在 HKCU\Software\BrowserPilotTests\<random> 下，测试结束递归删除。
// 运行：node scripts/test-native-registration.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registerPs1 = path.join(root, "native-host", "register.ps1");
const unregisterPs1 = path.join(root, "native-host", "unregister.ps1");
const templateFile = path.join(root, "native-host", "host.manifest.template.json");
const HOST_NAME = "com.browserpilot.browseragent";
const NEIGHBOR_HOST = "com.egolite.browseragent";
const FIXED_EXTENSION_ID = "nnollghpaggbcdkkgoieneffnlijinio";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log("PASS | " + name);
  } else {
    failed++;
    failures.push(name);
    console.log("FAIL | " + name + (detail ? " :: " + String(detail).slice(0, 800) : ""));
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
      // best effort
    }
  }
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function powershell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
}
function regGet(keyPath) {
  const script =
    "$k=" + psQuote(keyPath) + ";" +
    "if (Test-Path -LiteralPath $k) { $i=Get-Item -LiteralPath $k; if (@($i.GetValueNames()) -contains '') { $v=$i.GetValue('', $null); if ($null -eq $v) { '<empty>' } else { [string]$v } } else { '<no-default>' } } else { '<missing>' }";
  const result = powershell(script);
  if (result.status !== 0) throw new Error("regGet failed: " + result.stderr);
  return result.stdout.trim();
}
function regSetDefault(keyPath, value) {
  const subPath = keyPath.replace(/^HKCU:\\/i, "");
  const script =
    "$sub=" + psQuote(subPath) + ";" +
    "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub);" +
    "try { $k.SetValue('', " + psQuote(value) + ", [Microsoft.Win32.RegistryValueKind]::String) } finally { $k.Close() }";
  const result = powershell(script);
  if (result.status !== 0) throw new Error("regSetDefault failed: " + result.stderr);
}
function regExists(keyPath) {
  const result = powershell("if (Test-Path -LiteralPath " + psQuote(keyPath) + ") { 'yes' } else { 'no' }");
  return result.stdout.trim() === "yes";
}
function regDeleteTree(keyPath) {
  powershell("if (Test-Path -LiteralPath " + psQuote(keyPath) + ") { Remove-Item -LiteralPath " + psQuote(keyPath) + " -Recurse -Force }");
}
function regDeleteEmptyParent(keyPath) {
  const parent = keyPath.replace(/\\[^\\]+$/, "");
  powershell(
    "$p=" + psQuote(parent) + ";" +
    "if (Test-Path -LiteralPath $p) { $children=@(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue); if ($children.Count -eq 0) { Remove-Item -LiteralPath $p -Force } }",
  );
}

function runScript(script, args) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  let json;
  const lastLine = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    json = lastLine ? JSON.parse(lastLine) : undefined;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const isWindows = process.platform === "win32";
if (!isWindows) {
  console.log("SKIP | native messaging registration tests require Windows");
  process.exit(0);
}

// 隔离的注册表根：所有键都在 HKCU\Software\BrowserPilotTests\<random> 下，退出时删除。
const testRootName = "BrowserPilotTests\\" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const registryRoot = "HKCU:\\Software\\" + testRootName;
const chromeKey = registryRoot + "\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME;
const edgeKey = registryRoot + "\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME;
const neighborKey = registryRoot + "\\Google\\Chrome\\NativeMessagingHosts\\" + NEIGHBOR_HOST;

process.on("exit", () => {
  try {
    regDeleteTree(registryRoot);
    regDeleteEmptyParent(registryRoot);
  } catch {
    // best effort
  }
  cleanup();
});

try {
  // ---------- 1. 模板 / 扩展 ID ----------
  check("host manifest 模板存在", fs.existsSync(templateFile));
  const template = readJson(templateFile);
  check(
    "模板只含占位符，不含机器绝对路径",
    template.name === HOST_NAME &&
      template.type === "stdio" &&
      template.path === "__HOST_EXE__" &&
      JSON.stringify(template.allowed_origins) === JSON.stringify(["chrome-extension://__EXTENSION_ID__/"]) &&
      !/^[A-Za-z]:[\\/]/.test(template.path),
    JSON.stringify(template),
  );
  {
    const repoManifest = readJson(path.join(root, "manifest.json"));
    const hex = crypto.createHash("sha256").update(Buffer.from(repoManifest.key, "base64")).digest("hex");
    const derived = [...hex.slice(0, 32)].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");
    check("manifest.json key 推导出固定扩展 ID", derived === FIXED_EXTENSION_ID, derived);
  }

  // ---------- 2. 测试素材 ----------
  const work = temp("browserpilot-native-reg-");
  const fakeExe = path.join(work, "browserpilot-host-test.exe");
  fs.writeFileSync(fakeExe, "not a real PE, registration only checks existence");
  const manifestPath = path.join(work, "generated", "host.manifest.json");
  const backupDir = path.join(work, "backup");
  const oldManifestPath = path.join(work, "old", "host.manifest.json");
  fs.mkdirSync(path.dirname(oldManifestPath), { recursive: true });
  fs.writeFileSync(
    oldManifestPath,
    JSON.stringify({ name: HOST_NAME, description: "old", path: "C:\\old\\browserpilot-host.exe", type: "stdio", allowed_origins: ["chrome-extension://" + FIXED_EXTENSION_ID + "/"] }, null, 2),
  );

  // 邻居 host 哨兵：任何 register/unregister 都不得触碰。
  regSetDefault(neighborKey, "C:\\neighbor\\host.manifest.json");

  // 预置旧值，模拟“旧环境已注册”。
  regSetDefault(chromeKey, oldManifestPath);

  // ---------- 3. DryRun：只读不写 ----------
  {
    const result = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
      "-DryRun",
    ]);
    check("DryRun 退出码 0", result.status === 0, result.stderr);
    check("DryRun 报告 dryRun/extensionId/hostPath", result.json?.dryRun === true && result.json?.extensionId === FIXED_EXTENSION_ID && result.json?.hostPath === fakeExe, result.stdout);
    check("DryRun 不写 manifest", !fs.existsSync(manifestPath));
    check("DryRun 不写 backup", !fs.existsSync(backupDir));
    check("DryRun 不改注册表", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));
  }

  // ---------- 4. 注册：备份旧值、BOM-free、只写 Chrome ----------
  let firstBackupFile;
  {
    const result = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
    ]);
    check("注册退出码 0", result.status === 0, result.stderr);
    check("注册返回 backupFile", typeof result.json?.backupFile === "string" && fs.existsSync(result.json.backupFile), result.stdout);
    firstBackupFile = path.join(work, "first-backup-copy.json");
    fs.copyFileSync(result.json.backupFile, firstBackupFile);
    check("注册表默认值指向生成的 manifest", regGet(chromeKey) === manifestPath, regGet(chromeKey));
    check("未加 -IncludeEdge 时不写 Edge", !regExists(edgeKey));
    check("邻居 host 未被触碰", regGet(neighborKey) === "C:\\neighbor\\host.manifest.json", regGet(neighborKey));

    check("manifest 已生成", fs.existsSync(manifestPath));
    const bytes = fs.readFileSync(manifestPath);
    check("manifest 是 BOM-free UTF-8", !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
    const manifest = JSON.parse(bytes.toString("utf8"));
    check(
      "manifest 字段与扩展 ID 一致",
      manifest.name === HOST_NAME &&
        manifest.type === "stdio" &&
        manifest.path === fakeExe &&
        JSON.stringify(manifest.allowed_origins) === JSON.stringify(["chrome-extension://" + FIXED_EXTENSION_ID + "/"]),
      JSON.stringify(manifest),
    );

    const backup = readJson(firstBackupFile);
    check("backup 含 host 名/时间/备注", backup.hostName === HOST_NAME && typeof backup.createdAt === "string" && typeof backup.note === "string" && Number.isFinite(backup.createdAtUnixMs));
    check("backup 记录了旧默认值", backup.targets?.length === 1 && backup.targets[0].previousDefault === oldManifestPath, JSON.stringify(backup.targets));
    check("backup 记录了旧 manifest 摘要", backup.targets[0].previousManifest?.name === HOST_NAME, JSON.stringify(backup.targets[0].previousManifest));
    check("backup 文件中不含 BOM", (() => { const b = fs.readFileSync(firstBackupFile); return !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf); })());
  }

  // ---------- 5. 二次注册 + IncludeEdge：Edge 键出现，备份记录新旧值 ----------
  let secondBackupFile;
  {
    const result = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
      "-IncludeEdge",
    ]);
    check("IncludeEdge 注册退出码 0", result.status === 0, result.stderr);
    secondBackupFile = result.json?.backupFile;
    check("IncludeEdge 写入 Edge 键", regGet(edgeKey) === manifestPath, regGet(edgeKey));
    check("Edge 也指向同一个 manifest", regGet(edgeKey) === regGet(chromeKey));
    const backup = readJson(secondBackupFile);
    const chromeTarget = backup.targets.find((target) => target.browser === "chrome");
    const edgeTarget = backup.targets.find((target) => target.browser === "edge");
    check("二次注册备份记录当前值作为新旧值", chromeTarget?.previousDefault === manifestPath, JSON.stringify(chromeTarget));
    check("Edge 备份记录原本不存在", edgeTarget?.keyExisted === false, JSON.stringify(edgeTarget));
  }

  // ---------- 6. 回滚：按第一份备份恢复 Chrome，Edge 由 -IncludeEdge 删除 ----------
  {
    const result = runScript(unregisterPs1, [
      "-RegistryRoot", registryRoot,
      "-BackupFile", firstBackupFile,
      "-IncludeEdge",
    ]);
    check("回滚退出码 0", result.status === 0, result.stderr);
    check("Chrome 旧默认值被原样恢复", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));
    check("第一份备份未覆盖的 Edge 键被删除", !regExists(edgeKey));
    check("回滚未触碰邻居 host", regGet(neighborKey) === "C:\\neighbor\\host.manifest.json", regGet(neighborKey));
    check("回滚模式报告 restored-from-backup", result.json?.mode === "restored-from-backup", result.stdout);
  }

  // ---------- 7. 幂等：再次回滚仍是恢复（不会删掉旧值） ----------
  {
    const result = runScript(unregisterPs1, ["-RegistryRoot", registryRoot, "-BackupFile", firstBackupFile]);
    check("重复回滚退出码 0", result.status === 0, result.stderr);
    check("重复回滚保持旧值", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));
  }

  // ---------- 8. 无备份：删除本 host 键 ----------
  {
    fs.rmSync(backupDir, { recursive: true, force: true });
    const result = runScript(unregisterPs1, ["-RegistryRoot", registryRoot]);
    check("无备份注销退出码 0", result.status === 0, result.stderr);
    check("无备份注销删除 Chrome 键", !regExists(chromeKey));
    check("无备份模式报告 removed", result.json?.mode === "removed", result.stdout);
    check("无备份注销未触碰邻居 host", regGet(neighborKey) === "C:\\neighbor\\host.manifest.json", regGet(neighborKey));
    const again = runScript(unregisterPs1, ["-RegistryRoot", registryRoot]);
    check("重复无备份注销幂等", again.status === 0 && !regExists(chromeKey), again.stderr);
  }

  // ---------- 9. fail closed ----------
  {
    // 9a. exe 不存在
    regSetDefault(chromeKey, oldManifestPath);
    const missingExe = path.join(work, "does-not-exist.exe");
    const result = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", missingExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
    ]);
    check("exe 不存在时拒绝注册", result.status === 1 && /does not exist/i.test(result.stderr), result.stderr);
    check("拒绝注册时不改注册表", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));
    check("拒绝注册时不写 backup", !fs.existsSync(backupDir) || fs.readdirSync(backupDir).length === 0);

    // 9b. 显式扩展 ID 与 key 推导不一致
    const mismatch = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
      "-ExtensionId", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    check("扩展 ID 不一致时拒绝注册", mismatch.status === 1 && /does not match/i.test(mismatch.stderr), mismatch.stderr);
    check("拒绝时注册表保持旧值", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));

    // 9c. 模板 allowed_origins 非法
    const badTemplate = path.join(work, "bad-template.json");
    fs.writeFileSync(
      badTemplate,
      JSON.stringify({ name: HOST_NAME, description: "bad", type: "stdio", path: "__HOST_EXE__", allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }, null, 2),
    );
    const bad = runScript(registerPs1, [
      "-RegistryRoot", registryRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
      "-TemplatePath", badTemplate,
    ]);
    check("模板 origin 非法时拒绝注册", bad.status === 1 && /allowed_origins/i.test(bad.stderr), bad.stderr);
    check("模板拒绝时注册表保持旧值", regGet(chromeKey) === oldManifestPath, regGet(chromeKey));

    // 9d. 非 HKCU 根（绝不写 HKLM）
    const hklmRoot = "HKLM:\\Software\\BrowserPilotTestsShouldNotExist";
    const hklm = runScript(registerPs1, [
      "-RegistryRoot", hklmRoot,
      "-HostPath", fakeExe,
      "-ManifestPath", manifestPath,
      "-BackupDir", backupDir,
    ]);
    check("HKLM 根被拒绝", hklm.status === 1 && /non-HKCU|HKLM/i.test(hklm.stderr), hklm.stderr);
    check("HKLM 下没有留下测试键", !regExists(hklmRoot + "\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME));

    // 9e. 备份文件被篡改指向其它 host / 非 NativeMessagingHosts 路径 / 空目标时拒绝
    if (firstBackupFile && fs.existsSync(firstBackupFile)) {
      const tampered = path.join(work, "tampered-backup.json");
      const backup = readJson(firstBackupFile);
      backup.targets[0].registryPath = "HKCU:\\Software\\SomeoneElse\\com.egolite.browseragent";
      fs.writeFileSync(tampered, JSON.stringify(backup, null, 2));
      const tamperResult = runScript(unregisterPs1, ["-RegistryRoot", registryRoot, "-BackupFile", tampered]);
      check("被篡改的备份文件被拒绝", tamperResult.status === 1 && /refusing/i.test(tamperResult.stderr), tamperResult.stderr);

      const wrongParent = readJson(firstBackupFile);
      wrongParent.targets[0].registryPath = "HKCU:\\Software\\SomeoneElse\\com.browserpilot.browseragent";
      fs.writeFileSync(tampered, JSON.stringify(wrongParent, null, 2));
      const wrongParentResult = runScript(unregisterPs1, ["-RegistryRoot", registryRoot, "-BackupFile", tampered]);
      check("同 host 名但非 NativeMessagingHosts 的备份路径被拒绝", wrongParentResult.status === 1 && /NativeMessagingHosts|refusing/i.test(wrongParentResult.stderr), wrongParentResult.stderr);

      const empty = readJson(firstBackupFile);
      empty.targets = [];
      fs.writeFileSync(tampered, JSON.stringify(empty, null, 2));
      const emptyResult = runScript(unregisterPs1, ["-RegistryRoot", registryRoot, "-BackupFile", tampered]);
      check("没有恢复目标的备份被拒绝（不假报成功）", emptyResult.status === 1 && /no restore targets/i.test(emptyResult.stderr), emptyResult.stderr);
    }
  }
} catch (error) {
  failed++;
  failures.push("unexpected exception");
  console.error("FAIL | unexpected exception :: " + (error instanceof Error ? error.stack : String(error)));
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failures.length) console.log("failed: " + failures.join("; "));
process.exit(failed ? 1 : 0);
