---
type: VerificationReport
status: verified
generated: { by: agent-b, at: 2026-10-28T16:30:00+08:00 }
scope: Windows Native Messaging P1
---

# Windows Native Messaging P1 验证报告（2026-10-28）

本报告记录 Browser CLI / BrowserPilot 在 **Windows** 上的 native messaging 注册、真实链路、
`chrome.debugger` 六操作、MV3 Service Worker 重启与 generic 模式回归。所有结论都来自真实进程
（基线 `chrome.exe` + 打包后的 `browserpilot-host-*.exe` + 真实扩展 SW），没有使用 mock。

工作区：`D:\work\wt\bp-native`（分支 `agent/p1-native-messaging`）。
基线浏览器：`D:\work\wt\browser-cli-baseline\chrome.exe`（Chromium 156.0.8067.0，unbranded，
`--load-extension` 可用）。第三方对照：Playwright Chromium
`%LOCALAPPDATA%\ms-playwright\chromium-1234\chrome-win64\chrome.exe`。

---

## 1. 注册与回滚

### 1.1 设计

- 只写 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserpilot.browseragent`。
- Edge 必须显式 `-IncludeEdge`；`-RegistryRoot` 必须以 `HKCU:\` 开头，脚本还会拒绝任何含 `HKLM`
  的根。**没有任何写 HKLM 的代码路径。**
- 修改前先把目标键的默认值备份到 `native-host/backup/<timestamp>.json`，包含：
  `hostName`、`createdAt`/`createdAtUnixMs`、`note`、目标浏览器的 `registryPath`、
  `keyExisted`、`hasDefault`、`previousDefault`、旧 manifest 摘要。
- `native-host/unregister.ps1`：
  - 有备份（显式 `-BackupFile` 或自动取最近一份本 host 的备份）→ 逐项恢复旧默认值；
    备份记录“键原本不存在”时删除该键。
  - 无备份 → 删除本 host 的键（Chrome；`-IncludeEdge` 时含 Edge）。
  - 只接受以 `com.browserpilot.browseragent` 结尾的备份 `registryPath`，被篡改的备份会被拒绝。
- 注册 fail closed：
  - 目标 exe 不存在 → 拒绝，注册表保持原值；
  - 模板非法（name/type/allowed_origins 占位符不对）→ 拒绝；
  - `allowed_origins` 必须等于由 `manifest.json` 的 `key` 推导出的扩展 ID；
  - 生成 manifest 后再次解析校验，并检查文件无 UTF-8 BOM。

### 1.2 过期 manifest 路径的修复

旧状态：`native-host/host.manifest.json` 是 tracked 文件，内容是旧机器的绝对路径
`D:\work\chrome\plugin-v1\native-host\dist\browserpilot-host-1788400184619.exe`。

现在：

- 新增 tracked 模板 `native-host/host.manifest.template.json`，只含占位符
  `__HOST_EXE__` / `__EXTENSION_ID__`；
- `native-host/host.manifest.json` 改为生成物并加入 `.gitignore`（`git rm --cached`）；
- `scripts/build-host.mjs` 与 `native-host/register.ps1` 每次都用**实际构建出的 exe**重新生成；
- `scripts/lib/host-manifest.mjs` 统一扩展 ID 推导、模板渲染、BOM 检查与校验；
- `scripts/register-host-mac.mjs` 复用同一套 ID 推导/一致性检查。

### 1.3 实测结果

注册测试（隔离到 `HKCU\Software\BrowserPilotTests\<random>`，测试结束删除）：

```
node scripts/test-native-registration.mjs
49/49 passed
```

覆盖：模板占位符、ID 推导、DryRun 不写盘、只写 Chrome、`-IncludeEdge` 写 Edge、
备份旧值、BOM-free、回滚恢复、重复回滚幂等、无备份删除、exe 不存在/ID 不一致/模板 origin
非法/HKLM 根/被篡改备份全部 fail-closed、邻居 host `com.egolite.browseragent` 全程未被触碰。

真实 E2E 中的注册/回滚证据（`report.json`）：

```
before : D:\work\chrome\plugin-v1\native-host\host.manifest.json
after  : D:\work\wt\bp-native\native-host\host.manifest.json
backup : .e2e-tmp/<run>/backup/20261028-162535-991.json
rollback mode = restored-from-backup
afterRollback = D:\work\chrome\plugin-v1\native-host\host.manifest.json  (与 before 相同)
```

复现命令：

```bash
# 默认只注册 Chrome；修改前自动备份
powershell -NoProfile -ExecutionPolicy Bypass -File native-host/register.ps1
# 需要 Edge 时显式开启
powershell ... -File native-host/register.ps1 -IncludeEdge
# 回滚：默认取最近一份 backup；也可显式指定
powershell ... -File native-host/unregister.ps1
powershell ... -File native-host/unregister.ps1 -BackupFile native-host\backup\<stamp>.json
```

---

## 2. 构建 Host

```bash
node scripts/build-host.mjs
```

本次产物：`native-host\dist\browserpilot-host-1793175416522.exe`（Node SEA + postject）。
生成的 manifest：

```json
{
  "name": "com.browserpilot.browseragent",
  "description": "BrowserPilot native messaging host",
  "path": "D:\\work\\wt\\bp-native\\native-host\\dist\\browserpilot-host-1793175416522.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://nnollghpaggbcdkkgoieneffnlijinio/"]
}
```

BOM 检查：`bom=false`，`bytes=300`。

---

## 3. 真实链路 E2E

### 3.1 启动方式

```bash
node scripts/test-native-e2e.mjs            # 全部阶段
node scripts/test-native-e2e.mjs --stage=chain
node scripts/test-native-e2e.mjs --stage=debugger
node scripts/test-native-e2e.mjs --stage=sw
node scripts/test-native-e2e.mjs --stage=generic
```

基线 Chrome 参数（无 `--no-sandbox`）：

```
--headless=new --disable-gpu --in-process-gpu
--remote-debugging-port=0 --remote-allow-origins=*
--user-data-dir=<run>/baseline-profile
--load-extension=<worktree>/dist --disable-extensions-except=<worktree>/dist
--no-first-run --no-default-browser-check
```

`LOCALAPPDATA` 指向 `<run>/baseline-localappdata`，host 的 session 文件因此完全隔离在
`<run>/baseline-localappdata/BrowserPilot/sessions/`。每个 host 使用随机高位基础端口
（`BROWSERPILOT_HOST_BASE_PORT`），避免与用户已运行的 BrowserPilot host 抢占 47001。

### 3.2 结果

```
真实 host 进程：pid=29880
ExecutablePath = D:\work\wt\bp-native\native-host\dist\browserpilot-host-1793175416522.exe
session        = <run>\baseline-localappdata\BrowserPilot\sessions\48657.json
TCP 端口       = 48657
```

这证明扩展 SW 的 `connectNative` 确实拉起了仓库构建的真实 host exe，而不是旧环境或 mock。

命令链路（全部经 Host TCP → SW → 结果返回）：

| 命令 | 结果摘要 |
|---|---|
| `get_ready_state` | `{port:48657, authToken:<redacted>, profile.ok:true}` |
| `ping` | `{pong:true}` |
| `version` | `{name:"BrowserPilot", version:"0.1.0"}` |
| `host_capabilities` | `mode:"generic"`, `degradeReason:"managed-mode-disabled"`, `protocolVersion:0`, `maxConcurrentWindows:1` |
| `get_profile` | `ok:true` |
| `open_space` | `spaceId:"space-b3bf4eaa-..."`, `windowId:533127063`, `tabId:533127064` |
| `open_tab` | `tabId:533127065`, 同 `windowId`/`spaceId` |
| `list_tabs` | 2 个真实标签，标题均为 `BrowserPilot E2E Fixture` |
| `snapshot` (L0) | 返回 `# BrowserPilot E2E Fixture` + `[click] Click me @1` |
| `readText` | 读到 fixture 标题 |

说明：基线是 Browser CLI 构建，但本次未加 `--browser-cli-background-presentation`，
所以内核的 `managedMode=false`，能力探测按设计降级为 generic；`degradeReason` 不是
`not-probed`，说明探测确实运行过。增强模式（enhanced）不在本次覆盖范围（见第 7 节）。

---

## 4. chrome.debugger 六操作

fixture 为内置 Node HTTP server（`127.0.0.1` 随机端口），页面含可点击按钮、输入框与 `#out`。

| 操作 | 证据 |
|---|---|
| attach | `js` 命令触发 `debugger-bridge.attach`；`drainEvents` 收到 `debugger.attach {tabId:533127065}` |
| evaluate | `js {expression:"document.title"}` → `"BrowserPilot E2E Fixture"` |
| click | `click {selector:"#btn"}` → `#out.textContent="clicked"`，`body.dataset.clicked="1"` |
| type | 先点 `#name`，`type {text:"hello-browserpilot"}` → 输入框值 `"hello-browserpilot"`，`typed:18` |
| screenshot | `screenshot {format:"png"}` → 合法 PNG（`debugger-screenshot.png`，18816 base64 chars，IHDR 宽高 > 0），`possiblyStale:false`，`fromSurface:true` |
| detach | 新增 `detach` 命令 → `{detached:true, wasAttached:true}`，`drainEvents` 收到 `debugger.detachManual` |

detach 后操作失败的直接证据（在扩展 SW 里调用底层 API）：

```
chrome.debugger.sendCommand({tabId:533127065},"Runtime.evaluate",...)
→ error: Debugger is not attached to the tab with id: 533127065.
```

随后再发 `js`，扩展按设计自动重新 attach，返回 `{value:1}`。
（`detach` 是本次新增的显式清理命令；`stop` 仍通过 `detachAll` 释放全部 attach。）

原始日志：`.e2e-tmp/<run>/artifacts/debugger.json` 与 `debugger-screenshot.png`。

---

## 5. MV3 Service Worker 重启

### 5.1 停止方式

浏览器级 CDP（`/json/version` 的 browser WebSocket）尝试：

```
ServiceWorker.stopAllWorkers
→ "'ServiceWorker.stopAllWorkers' wasn't found"
```

该 Chromium 构建未暴露此方法，因此使用等价的：
`Target.getTargets` → 找到扩展 `service_worker` target → `Target.closeTarget`。
记录中明确标注 `method: "Target.closeTarget(fallback)"`，未伪造成功。

### 5.2 结果

```json
{
  "beforeSession": { "port": 48657, "pid": 29880 },
  "oldHostPidAlive": false,
  "wokeBy": "popup",
  "afterSession": { "port": 48657, "pid": 34504 },
  "beforeTabs": "space-b3bf4eaa-... 533127064,533127065",
  "afterTabs":  "space-b3bf4eaa-... 533127064,533127065"
}
```

- SW 停止后 target 消失；
- 旧 host 进程 29880 在 native port 断开后退出（`host.js` 新增 stdin EOF 清理逻辑）；
- 新 SW 启动后 `connectNative` 拉起新 host 进程 34504（端口复用 48657）；
- `get_ready_state`、`ping` 正常；
- `host_capabilities` 重新返回，`degradeReason` 仍为 `managed-mode-disabled`（不是 `not-probed`），
  证明能力重新探测；
- `chrome.storage.session` 中的 Task Space 与两个 tab 完全恢复。

唤醒方式：停止后等待 alarm 10s；未出现则打开扩展 popup 页触发 `runtime.sendMessage`。
popup 必须开在**独立新窗口**（`Target.createTarget {newWindow:true, background:true}`），
否则它会作为普通标签混入被测 Task Space，造成“tab 列表不一致”的假失败；唤醒后已关闭该 target。

原始日志：`.e2e-tmp/<run>/artifacts/sw-restart.json`。

---

## 6. generic 模式回归（普通 Chromium）

浏览器：Playwright Chromium `chromium-1234\chrome-win64\chrome.exe`（非 Browser CLI，无
`chrome.browserCli`）。按任务允许，仅对该第三方对照浏览器使用 `--no-sandbox`（已在测试输出与
本报告标注）。

同一份 `dist/` 扩展、独立 profile、`--headless=new`、`--load-extension`/`--disable-extensions-except`。

结果：

```json
{
  "capabilities": {
    "mode": "generic",
    "protocolVersion": 0,
    "degradeReason": "api-absent",
    "maxConcurrentWindows": 1,
    "managedMode": false,
    "backgroundWindows": false,
    "backgroundCapture": false,
    "hardFocusIsolation": false,
    "foregroundAssist": false
  },
  "sessions": [],
  "alive": 2,
  "screenshot": { "len": 14540, "head": "iVBORw0KGgoAAAAN" }
}
```

- 能力探测 `api-absent` → generic，并发上限 1；
- 隔离 `LOCALAPPDATA` 下没有 host session（Playwright Chromium 使用自己的注册表 hive，
  本次刻意不注册，因此不会连 host）；
- SW 未崩溃，仍能响应；
- 截图仍可用：经 SW 的 `chrome.debugger.attach` + `Page.captureScreenshot` 得到合法 PNG base64，
  截图后 SW target 仍在。

限制：generic 阶段没有走 Host TCP 命令路径（没有为 Chromium 写注册表），截图是直接经扩展 SW
调用同一 `chrome.debugger` 内核能力；命令分发路径已在第 3/4 节的基线 Browser CLI 上完整验证。

原始日志：`.e2e-tmp/<run>/artifacts/generic.json`、`generic-chrome.log`。

---

## 7. 测试与门禁

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run test:core` | exit 0，全部 PASS |
| `node scripts/test-native-registration.mjs` / `npm run test:register:native` | 49/49 passed |
| `node scripts/test-native-e2e.mjs` | 37/37 passed |
| `node native-host/test-host-exe.mjs`（隔离 LOCALAPPDATA） | exit 0；ready 帧、TCP ping、身份注入全部 PASS |
| `npm run test:register`（macOS 注册单测） | Windows 上 SKIP（该套件依赖 POSIX 路径/可执行位/`$HOME`，非 macOS 明确跳过） |
| `npm run registry:check` | **FAIL**（exit 1，`strictEqual` 比对 `registry/bundle.json` 生成结果不一致；属于任务说明中 Agent C 正在修的 CRLF 预存问题，本分支未改动 registry 生成器） |

E2E 全套输出摘要：

```
PASS | 注册后 Chrome 键指向本次生成的 manifest
PASS | connectNative 拉起真实 host 进程（exe 路径匹配）
PASS | open_space / open_tab / list_tabs / snapshot / readText
PASS | attach / evaluate / click / type / screenshot / detach
PASS | detach 后操作失败 ... / 下一次命令自动重新 attach
PASS | SW 已停止 / 旧 host 退出 / host 重连 / 能力重新探测 / 状态恢复
PASS | generic：api-absent / 并发上限 1 / SW 未崩溃 / 截图仍可用
PASS | 回滚后 Chrome 键恢复测试前值
37/37 passed
```

证据目录：`D:\work\wt\bp-native\.e2e-tmp\2026-10-28T08-25-35-188Z\artifacts\`
（`.e2e-tmp/` 已 gitignore；可用 `--clean` 在运行后删除）。

---

## 8. 变更文件

- `native-host/register.ps1` — 重写：HKCU-only、默认 Chrome、`-IncludeEdge`、backup、fail-closed、BOM 校验、按实际 exe 重新生成 manifest。
- `native-host/unregister.ps1` — 新增：按 backup 恢复；无 backup 删除；只操作本 host；拒绝被篡改的 backup。
- `native-host/host.manifest.template.json` — 新增 tracked 模板。
- `native-host/host.manifest.json` — 取消 tracked，改为生成物（`.gitignore`）。
- `native-host/host.js` — `get_ready_state` 支持已认证 TCP 客户端；stdin EOF/端口关闭主动退出并清理 session；profile/ready 负载复用。
- `scripts/lib/host-manifest.mjs` — 新增：扩展 ID 推导、模板渲染/校验、BOM 检查、最新 exe 查找。
- `scripts/build-host.mjs` — 使用模板生成 BOM-free manifest。
- `scripts/register-host-mac.mjs` — 复用共享 ID/一致性工具。
- `scripts/test-register-host-mac.mjs` — 适配生成物/模板；复制共享 lib 到 CLI 临时仓库；非 macOS 跳过。
- `scripts/test-native-registration.mjs` — 新增：49 项注册/回滚/fail-closed 测试。
- `scripts/test-native-e2e.mjs` — 新增：真实链路/六操作/SW 重启/generic 自动化。
- `src/shared/types.ts`、`src/background/commands.ts` — 新增 `detach` 命令（不关标签释放 debugger），并补充 export_guide 表格。
- `package.json` — 新增 `unregister-host`、`test:register:native`、`test:e2e:native*` 脚本。
- `README.md`、`docs/README.md` — 注册/回滚与测试说明。

---

## 9. 新风险与注意事项

1. **HKCU 是用户级全局设置**：E2E 期间真实 Chrome 键指向本仓库 manifest；测试已按 backup 回滚。
   若用户 Chrome 恰在测试窗口内重连同一 host，可能拉起本仓库 host（写入 `native-host/profile-cache.json`，
   已 gitignore）。本次测试使用独立 `LOCALAPPDATA` 和独立端口，未操作用户 profile/窗口/进程。
2. **旧环境副作用披露**：在首次改注册表之前做的一次只读浏览器探测（当时 HKCU 仍指向旧环境）
   使旧环境 host 更新了它自己的 `D:\work\chrome\plugin-v1\native-host\profile-cache.json`
   （机器生成的缓存文件，未改代码/未改注册表）。之后的正式 E2E 都指向本仓库 host。
3. **`get_ready_state` 语义扩展**：现在已认证 TCP 客户端也可直接获取 `{port, authToken, profile}`；
   未认证请求仍被拒绝。该 token 与 session 文件同级敏感，客户端不应记录到共享日志。
4. **`detach` 是新公开命令**：它只释放 debugger，不关闭标签；下一次动作会自动重新 attach。
   若调用方期望 detach 后动作永久失败，需要显式说明（自动重连是现有设计）。
5. **SW 停止方式**：本构建没有 `ServiceWorker.stopAllWorkers`，使用 `Target.closeTarget` 等价停止；
   其他构建可能支持前者，脚本已优先尝试并记录实际使用的方法。
6. **generic 测试未走 Host TCP**：Playwright Chromium 的 native messaging 注册表 hive 与 Chrome 不同，
   为避免写额外浏览器键，generic 阶段只验证能力探测、并发上限、SW 存活与截图。完整命令路径在
   基线 Browser CLI 上验证。
7. **`host.manifest.json` 不再入库**：新克隆必须 `npm run build:host` 或 `register-host` 才能生成；
   `test:host:exe` 会在缺失时给出明确提示。
8. **macOS 注册脚本依赖共享 lib**：`register-host-mac.mjs` 现在 import `scripts/lib/host-manifest.mjs`；
   CLI 测试已同步复制该文件。macOS 套件在 Windows 上明确 SKIP，未在本机实际跑通 mac 路径。
9. **`registry:check` 仍失败**：与本任务无关的预存生成物/换行问题，按任务要求如实记录，未掩盖。

---

## 10. 未覆盖项

- **Enhanced 模式**：基线未加 `--browser-cli-background-presentation`，探测结果为
  generic/managed-mode-disabled；未验证 enhanced 能力与后台窗口/截图差异化路径。
- **真实 Edge 浏览器**：`-IncludeEdge` 只在隔离 HKCU 子树做了注册/回滚断言，未启动 Edge 实测。
- **HKLM 机器级注册**：按安全规则明确不实现。
- **多 Agent 并发/8 窗口上限**：未做压力测试。
- **macOS 路径**：本机为 Windows，mac 注册套件 SKIP，未在 mac 上执行。
- **Chrome 137+ 品牌版 `--load-extension`**：基线为 unbranded Chromium，可用；品牌 Chrome 的限制未在本任务验证。

---

## 11. 可复现命令清单

```bash
# 0. 构建
npm run build
node scripts/build-host.mjs

# 1. 注册/回滚（真实 HKCU，修改前自动备份）
powershell -NoProfile -ExecutionPolicy Bypass -File native-host/register.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File native-host/unregister.ps1

# 2. 注册逻辑自动化测试（隔离 HKCU 测试子树）
npm run test:register:native

# 3. 真实链路 E2E（自动注册、跑完回滚）
node scripts/test-native-e2e.mjs

# 4. 单阶段
node scripts/test-native-e2e.mjs --stage=chain
node scripts/test-native-e2e.mjs --stage=debugger
node scripts/test-native-e2e.mjs --stage=sw
node scripts/test-native-e2e.mjs --stage=generic

# 5. 仓库门禁
npm run typecheck
npm run build
npm run test:core
npm run registry:check   # 当前预期失败（CRLF 预存问题，Agent C 处理）
```
