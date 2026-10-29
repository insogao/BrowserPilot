---
type: TestMatrix
status: implemented
generated: { by: agent-l, at: 2026-10-28T23:40:00+08:00 }
stale_after: 2027-04-28
scope: P3 输入权（Input Ownership）真实 Browser/OOPIF E2E：用例矩阵、实跑证据、blocked 依赖与已知限制
---

# 输入仲裁真实 E2E 矩阵（P3，Windows，可见窗口）

> 配套实现：`scripts/test-input-arbitration-e2e.mjs` + `tests/fixtures/input-arbitration-main.html`
> + `tests/fixtures/input-arbitration-frame.html`。
> 设计依据：`docs/input-ownership-design-2026-10-28.md` §11（审核决定）、§12（扩展侧）、§13（内核侧）。
>
> **结论**：可跑的 20 个用例全部实跑通过（76/76 checks），8 个用例因依赖
> Agent J 的 patch 028 修订 / Agent K 的产品 API 而 **blocked**；因此本轮 verdict 是
> **PARTIAL**，不是 PASS。blocked 用例没有用任何方式伪造通过。

---

## 0. 一句话结论

在**真实产品链路**（可见的补丁 Chrome → 扩展 SW → native host → `chrome.debugger` → 真实
`Input.dispatch*`）上已经证明：

1. `ownership=user`（HUMAN）时扩展命令层对 **12 个输入类命令**全部返回 `INPUT_HUMAN_OWNED`，
   页面点击计数 / 输入值 / 滚动 / `__jsRuns` 全部不变；真实人类鼠标与键盘输入**不被锁**。
2. `--enable-features=InputOwnershipEnforcement`（Feature on）时，**所有 CDP `Input.*`**
   被内核以可诊断的 `-32000 "InputOwnership: debugger input rejected (no valid grant for this
   session)"` 拒绝，DOM 零变化；`Runtime.evaluate` 仍可改 DOM —— **这是输入事件仲裁的边界，
   不是完整的页面修改隔离**。
3. 跨站 iframe（`127.0.0.1` vs `127.0.0.2` + `--site-per-process`）确实以独立 OOPIF target
   存在；AI 点击落在子帧、主帧计数不变；Feature on 时子帧点击同样被内核拒绝，而人类子帧点击
   仍然落地。
4. 两个窗口一个 HUMAN 一个 AI 时输入仲裁互不干扰；前台窗口与 `GW_HWNDPREV` 在全部操作前后
   完全不变。
5. Feature off（不传 `--enable-features`）时完整输入序列（click/hover/wheel/key/insertText/js）
   与基线一致，全部落地。

---

## 1. 运行方式

```bash
# 只打印矩阵与前置条件（不启动浏览器、不写注册表）
npm run test:input-arbitration:matrix

# 全部可跑用例（off + on 两个会话；默认先 npm run build + build:host）
npm run test:input-arbitration

# 复用现有 dist / host exe
node scripts/test-input-arbitration-e2e.mjs --no-build

# 按阶段 / 按 Feature 过滤
node scripts/test-input-arbitration-e2e.mjs --stage=human,takeover,shapes --feature=off
node scripts/test-input-arbitration-e2e.mjs --stage=baseline --no-build

# 失败时保留浏览器进程（仍会清理 host 与注册表）
node scripts/test-input-arbitration-e2e.mjs --keep-open
```

阶段：`human`、`takeover`、`assist`、`shapes`、`oopif`、`multi`、`baseline`、`kernel`、`all`。

报告：`D:\c\logs\input-arbitration-e2e-<timestamp>.json`（另有
`.e2e-tmp/input-arbitration-<run>/report.json` 与 `artifacts/feature-<off|on>-chrome.log`）。
`verdict` 只会在「无失败且无 blocked」时为 `PASS`；有 blocked 为 `PARTIAL`；基础设施失败为
`BLOCKED`。

## 2. 环境与隔离

| 项 | 值 |
| --- | --- |
| 浏览器 | `D:\c\src\out\WinDev\chrome.exe`（可用 `BROWSERPILOT_PATCHED_CHROME` 覆盖） |
| 扩展 | 本仓库 `dist/`（`npm run build`） |
| native host | 本仓库 `native-host/dist/browserpilot-host-*.exe`（`npm run build:host`） |
| profile | 每次运行独立 `.e2e-tmp/.../feature-<x>/chrome-profile`，`--user-data-dir` 唯一 |
| LOCALAPPDATA | 每次运行独立目录（host session 文件隔离，不碰用户真实 `%LOCALAPPDATA%`） |
| 注册表 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserpilot.browseragent`，运行前备份、结束后 `unregister.ps1` 恢复并核验；HKLM 从不写入。**残留自愈**：如果上次运行被强杀、HKCU 残留本仓库 manifest，harness 会从 `.e2e-tmp/*/registry-backup` 回溯出用户原始值并写回（本轮实测：`D:\work\chrome\plugin-v1\native-host\host.manifest.json` 被正确恢复，报告 `staleOurManifestDetected=true`） |
| 沙箱 | **不使用** `--no-sandbox`；**不使用** `--headless`；不使用 `--use-mock-keychain`（macOS 专用） |
| 关键参数 | `--in-process-gpu`、`--site-per-process`、`--remote-debugging-port=0`（仅用于 OOPIF 观测） |
| 测试专用参数 | `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion`：让被其它窗口遮挡的测试窗口仍然渲染/可命中，否则 CDP 输入会在命中测试阶段被丢弃（不改变仲裁逻辑） |
| Feature | 默认不传 `--enable-features`；kernel 用例显式 `--enable-features=InputOwnershipEnforcement`（仅测试；产品默认关闭） |
| 进程清理 | 只走 `scripts/lib/test-process.mjs`（PID + 创建时间 + 命令行 marker + exe 路径核验）；无按镜像名清理 |

## 3. 真实链路与两个观测通道

**输入链路**：Node（TCP client，`agent:e2e-a`）→ native host → 扩展 SW → `chrome.debugger` →
`Input.dispatchMouseEvent / dispatchKeyEvent / insertText` → RenderWidgetHost → renderer。

**人类输入**：`PostMessage(WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP/WM_KEYDOWN/WM_KEYUP)` 到
`Chrome_RenderWidgetHostHWND` 子窗口。该窗口的 `WndProc` 会把坐标映射到父窗口并走
`WindowEventTarget::HandleMouseMessage/HandleKeyboardMessage` → `RenderWidgetHostViewAura`，
即**与 OS 人类输入同一条 aura 路径**，事件**不带 `kFromDebugger`**，因此在仲裁器眼里就是人类输入。
它不是硬件输入：修饰键状态来自 `GetKeyState`（所以 Ctrl 组合不通过这条通道验证），wheel 在该
非前台窗口里也不产生滚动；这两点都明确记录为限制，不用脚本 `dispatchEvent` 冒充。

**页面状态观测**：fixture 每 200ms 把完整状态 `POST /state?token=...` 回 harness 的本地
fixture server。HUMAN 模式下扩展会拒绝 `js`（`Runtime.evaluate` 也被纳入输入类命令），因此
**HUMAN 用例绝不能靠 `js` 读页面**；beacon 不经过扩展，是 HUMAN / Feature-on / OOPIF 用例的
唯一可信观察面。

## 4. 用例矩阵

图例：`PASS` = 本轮真实执行通过；`BLOCKED` = 依赖未就绪，未执行、未伪造。

| # | 阶段 | Feature | 状态 | 用例 / 断言 | 实测证据（摘要） |
|---|---|---|---|---|---|
| H1 | human | off | **PASS** | `handoff_space` 后 12 个输入类命令全部 `INPUT_HUMAN_OWNED`；DOM 不变 | 12/12 拒绝；clicks 1→1、events 4→4、input/scroll/jsRuns/child 全不变 |
| H2 | human | off | **PASS** | HUMAN 下人类鼠标/键盘不被锁；AI 仍被拒 | 人类点击 clicks 1→2（`isTrusted=true`）；键盘输入值 `humankeyboard`；AI click 仍 `INPUT_HUMAN_OWNED` 且 clicks 不变 |
| H3 | human | off | **PASS** | `claim_space` 后恢复 AI 输入 | mode `human→ai`；AI click 落地 |
| H4 | takeover | off | **PASS** | AI 逐字输入期间注入人类点击；显式接管后 AI 立刻被拒、人类仍可用 | type 成功；人类点击 +1；handoff 后 AI click `INPUT_HUMAN_OWNED`、人类点击再 +1 |
| A1 | assist | - | **BLOCKED** | ASSIST 无 grant 全部拒绝（扩展命令层） | 依赖：产品级 `human_presence` / `grant_input` 入口（`markInternalCommand`） |
| A2 | assist | - | **BLOCKED** | grant 按命令消费 1 次 | 同上 |
| A3 | assist | - | **BLOCKED** | grant 过期 / 用尽 / 取消 / ownership 变更 | 同上 |
| A4 | assist | off | **PASS** | 第二个 Agent 客户端不能复用他人 space/grant | `click` 与 `input_status` 均 `SPACE_NOT_OWNED`；DOM 不变 |
| S1 | shapes | off | **PASS** | 连续文本 type / fill（含中文） | `hello world` + `中文填充-输入仲裁`；input 事件递增 |
| S2 | shapes | off | **PASS** | 拖拽（多 move + release） | 产品 drag：down1/move1/up1/dstUp1；显式 buttons:1 序列：moves 1→5、movesDown 0→4、dstUp 1→2 |
| S3 | shapes | off | **PASS** | 页面内按键组合 Ctrl+A | 页面收到 `key=a ctrl=true trusted=true target=input`；选区 0..20 覆盖全文 |
| S4 | shapes | off | **PASS** | 中文 IME 提交路径（`Input.insertText`/`ImeCommitText`） | 输入框值 `输入仲裁测试` |
| S5 | shapes | - | **BLOCKED** | 真实 TSF/搜狗 IME 组合输入 | 会切换/污染用户输入法状态，未自动化；不用 `dispatchEvent` 冒充 |
| S6 | shapes | on | **PASS** | Feature on：type/fill/key/drag/wheel 全部被内核拒绝且 DOM 不变 | 5/5 `-32000` 内核拒绝；input/keys/drag/wheel 全不变 |
| O1 | oopif | off | **PASS** | 跨站 iframe 是独立 OOPIF target | `Target.getTargets` 返回 `type=iframe, url=http://127.0.0.2:<p>/frame.html, parentId=<page target>` |
| O2 | oopif | off | **PASS** | AI 点击落在子帧，主帧计数不变 | 点击 (182,372)：childClicks 0→1，主帧 clicks 0→0；子帧 `isTrusted=true` |
| O3 | oopif | off | **PASS** | 人类点击落在子帧 | childClicks +1（人类输入不被锁） |
| O4 | oopif | on | **PASS** | Feature on：AI 子帧点击被拒、人类子帧点击仍落地 | AI：`-32000` 且 childClicks 不变；人类：childClicks +1 |
| M1 | multi | off | **PASS** | 一个 HUMAN 一个 AI 互不干扰 | A：AI 被拒（clicks 0→0），人类点击 0→1；B：AI 点击 0→1 |
| M2 | multi | off | **PASS** | 前台 / z-order 不变 | foreground 590308→590308；A above 101780966 不变；B above 31985640 不变 |
| M3 | multi | on | **PASS** | Feature on：两窗口 AI 都被拒、人类都可用 | A/B AI 均 `-32000` 且 clicks 不变；A/B 人类点击各 +1 |
| F1 | baseline | off | **PASS** | Feature off：完整 AI 输入序列全部落地 | click/hover/wheel/key/insertText/js 全成功；clicks+1、wheel 事件+1（deltaY -400）、jsRuns+1 |
| F2 | baseline | on | **PASS** | Feature on：所有 CDP `Input.*` 被显式拒绝；`Runtime.evaluate` 仍可改 DOM | 7/7 `-32000`；DOM 不变；`js` 返回 ok 且 `#count` 变为 `js-touched` |
| F3 | baseline | on | **PASS** | Feature on（无 K API）产品输入面 100% fail-fast；非输入命令可用 | 11/11 输入命令失败且错误可识别；`list_tabs`/`input_status`/`screenshot` 可用 |
| K1 | kernel | on | **BLOCKED** | 内核 HUMAN 模式（`setOwnership(human)`） | 依赖：K 的 `browserCli.inputOwnership.setOwnership` |
| K2 | kernel | on | **BLOCKED** | 内核 grant 一次性消费 / 过期 / 用尽 / 手势级扣减 | 依赖：J 的 patch 028 修订 + K 的 `grantInput` |
| K3 | kernel | on | **BLOCKED** | 跨会话注入：第二个 CDP 客户端不得复用 grant | 同上（且 `chrome.debugger` 与第三方 CDP 对同一 target 存在 attach 互斥，需要在设计里明确） |
| K4 | kernel | on | **BLOCKED** | `human_presence` 300ms 去抖与 pause 策略 | 依赖：K 的 `onHumanPresence` + J 的 pause 语义 |

**本轮汇总**：执行 20（PASS 20 / FAIL 0），blocked 8，checks 76/76，`verdict=PARTIAL`。
最终报告：`D:\c\logs\input-arbitration-e2e-2026-10-29T07-32-15-848Z.json`（content.dll mtime `2026-10-29T07:27:47.855Z`）。

## 5. Blocked 用例的依赖与解锁条件

| code | 用例 | 依赖 | 解锁后需要补的断言 |
| --- | --- | --- | --- |
| `assist-internal-entry-missing` | A1–A3 | 产品级「用户入口」：popup 操作或内核 `onHumanPresence` 事件桥，能在 SW 内用 `markInternalCommand()` 发 `grant_input` / `human_presence` | ASSIST 无 grant 拒绝、grant 一次成功二次拒绝、过期/用尽/取消后拒绝 |
| `K-api-missing` | K1、K4 | Agent K：`chrome.browserCli.inputOwnership.setOwnership / grantInput / onHumanPresence`（当前 chrome.dll 只有 `getCapabilities`：`binaryHas("browserCli.setInputOwnership")=false`） | HUMAN 模式内核丢弃 + `Runtime.evaluate` 不受影响；presence 去抖与 pause |
| `J-patch028-grant-revision` | K2、K3 | Agent J：patch 028 修订（绝对 grant 截止、DevTools session 绑定、human pause） | grant 绝对过期、session 绑定、跨会话隔离、手势级扣减 |
| `real-ime-not-automatable` | S5 | 真实 TSF/搜狗 + 系统输入法状态 | 真实组合输入（候选窗、上屏）路径下 AI 输入仍被仲裁 |

当前构建已包含 patch 028 的 **内核拒绝路径**（`InputHandler` 对 `Input.*` 显式返回
`-32000`），但**没有**产品写入口；因此 Feature on 时扩展侧 `mode=ai`、内核侧默认 `ASSIST`
且无 grant，所有 AI 输入都会 fail-fast（见 §6.2）。

## 6. 新发现 / 风险

### 6.1 产品 drag 的 `mouseMoved` 没有 buttons 位（已记录，不在本任务修改范围）

`src/background/actions.ts::drag` 发送 `mouseMoved` 时没有 `buttons: 1`。页面里常见的
`e.buttons === 1` 拖拽判定因此看不到「按住移动」：本轮 `movesDown=0`，只有 `mousemove`
事件本身（`moves=1`）和 `mouseup`（`dstUp=1`）。用显式 `buttons:1` 的 CDP 序列可以证明多 move
输入投递正常（moves 1→5、movesDown 0→4），但**产品 drag 在严格页面上可能失效**是一处真实风险。
`actions.ts` 属于本任务禁改文件，仅记录。

### 6.2 Feature on 且没有 K API = 产品输入面整体不可用

Feature on 时内核快照默认 `ASSIST`、无 grant，而扩展无法推送 mode（没有 K API）。结果是
`click/type/fill/drag/press/wheel/down/up` 全部以内核错误失败（F3 11/11）。这不是 bug，而是
「fail closed + 写入口缺失」的必然中间态，但它意味着**打开 Feature 必须与 K 的 API 同批上线**，
否则等于禁用 AI 输入。错误是可诊断的 `-32000`，不是静默成功；扩展层与内核层都不会把这种情况
误报为成功。

### 6.3 输入仲裁的边界：`Runtime.evaluate` 不受影响

Feature on 时 `js`（`Runtime.evaluate`）仍可改 DOM（F2：`#count` 变为 `js-touched`）。
扩展命令层在 HUMAN 下会拒绝 `js`（H1），但**内核仲裁只覆盖输入事件**。任何声称「页面不能被
修改」的说法都超出了本 patch 的能力；这是设计 §13 的明确边界。

### 6.4 多个 `Chrome_RenderWidgetHostHWND` 同时存在

Windows 上每个 Chrome 窗口可能同时有 2 个以上 legacy render widget HWND（本轮见到
`924x549 visible=true` 与 `924x605 visible=false`，两者都能把输入送到页面；其中 `visible`
标志并不可靠）。harness 因此**逐个候选尝试**并向报告记录实际生效的 HWND，避免把「发到了错误的
子窗口」误判成仲裁失败。这也说明：用 Win32 消息做「人类输入」注入时，不能只按可见性选窗口。

### 6.5 wheel 的可观察语义

`Input.dispatchMouseEvent{mouseWheel}` 在该非前台测试窗口里能到达页面（`wheel` 事件、
`deltaY=-400`、target=`#scroll`），但 `scrollTop` 不推进（compositor 滚动需要活动窗口/异步帧）。
因此 wheel 的投递证据用页面 `wheel` 事件，`scrollTop` 仅作观察值。人类 wheel（PostMessage）在
本环境不产生滚动，未作为断言。

### 6.6 HUMAN 下必须使用外观测通道

HUMAN 时 `js` / `tab_cdp_call` 都被拒绝，任何通过扩展读取页面状态的做法都会失败。因此
harness 用 fixture 的 HTTP beacon。这一点对后续所有 HUMAN/ASSIST 测试都成立，建议作为约定。

### 6.7 共享构建目录在会话期间被重建（证据必须绑定构建时间）

`D:\c\src\out\WinDev` 正被其它 Agent 并发重建：本轮开始时段 `content.dll` 还是
「静默丢弃」版本（AI 鼠标命令返回成功但页面无输入），到 07:27Z 已被换成带 **session 绑定 +
显式拒绝** 的新版本（`InputHandler` 返回 `-32000 "debugger input rejected (no valid grant for
this session)"`）。同一份 harness 在两次构建上观察到不同语义，说明：

1. patch 028 的修订正在实时落地，任何「内核行为」结论都必须带上构建时间；
2. harness 在报告 `env.contentDllMtime` 里记录该值（本轮最终运行：
   `2026-10-29T07:27:47.855Z`，`chromeDllApi=false`）；
3. K1–K4 仍然 blocked：新构建只加了拒绝路径，仍然没有产品写入口。

## 7. 未覆盖 / 明确排除

1. **触摸/手势**：patch 028 未把 `Input.dispatchTouchEvent` 接到仲裁点（设计 §13.10）。
2. **真实 IME**：见 S5。
3. **浏览器 UI 快捷键**（Ctrl+L/T/W/F5）：按设计决定 6 不纳入页面输入权；本 harness 不触发，
   避免改变窗口/导航。
4. **第三方 CDP 客户端跨会话注入**：`chrome.debugger` 与第二个 CDP 客户端对同一 target 存在
   attach 互斥；需要在 K/J 的 API 落地后设计（`Target.attachToTarget` 失败语义本身也要测）。
5. **人类 wheel / 人类 IME**：PostMessage 通道不支持（详见 §3）。
6. **内核 HUMAN/ASSIST 模式本身**：K1–K4 blocked（见 §5）。

## 8. 复现清单

```bash
npm run build && npm run build:host     # 或加 --no-build 复用
npm run check:process-cleanup           # 静态清理门禁
npm run test:input-arbitration:matrix   # 前置条件 + 矩阵
npm run test:input-arbitration          # 全量（约 3-5 分钟，两次可见浏览器会话）
```

产物：

- 报告：`D:\c\logs\input-arbitration-e2e-<ts>.json`
- 运行目录：`.e2e-tmp/input-arbitration-<ts>/`（`report.json`、`artifacts/feature-off-chrome.log`、
  `artifacts/feature-on-chrome.log`、`win32-helper.ps1`）
- 每个用例的 `evidence` 都包含原始页面状态（beacon 快照）、命令返回值与 Win32 候选窗口尝试记录。

## 9. 与设计文档的对应关系

| 设计要求 | 本矩阵证据 |
| --- | --- |
| §4.1 人类输入永不锁死 | H2、H4、O3、M1、M3 |
| §4.4 HUMAN 下 AI 输入 fail-fast | H1（扩展层 `INPUT_HUMAN_OWNED`）、F2/F3（内核层 `-32000`） |
| §13.3 三个 `Forward*` 汇合点 | F2（mouse/wheel/key 全拒）、S6 |
| §13.4 `Input.insertText` 第四条路径 | S4（off 成功）、S6（on 拒绝） |
| OOPIF 不绕过 | O1–O4 |
| Feature 关闭行为不变 | F1（与基线一致）、全部 off 用例 |
| 多窗口/前台隔离 | M1–M3（foreground / `GW_HWNDPREV` 不变） |
