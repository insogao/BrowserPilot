---
type: TestMatrix
status: implemented
generated: { by: agent-a, at: 2026-10-31T19:10:00+08:00 }
stale_after: 2027-04-30
scope: Windows Release Candidate 的 release-like E2E：normal/agent 启动 profile、flag 分类、14 个用例、S5 真实 IME 映射、与 diagnostic 矩阵对照
---

# Windows Release Candidate E2E（release-like matrix）

> 配套实现：`scripts/test-release-candidate-e2e.mjs`
> （辅助：`scripts/lib/win32-helper.mjs`、`scripts/lib/test-process.mjs`、`tests/fixtures/*`）。
> 这是一份**独立于 diagnostic 矩阵**的结果，不是对
> `docs/input-arbitration-e2e-matrix-2026-10-28.md` 的重新解释。
>
> **结论（最终，2026-10-31 全量运行）**：
> - **14/14 case PASS，210/210 checks PASS，verdict=PASS**（normal 6/6，agent 8/8）。
> - 最终报告：`D:\c\logs\release-candidate-e2e-2026-10-31T19-10-32-428Z.json`；
>   运行目录：`.e2e-tmp/release-candidate-2026-10-31T19-08-10-853Z/`。
> - **没有使用** `--in-process-gpu`、`--remote-debugging-port=0`、
>   `--site-per-process`、遮挡/后台优化禁用参数、`--no-sandbox` 或 `--headless`。
> - Normal 与 Agent 都是**默认 out-of-process GPU**；两个会话都没有
>   `DevToolsActivePort`，浏览器命令行不含 remote debugging 端口/管道。
> - **S5 真实搜狗 TSF IME 在 release-like agent profile 上实测 PASS**（compositionstart +
>   三个输入面中文上屏 + HUMAN/ASSIST 仲裁）；这不是假设，映射见 §8。
>   诊断矩阵里的 S5 仍保留自己的 `BLOCKED` 状态，二者不混写。
> - 本矩阵不宣称 Windows 正式发布就绪：签名/公证/P1 原生 CookieStore 等不在本任务范围。

---

## 0. 一句话结论

在**真实产品链路**（补丁 Browser CLI → 扩展 SW → native host → `chrome.debugger`）上，
用 release-like 启动参数验证了：normal 模式可以后台驱动多窗口、遮挡截图、OOPIF 和 SW 重启；
agent 模式可以在 managed presentation + Feature on 下完成内核输入仲裁、K15、K4 + 30s
human latch、managed-hidden 截图、OOPIF 仲裁和真实搜狗 IME；用户前台窗口在后台操作前后
保持不变，测试结束恢复原前台窗口；14 个用例全部 PASS，没有伪造 PASS/BLOCKED。

## 1. 为什么必须单独一套矩阵

diagnostic 矩阵（`test-input-arbitration-e2e.mjs`）为了观测和控制使用了：

| diagnostic 参数 | 作用 | 为什么不能直接代表 release |
| --- | --- | --- |
| `--in-process-gpu` | 早期 TSF/ACG 兼容 + 同进程 CDP 观测 | 改变 GPU/呈现初始化路径；release 默认是独立 GPU 进程 |
| `--remote-debugging-port=0` | 浏览器级 CDP（popup/OOPIF/第二会话） | release-like 明确禁止全局调试端口 |
| `--site-per-process` | 强制 OOPIF | release 使用默认 site isolation，不应强制 |
| `--disable-features=CalculateNativeWinOcclusion` | 关闭遮挡判定 | 会掩盖后台/遮挡行为 |
| `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` | 保持后台渲染 | 会掩盖 release 的后台节流/冻结行为 |
| managed hidden 窗口 | Feature on 的 API availability | 需要区分“产品 API 可用”与“可交互的可见窗口” |

Release Candidate 需要回答的是：**去掉这些 test-only 参数后，同一条产品链路是否仍然成立**。
因此本仓库新增 `scripts/test-release-candidate-e2e.mjs`，与 diagnostic 脚本并存、互不替代。

## 2. 运行方式

```bash
# 只打印矩阵与前置条件（不启动浏览器）
npm run test:rc:release:matrix

# 全量（默认会先 npm run build + build:host）
npm run test:rc:release

# 复用现有 dist / host exe
node scripts/test-release-candidate-e2e.mjs --no-build

# 只跑 normal / agent
node scripts/test-release-candidate-e2e.mjs --mode=normal --no-build
node scripts/test-release-candidate-e2e.mjs --mode=agent --no-build

# 单用例 / 重复次数 / 30s latch 等待
node scripts/test-release-candidate-e2e.mjs --mode=agent --case=RC-A5 --no-build
node scripts/test-release-candidate-e2e.mjs --mode=normal --case=RC-N4 --repeat=12 --no-build
node scripts/test-release-candidate-e2e.mjs --mode=agent --case=RC-A5 --latch-wait-ms=31000 --no-build

# 清空本 runner 自己的持久测试 profile（只允许 D:\c\logs\rc-e2e\profiles 下）
node scripts/test-release-candidate-e2e.mjs --fresh-profile
```

报告：`D:\c\logs\release-candidate-e2e-<timestamp>.json`；
运行目录：`.e2e-tmp/release-candidate-<timestamp>/`（含 `artifacts/rc-normal-chrome.log`、
`artifacts/rc-agent-chrome.log`、`report.json`）。

## 3. 启动 profile

### 3.1 Normal（无 managed presentation，Feature off）

```text
chrome.exe
  --user-data-dir=D:\c\logs\rc-e2e\profiles\profile-normal
  --load-extension=<repo>\dist
  --disable-extensions-except=<repo>\dist
  --no-first-run
  --no-default-browser-check
  --disable-background-networking
  --disable-sync
  --disable-component-update
  --enable-logging=stderr
  --v=0
  http://127.0.0.1:<fixture>/boot?token=...
```

### 3.2 Agent（managed presentation + Feature on）

```text
chrome.exe
  --user-data-dir=D:\c\logs\rc-e2e\profiles\profile-agent
  --load-extension=<repo>\dist
  --disable-extensions-except=<repo>\dist
  --no-first-run
  --no-default-browser-check
  --disable-background-networking
  --disable-sync
  --disable-component-update
  --enable-logging=stderr
  --v=0
  --enable-features=InputOwnershipEnforcement
  --browser-cli-background-presentation
  about:blank
```

Agent 启动时窗口是 **managed hidden**（顶层 `visible=false`）。需要真实人类输入时，
走**Path A 用户显式上屏**（产品行为，不是冷启动 shortcut）：

```text
chrome.exe
  --user-data-dir=D:\c\logs\rc-e2e\profiles\profile-agent
  --browser-cli-user-explicit-show
```

第二个进程经 ProcessSingleton 转发到第一个实例后自行退出；第一个实例的窗口变为
`visible=true`、render widget `visible=true`，日志出现
`BROWSER_CLI_USER_EXPLICIT_SHOW ... result=handled reason=existing-window-presented`。
在本机（用户前台是最大化的文件资源管理器）该 show **没有抢走前台窗口**；人类输入用例
会临时置顶/聚焦测试窗口并在结束时恢复原前台。

### 3.3 Profile 隔离与持久性

| 项 | 值 |
| --- | --- |
| profile 根 | `D:\c\logs\rc-e2e\profiles`（可用 `--profile-root` 覆盖） |
| normal | `profile-normal`（持久，跨运行保留） |
| agent | `profile-agent`（持久，跨运行保留） |
| LOCALAPPDATA | 每次运行独立 `.e2e-tmp/.../mode-<x>/localappdata`（host session 隔离） |
| 禁止 | 真实 Chrome/Edge/Chromium/WorkBuddy profile；runner 启动前逐项断言并 fail closed |
| 清理 | `--fresh-profile` 只删除上述专用目录；默认不删除，保持 persistent |

## 4. Flag 分类（逐个参数）

Runner 在启动前对每个参数分类；出现 `forbidden` 或 `unclassified` 立即 fail closed。

| 参数 | 类别 | 为什么 |
| --- | --- | --- |
| `--user-data-dir=` | `harness-isolation` | 独立持久测试 profile；不碰真实用户数据 |
| `--load-extension=` | `harness-extension` | 加载未打包的 BrowserPilot 构建；release 安装同一扩展，不改变 GPU/输入语义 |
| `--disable-extensions-except=` | `harness-extension` | 确保只加载测试构建 |
| `--no-first-run` | `profile-hygiene` | 无首次运行 UI |
| `--no-default-browser-check` | `profile-hygiene` | 无默认浏览器提示 |
| `--disable-background-networking` | `profile-hygiene` | 避免后台网络噪声 |
| `--disable-sync` | `profile-hygiene` | 测试 profile 不做账号同步 |
| `--disable-component-update` | `profile-hygiene` | 运行期间不更新组件 |
| `--enable-logging=stderr` | `diagnostics` | 采集 FATAL/CHECK/crash 行 |
| `--v=0` | `diagnostics` | 只保留 WARNING+；不改变渲染/输入语义 |
| `--enable-features=InputOwnershipEnforcement` | `product-switch` | agent 模式的 release 配置：内核输入仲裁 |
| `--browser-cli-background-presentation` | `product-switch` | agent 模式的 managed presentation（API availability + trust gate） |
| `--browser-cli-user-explicit-show` | `product-switch` | 用户显式上屏 intent；Path A 由第二个进程携带 |
| `about:blank` | `product-startup` | managed 后台实例的启动页；fixture 随后打开 |
| `http://127.0.0.1:<port>/...` | `fixture-navigation` | 测试 fixture URL |

### 4.1 明确禁止（runner 断言不存在）

| 参数 | 原因 |
| --- | --- |
| `--in-process-gpu` | 改变 GPU/呈现初始化；release 必须默认 out-of-process GPU |
| `--single-process` | 改变进程模型 |
| `--disable-direct-composition` | 不是有效 workaround；改变呈现路径 |
| `--remote-debugging-port=` / `--remote-debugging-pipe` | release-like 禁止全局调试端口/管道 |
| `--disable-features=...CalculateNativeWinOcclusion` | 掩盖原生遮挡判定 |
| `--disable-backgrounding-occluded-windows` | 掩盖后台/遮挡行为 |
| `--disable-renderer-backgrounding` | 掩盖后台节流 |
| `--disable-background-timer-throttling` | 掩盖后台节流 |
| `--no-sandbox` | 沙箱必须开启 |
| `--headless*` | 必须有真实 UI 窗口 |
| `--site-per-process` | 使用默认 site isolation，不强制 |
| `--use-mock-keychain` | macOS test-only；Windows 不适用 |
| `--enable-field-trial-config` | 产品构建已 `disable_fieldtrial_testing_config=true`，测试不重新打开 |

### 4.2 实测“无全局调试端口”证据

- 两个会话的 `DevToolsActivePort` 文件都不存在；
- 浏览器命令行不含 `--remote-debugging-port` / `--remote-debugging-pipe`；
- 测试控制全部走 Native Host 产品命令 + 受信扩展页面的 `chrome.debugger`
  （`tab_cdp_call` / popup `chrome.debugger.sendCommand`），没有浏览器级 CDP websocket；
- `chrome.debugger.getTargets` 可从 popup 页面调用（normal/agent 都通过）。

## 5. 用例矩阵与最终状态

图例：`PASS` = 本轮 release-like 真实执行通过；`FAIL` = 执行后断言失败；`BLOCKED` = 依赖/环境缺失，未执行。
本轮最终：**14/14 PASS，0 FAIL，0 BLOCKED，210/210 checks**。

| # | 模式 | 状态 | 用例 / 断言 | 关键证据 |
|---|---|---|---|---|
| RC-N1 | normal | **PASS** | 启动完整性：OOP GPU、无全局调试端口、隔离持久 profile、所有 flag 已分类 | GPU 独立子进程；`DevToolsActivePort` 不存在；profile 路径断言 |
| RC-N2 | normal | **PASS** | 产品 baseline：`js`/`fill`/`tab_cdp_call` 鼠标输入/`screenshot` 在后台窗口可用 | fill 后 inputValue 正确；click `clicks=1`；fromSurface=true + 非 stale；前台不变 |
| RC-N3 | normal | **PASS** | 多窗口并发：一个 HUMAN 一个 AI 互不干扰；截图/z-order/前台不变；人类输入不被锁 | AI 在 HUMAN 窗口 `INPUT_HUMAN_OWNED`；AI 窗口 click 落地；本轮 2 次真实人类 click 落地；前后台/z-order 一致 |
| RC-N4 | normal | **PASS** | 遮挡后台截图新鲜度：WS_EX_NOACTIVATE 遮挡窗口 + 连续 8 次 product screenshot | 遮挡后 `visibilityState=hidden`；8/8 fromSurface+非 stale+PNG marker 与 DOM 帧号 ±4；无 FATAL/CHECK |
| RC-N5 | normal | **PASS** | OOPIF：跨站 iframe 独立 renderer，AI 输入落子帧、主帧不变 | 同源 iframe → 跨站 iframe renderer +1；childClicks 0→1；主帧 0→0；前台恢复 |
| RC-N6 | normal | **PASS** | SW 重启：扩展 renderer/SW 重启后 host 新会话、产品命令恢复 | 旧 host 退出；新 host 30.6s 重连；ping/pong；version 0.1.0；浏览器 PID 不变；无调试端口 |
| RC-A1 | agent | **PASS** | Agent 启动完整性 + Path A user-explicit-show + API 可用 | 启动窗口 hidden；show 后窗口/widget `visible=true`；producer `existing-window-presented`；前台不变；API keys 完整 |
| RC-A2 | agent | **PASS** | 内核 HUMAN/AI：原始 debugger 输入 HUMAN 拒绝、AI 落地、版本语义 | HUMAN `-32000 InputOwnership: debugger input rejected`；AI clicks+1；VERSION_CONFLICT/STALE_VERSION |
| RC-A3 | agent | **PASS** | 内核 ASSIST：grant 一次性、第二条拒绝、TTL 过期 | grant(1) 第一条落地、第二条拒绝；TTL 120ms 后拒绝 |
| RC-A4 | agent | **PASS** | K15：新 tab 继承窗口快照；explicit tab override 优先于 heartbeat | 新 tab 立即继承 ai/1、ai/2；explicit human/1 经 3 次 heartbeat 不变；原始输入被拒 |
| RC-A5 | agent | **PASS** | K4 + human latch：真实人类点击 → onHumanPresence → 1s pause + 30s latch；显式 setOwnership 清除 | presence 携带 tabId/kind/at；<1s 与 >1s 均拒绝；31s 后新 grant 恢复；显式清除后 2 次成功、第 3 次拒绝；前台恢复 |
| RC-A6 | agent | **PASS** | managed-hidden 窗口产品 screenshot + 原始 fromSurface 证据 | 产品截图 fromSurface=true、非 stale、>1000 bytes；原始 CDP 也成功 |
| RC-A7 | agent | **PASS** | Agent OOPIF：跨站子帧独立 renderer；HUMAN 下顶层/子帧坐标原始输入都被拒；AI 下落地 | renderer +1；HUMAN 两次 `-32000` 且 childClicks 不变；AI childClicks+1 |
| RC-A8 | agent | **PASS** | **S5 真实搜狗 TSF IME**：input/textarea/contenteditable + HUMAN/ASSIST | compositionstart>0；三个输入面中文上屏；退格；HUMAN AI insertText 拒绝、人类按键仍输入；ASSIST grant 一次成功、第二次拒绝 |

### 5.1 与用户前台窗口有关的断言

- RC-N2/N3/N4/N5：每个用例显式记录 `foreground before/after`，全部相等；
- RC-N3/N4/N5 还记录窗口 `GW_HWNDPREV/GW_HWNDNEXT`（z-order），在截图/AI 操作前后不变；
- RC-A1：Path A show 前后前台相等；RC-A2/A3/A4/A6/A7 后台测试前后前台相等；
- RC-A5/A8：人类输入/IME 必须临时置顶/聚焦测试窗口；用例结束调用 `setForeground`
  恢复原前台并断言 `foregroundAfter == foregroundBefore`；
- 整个会话 cleanup 再次恢复到 `env.foregroundBeforeLaunch`，最终报告
  `foregroundAfter == foregroundBeforeLaunch`。

### 5.2 Test-control 与产品行为的边界

以下动作是**测试控制**，不是产品 launch flag，也不是对内核的替代修复：

| 动作 | 使用位置 | 说明 |
| --- | --- | --- |
| Win32 `SetWindowPos(SWP_NOACTIVATE)` / `HWND_TOP` | N2/N3/N4/N5 | 让后台窗口有真实合成表面；不改变前台 |
| Win32 `HWND_TOPMOST`（`raiseTopmost`） | A5/A8 人类输入前，N5 兜底 | 用户前台是最大化窗口时，让测试窗口可点击；结束后 `notTopmost` |
| `Page.setWebLifecycleState("active")` + `Emulation.setFocusEmulationEnabled` | N2/N3 | 后台窗口被冻结时让 renderer 处理输入；**不改变 launch flag**；N5 不使用（见 §10.2） |
| `Page.bringToFront` 兜底 | N5 | 长时间隐藏的 tab 生命周期冻结时，CDP 输入被接受但不到 renderer；兜底后恢复前台 |
| 真实 OS 鼠标/键盘（`mouse_event`/`WScript.SendKeys`） | N3/A5/A8 | 真实人类输入，不使用 `dispatchEvent` 冒充 |

这些动作只改变测试窗口的可交互状态；产品 launch 参数保持 release-like。N2/N3 的生命周期
唤醒是在**没有 iframe** 的页面上使用的；N5 的跨站 iframe 页面不使用 `setWebLifecycleState`
（见 §10.2 的崩溃记录）。

## 6. 与 diagnostic 矩阵的对照（结果严格分开）

diagnostic 结果来自 `docs/input-arbitration-e2e-matrix-2026-10-28.md`（204/204 executed checks，
32/32 可执行 case，S5 按设计 blocked，verdict=PARTIAL）。本表不修改 diagnostic 的历史结论。

| diagnostic 用例 | diagnostic 结果 | release 用例 | release 结果 | 说明 |
| --- | --- | --- | --- | --- |
| H1–H4（HUMAN，Feature off） | PASS | RC-N3 + RC-A2/RC-A8 | PASS / PASS / PASS | release launch 下 HUMAN 命令拒绝、人类输入不被锁 |
| A1–A3（popup ASSIST） | PASS | RC-A3 | PASS | 内核 grant 生命周期；popup 用户入口本身未在 release 重跑 |
| A4（跨 Agent） | PASS | — | not re-run | 扩展层隔离，不受 launch 模式影响 |
| S1–S4、S6（输入形态） | PASS | RC-N2 + RC-A2 | PASS / PASS | 产品 baseline + 内核拒绝 |
| **S5（真实 IME）** | **BLOCKED（诊断脚本静态声明）** | **RC-A8** | **PASS（真实证据）** | 逐项映射见 §8；不把 diagnostic 的 S5 改写为 PASS |
| O1–O4（OOPIF） | PASS | RC-N5 + RC-A7 | PASS / PASS | release 下用 renderer 增量 + 子帧输入证明 OOPIF |
| M1–M3（多窗口） | PASS | RC-N3 | PASS | 前台/z-order 证据 |
| F1–F3（baseline） | PASS（含 managed-hidden screenshot P0） | RC-N2 + RC-A6 | PASS / PASS | 本轮 release-like managed-hidden product screenshot PASS（见 §10.3） |
| K0–K3、K15（内核） | PASS | RC-A2 + RC-A4 | PASS / PASS | 原始 debugger 输入 + 版本/grant/继承 |
| K4 + human latch | 当前构建 PASS（旧文档为 BLOCKED） | RC-A5 | PASS | Path A show + 真实人类点击 + 30s latch |
| R1/R2（SW 重启/stale） | PASS | RC-N6 | PASS | SW renderer 重启（验证式 PID）；不是全局 CDP ServiceWorker 域 |

补充：本轮还单独复跑了 diagnostic 的 K4（当前构建）
`node scripts/test-input-arbitration-e2e.mjs --case=K4 --feature=on-visible --no-build`
→ **27/27 PASS**（报告 `D:\c\logs\input-arbitration-e2e-2026-10-31T17-57-41-786Z.json`）。
这说明旧文档里的 K4 BLOCKED 是旧构建/旧参数的结果；release 矩阵使用 Path A
（用户显式 show 的第二个进程）而不是 diagnostic 的 `--in-process-gpu` 冷启动。

**关键差异**：diagnostic 的 “204/204” 与 release 的 “210/210” 是两个独立分母
（diagnostic 24 个可执行 case；release 14 个 case 但每个 case 的 checks 更细）。
不要把 release 的 PASS 当作 diagnostic blocked 的解除；也不要拿 diagnostic 的
`--in-process-gpu` 结果当 release 证据。

## 7. Release-like 下仍然成立的产品链路

- **Native Host 唯一性**：两个会话的 host 进程 executable path 都等于本轮
  `native-host/dist/browserpilot-host-*.exe`；没有连接用户真实的
  `D:\work\chrome\plugin-v1` host。
- **扩展 ID**：注册的 extension ID 与 `manifest.json` 推导一致。
- **无全局 CDP**：所有观测/控制通过 host 命令或受信扩展页面的 `chrome.debugger`。
- **默认 GPU**：两个会话都枚举到独立 `--type=gpu-process` 子进程；浏览器命令行不含
  `--in-process-gpu`；产品 screenshot 在 normal 遮挡、normal 多窗口、agent managed-hidden
  都返回 `fromSurface=true` 且非 stale（本轮 agent managed-hidden 也 PASS，见 §10.3）。
- **SW 重启**：验证式终止扩展 renderer（不是按镜像名），Chrome 自动重启 SW 并建立新 host
  会话；产品命令恢复，浏览器 PID 不变。
- **注册表**：运行前备份 HKCU native host 值，结束后 `unregister.ps1` 恢复；若发现上次
  崩溃留下本仓库 manifest，runner 从历史备份找回原始值并**强制写回**，最终断言
  `registryAfter.restored=true`（见 §10.4）。

## 8. S5 映射：真实 IME 测试是否等价

S5 在 diagnostic 矩阵里的 blocked 理由是“真实 TSF/搜狗 IME + 系统输入法状态”未自动化。
本 runner 的 RC-A8 **把现有真实 IME 测试接入 S5**，逐项对照如下：

| S5 要求 | RC-A8 实测 | 结果 |
| --- | --- | --- |
| 真实 TSF/IME 组合输入，不是 `Input.insertText`/paste | `WScript.Shell.SendKeys` → OS 键盘 → TSF；`compositionstart>=1`；input/textarea/contenteditable 都得到中文 | **PASS** |
| 真实搜狗 IME（不是其它输入法） | 浏览器进程已加载 `SogouTSF.ime`、`SogouPY.ime` 及 SogouInput 组件 DLL | **PASS** |
| 系统输入法状态已采集 | 记录 `Get-WinUserLanguageList` 与 `HKCU\Keyboard Layout\Preload`（00000804 / 00000409） | **PASS** |
| 不使用 `dispatchEvent` 冒充人类输入 | 只用真实 OS 鼠标/键盘；没有 DOM 事件注入 | **PASS** |
| 真实组合输入期间 AI 输入仍被仲裁 | HUMAN：AI `Input.insertText` 被 `-32000 InputOwnership` 拒绝，真实按键仍可输入；ASSIST：grant(1) 一次成功、第二次拒绝 | **PASS** |

**结论**：现有真实 IME 测试（diagnostic 的 `IME` case）覆盖了 S5 的核心项；release runner
把它改写成 RC-A8（Path A 可见窗口 + popup debugger + 真实 Sogou TSF + 真实人类输入），
因此 S5 在 release-like 矩阵中 **PASS**。但 diagnostic 矩阵的 S5 静态 blocked 仍然保留，
因为那是另一套启动参数与观测面；两边结果不合并、不互相覆盖。

## 9. 失败/阻断处理原则

- Runner 只在 `PASS/FAIL/BLOCKED` 三态里报告；没有“跳过即 PASS”。
- `verdict=PASS` 的条件：所有选中 case 都执行且无 FAIL/BLOCKED，且 native host 注册表恢复成功。
- 依赖缺失（例如某个构建没有 `InputOwnershipEnforcement`）会把 agent case 标为 BLOCKED，
  不会静默降级为 normal 结果。
- 任何 `forbidden` 或 `unclassified` launch flag 会在启动浏览器前 fail closed。

## 10. 新发现 / 已知限制

### 10.1 `chrome.debugger.getTargets` 不返回 iframe/OOPIF target

在本构建（156.0.8067.0）上，从受信扩展 popup 页面调用
`chrome.debugger.getTargets()` 只返回 page/worker/other target，不返回 `type="iframe"`；
`tab_cdp_call Target.getTargets` 返回 `Not allowed`。因此 release 矩阵的 OOPIF 证据使用：

1. 同源 iframe → 跨站 iframe 的 **renderer 进程数增量**（RC-N5/RC-A7 实测 +1）；
2. 跨站子帧坐标的 AI 输入落地（parent `childClicks` +1，主帧不变）；
3. HUMAN 下顶层/子帧坐标的原始 debugger 输入被内核拒绝（RC-A7）；
4. `Page.getFrameTree` 主帧 URL 记录跨站 `frame=` 参数。

这不是产品 OOPIF 失败，而是扩展 `getTargets` API 的可见性限制；已写入报告 `notes`。

### 10.2 `Page.setWebLifecycleState` 在隐藏 iframe 页面上的浏览器崩溃（test-only 风险）

在一次早期探测中，对 **hidden + 同源 iframe** 页面调用
`tab_cdp_call Page.setWebLifecycleState {state:"active"}` 触发了浏览器进程崩溃
（chrome.exe exit `2147483651`，crash key 显示 `debugger.sendCommand`）。该方法是
test-only CDP 控制，不是产品命令；release runner 在 N2/N3（无 iframe 页面）继续使用它，
在 N5/A7（有 iframe）**不使用**，改用 `Page.bringToFront` 兜底或直接靠 renderer 表面。
该现象记录为浏览器/test-control hazard，不当作产品输入仲裁失败。

### 10.3 managed-hidden product screenshot：本轮 PASS，但仍需持续回归

diagnostic 的 F3 曾在 `--in-process-gpu` + managed hidden 下稳定复现产品 screenshot 失败
（P0）。本轮 release-like agent（默认 OOP GPU + Path A 可见启动窗口 + 后续 hidden space）
RC-A6 的产品 screenshot **PASS**（`fromSurface=true`、非 stale、>1000 bytes），原始
`Page.captureScreenshot(fromSurface=true)` 也 PASS。因此本矩阵没有复现 P0，但不把它写成
“P0 已修复”：产品截图路径仍应作为回归项保留。

### 10.4 产品 `reload` 命令不适合作为 SW 重启测试手段

本 runner 的 SW 重启用**验证式终止扩展 renderer**（PID + exe + 命令行含
`--extension-process`），Chrome 自动重启 SW 并重连 host（本轮 30.6s；早期探测曾 2.1s/21s，取决于 SW 唤醒时机）。产品 `reload`
命令在本测试 profile 下会让未打包扩展进入
`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`（disable_reasons 16777216），SW 不再自动恢复；
这属于 test profile 的 developer-mode 限制，不是产品 SW 恢复缺陷。若未来要让
`reload` 可用，需要在测试 profile 里显式开启 developer mode（受保护 pref，未在本任务修改）。

### 10.5 完全遮挡窗口的输入/冻结

本机用户前台是最大化的文件资源管理器，后台 Chrome 窗口会被 Chromium 判定为
occluded/hidden。RC-N2/N3 用 `Page.setWebLifecycleState("active")` + focus emulation
让 renderer 处理输入；RC-N5 在长时间隐藏后使用 `Page.bringToFront` 兜底。这些是
**测试控制**，不是 launch flag；N4 的截图新鲜度仍然使用真实的原生遮挡窗口
（WS_EX_NOACTIVATE topmost）验证。

### 10.6 持久 profile 的状态

`profile-normal` / `profile-agent` 跨运行保留（满足 “persistent isolated test Profile”）。
若上一次运行崩溃留下窗口/space 状态，runner 使用唯一 token 的 space 和每 case 清理；
需要完全干净复现时用 `--fresh-profile`（只删除专用测试目录）。

## 11. 证据

- 最终报告：`D:\c\logs\release-candidate-e2e-2026-10-31T19-10-32-428Z.json`
  （`verdict=PASS`、`checks=210/210`、`cases`、`flagClassification`、`comparison`、
  `s5Mapping`、`sessions[].args`、`sessions[].browser.gpu`、
  `sessions[].browserLog.patterns`（两个会话 FATAL/CHECK/crash 均为 0）、
  `cleanup.registryAfter={after:"D:\work\chrome\plugin-v1\native-host\host.manifest.json", restored:true}`）。
- 运行目录：`.e2e-tmp/release-candidate-2026-10-31T19-08-10-853Z/`
  （`artifacts/rc-normal-chrome.log`、`artifacts/rc-agent-chrome.log`、`report.json`、
  `mode-normal/`、`mode-agent/`）。
- 静态门禁：`npm run check:process-cleanup`、`npm run test:process-safety`、
  `npm run typecheck`（本 runner 为 `.mjs`，typecheck 只覆盖 TS 产品代码）。

## 12. 复现清单

```bash
npm run build && npm run build:host
npm run check:process-cleanup
npm run test:process-safety
npm run test:rc:release:matrix
npm run test:rc:release                 # 全量，约 2–3 分钟
node scripts/test-release-candidate-e2e.mjs --mode=normal --no-build
node scripts/test-release-candidate-e2e.mjs --mode=agent --no-build
node scripts/test-release-candidate-e2e.mjs --mode=agent --case=RC-A5 --no-build
node scripts/test-release-candidate-e2e.mjs --mode=agent --case=RC-A8 --no-build
```

## 13. 与 diagnostic 结果的关系（一句话）

**diagnostic 回答“内核/扩展逻辑在受控环境下是否正确”；release 回答“去掉 test-only 参数后，
同一条产品链路是否仍然正确”。** 本文件只报告后者；前者请继续看
`docs/input-arbitration-e2e-matrix-2026-10-28.md`。两份结果不合并、不互相改写。
