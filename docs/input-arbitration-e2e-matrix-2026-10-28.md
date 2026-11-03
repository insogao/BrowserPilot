---
type: TestMatrix
status: implemented
generated: { by: agent-l, at: 2026-10-28T23:40:00+08:00, updated: 2026-10-29T17:35:00+08:00 }
stale_after: 2027-04-28
scope: P3 输入权（Input Ownership）真实 Browser/OOPIF E2E：用例矩阵、实跑证据、blocked 依赖与已知限制
---

# 输入仲裁真实 E2E 矩阵（P3，Windows，可见/托管窗口）

> 配套实现：`scripts/test-input-arbitration-e2e.mjs` + `tests/fixtures/input-arbitration-main.html`
> + `tests/fixtures/input-arbitration-frame.html`。
> 设计依据：`docs/input-ownership-design-2026-10-28.md` §11（审核决定）、§12（扩展侧）、§13（内核侧）。
>
> **结论（最终，含 N 的 popup 用户入口）**：
> - **A1–A3 PASS**：真实 popup 用户入口（`#space-select` / `#grant-input` / `sendMessage`）驱动
>   `human_presence`/`grant_input`；ASSIST 无 grant 拒绝、授权一次成功一条命令、第二条拒绝、
>   新 presence 清 grant、handoff 清 assist、60s 过期全部实测。
> - **K0–K3 PASS**（未跟踪窗口，不受扩展自动同步干扰）：API 可用性、HUMAN 模式与版本语义、
>   grant 一次性消费/TTL/用尽/scope/cancel/session detach、跨 CDP session 隔离。
> - **R1/R2 PASS**（连续 5 次）：SW 重启后 API 重探/版本不回退/heartbeat 重放/输入恢复；
>   30s 无心跳 → stale=true/effective ASSIST/输入被拒 → heartbeat 恢复。
> - **K4 BLOCKED**：冷启动 `--browser-cli-user-explicit-show` 仍创建 hidden 窗口
>   （`visible=false`），无法注入人类输入（§6.10）。**S5 BLOCKED**（真实 IME）。
> - **F3 P0 稳定复现 3/3**：managed hidden 产品 screenshot 失败（原始 CDP fromSurface=true 成功）。
> - 扩展现在会自动 `setOwnership(ai)` + 10s heartbeat 同步其 Task Space；任何“在 tracked tab
>   上直接改内核 mode”的测试都会被拉回 ai —— K0–K3 因此改用未跟踪窗口（§10）。
> verdict 只在无 blocked/无 P0 时为 PASS；本轮最终为 **PARTIAL**，blocked/P0 未伪造。
---

## 0. 一句话结论

在**真实产品链路**（可见的补丁 Chrome → 扩展 SW → native host → `chrome.debugger` → 真实
`Input.dispatch*`）上已经证明：

1. `ownership=user`（HUMAN，扩展命令层）时 **12 个输入类命令**全部返回
   `INPUT_HUMAN_OWNED`，页面点击计数 / 输入值 / 滚动 / `__jsRuns` 全部不变；真实人类鼠标与
   键盘输入**不被锁**；`claim_space` 后恢复。
2. `--enable-features=InputOwnershipEnforcement`（Feature on）时，**所有 CDP `Input.*`**
   被内核以可诊断的 `-32000 "InputOwnership: debugger input rejected (no valid grant for
   this session)"` 拒绝，DOM 零变化；`Runtime.evaluate` 仍可改 DOM —— **这是输入事件仲裁的
   边界，不是完整的页面修改隔离**。
3. 跨站 iframe（`127.0.0.1` vs `127.0.0.2` + `--site-per-process`）确实以独立 OOPIF target
   存在；AI 点击落在子帧、主帧计数不变；Feature on 时子帧点击同样被内核拒绝。
4. 两个窗口一个 HUMAN 一个 AI 时输入仲裁互不干扰；前台窗口与 `GW_HWNDPREV` 在全部操作前后
   完全不变。
5. Feature off（不传 `--enable-features`）时完整输入序列（click/hover/wheel/key/insertText/js）
   与基线一致，全部落地。
6. **patch 029 最终构建的生产 API 完全可用**：顶层 `chrome.browserCliInputOwnership`
   （setOwnership/grantInput/beginInputCommand/endInputCommand/heartbeat/getOwnership/
   onHumanPresence）在受信扩展页面里可调用；**K0–K3 全部 PASS**。
7. `grantInput` 的 session 绑定按扩展自己的 debugger 会话生效：未 attach 返回
   `NO_DEBUGGER_SESSION`；attach 后 grant 可用；第二个 CDP 会话无法复用（K2/K3）。
   早期构建曾因 `GetForTab` 与 `chrome.debugger.attach` 使用不同 agent host 而一直
   `NO_DEBUGGER_SESSION`，该问题已在最终构建修复（见 §6.8 的排查记录）。

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
node scripts/test-input-arbitration-e2e.mjs --stage=kernel --feature=on --no-build
node scripts/test-input-arbitration-e2e.mjs --stage=assist --feature=on --no-build
node scripts/test-input-arbitration-e2e.mjs --stage=resilience --feature=on --no-build
node scripts/test-input-arbitration-e2e.mjs --stage=baseline --feature=on --no-build
node scripts/test-input-arbitration-e2e.mjs --stage=baseline --no-build

# 失败时保留浏览器进程（仍会清理 host 与注册表）
node scripts/test-input-arbitration-e2e.mjs --keep-open
```

阶段：`human`、`takeover`、`assist`、`shapes`、`oopif`、`multi`、`baseline`、`kernel`、`all`。

报告：`D:\c\logs\input-arbitration-e2e-<timestamp>.json`（另有
`.e2e-tmp/input-arbitration-<run>/report.json` 与 `artifacts/feature-<off|on>-chrome.log`）。
`verdict`：只有「无失败、无 blocked、无 P0」才是 `PASS`；有 blocked 或 P0 为 `PARTIAL`；
基础设施失败或所有选中用例都 blocked 为 `BLOCKED`。

## 2. 环境与隔离

| 项 | 值 |
| --- | --- |
| 浏览器 | `D:\c\src\out\WinDev\chrome.exe`（可用 `BROWSERPILOT_PATCHED_CHROME` 覆盖） |
| 扩展 | 本仓库 `dist/`（`npm run build`） |
| native host | 本仓库 `native-host/dist/browserpilot-host-*.exe`（`npm run build:host`） |
| profile | 每次运行独立 `.e2e-tmp/.../feature-<x>/chrome-profile`，`--user-data-dir` 唯一 |
| LOCALAPPDATA | 每次运行独立目录（host session 文件隔离，不碰用户真实 `%LOCALAPPDATA%`） |
| 注册表 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browserpilot.browseragent`，运行前备份、结束后 `unregister.ps1` 恢复并核验；HKLM 从不写入。**残留自愈**：上次运行被强杀留下本仓库 manifest 时，从 `.e2e-tmp/*/registry-backup` 回溯用户原始值写回。 |
| 沙箱 | **不使用** `--no-sandbox`；**不使用** `--headless`；不使用 `--use-mock-keychain`（macOS 专用） |
| 关键参数 | `--in-process-gpu`、`--site-per-process`、`--remote-debugging-port=0`（OOPIF 观测 + 受信扩展页面调用 + 第二 CDP session） |
| 测试专用参数 | `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion` |
| Feature off 会话 | 不传 `--enable-features`，不传 managed 模式 |
| Feature on 会话 | `--enable-features=InputOwnershipEnforcement` **+ `--browser-cli-background-presentation`**（生产 API 的 availability 与 trust 检查都要求 managed 模式） |
| managed 窗口 | 窗口以 hidden 创建（`visible=false`）；`findWindowByToken` 接受隐藏窗口，`moveAndSettle` 用 `SWP_SHOWWINDOW|SWP_NOACTIVATE` 尝试显示（Chrome 仍保持 hidden，这是托管模式的预期行为） |
| 进程清理 | 只走 `scripts/lib/test-process.mjs`（PID + 创建时间 + 命令行 marker + exe 路径核验）；无按镜像名清理 |

## 3. 真实链路与观测/调用通道

**AI 输入链路**：Node（TCP client）→ native host → 扩展 SW → `chrome.debugger` →
`Input.dispatchMouseEvent / dispatchKeyEvent / insertText` → RenderWidgetHost → renderer。

**人类输入**：`PostMessage(WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP/WM_KEYDOWN/WM_KEYUP)` 到
`Chrome_RenderWidgetHostHWND` 子窗口。该窗口的 `WndProc` 会把坐标映射到父窗口并走
`WindowEventTarget::HandleMouseMessage` → `RenderWidgetHostViewAura`，与 OS 人类输入同一条
aura 路径，**不带 `kFromDebugger`**。限制：修饰键状态来自 `GetKeyState`（Ctrl 组合不通过这条
通道验证）；managed hidden 窗口里该通道无法命中页面（O4/M3/K1 会显式记录 unverified，不伪造）。

**页面状态观测**：fixture 每 200ms 把完整状态 `POST /state?token=...` 回 harness 的本地
server。HUMAN 模式下扩展会拒绝 `js`/`tab_cdp_call`，因此 HUMAN/Feature-on 用例必须用这条
不经过扩展的通道。

**生产 API 调用（patch 029）**：通过浏览器级 CDP 连接到
`chrome-extension://<id>/popup/index.html` 页面，在页面主世界执行
`chrome.browserCli.inputOwnership.*`（真实受信扩展页面，不经过 `chrome.debugger`）。
`grantInput` 绑定的是**扩展自己的 chrome.debugger session**：用例先对 fixture tab 执行
`tab_cdp_call` 完成 attach；未 attach 时 API 返回 `NO_DEBUGGER_SESSION`。

**跨 CDP session**：浏览器级 CDP 客户端可对同一 target 再 `Target.attachToTarget`（concurrent），
用于 K3 的“第二个会话不得复用 grant”。

## 4. 用例矩阵

图例：`PASS` = 本轮真实执行通过；`BLOCKED` = 依赖未就绪，未执行、未伪造。

| # | 阶段 | Feature | 状态 | 用例 / 断言 | 实测证据（摘要） |
|---|---|---|---|---|---|
| H1 | human | off | **PASS** | `handoff_space` 后 12 个输入类命令全部 `INPUT_HUMAN_OWNED`；DOM 不变 | 12/12 拒绝；clicks 1→1、events 4→4、input/scroll/jsRuns/child 全不变 |
| H2 | human | off | **PASS** | HUMAN 下人类鼠标/键盘不被锁；AI 仍被拒 | 人类点击 clicks 1→2（`isTrusted=true`）；键盘输入值 `humankeyboard`；AI click 仍 `INPUT_HUMAN_OWNED` |
| H3 | human | off | **PASS** | `claim_space` 后恢复 AI 输入 | mode `human→ai`；AI click 落地 |
| H4 | takeover | off | **PASS** | AI 逐字输入期间注入人类点击；显式接管后 AI 立刻被拒、人类仍可用 | type 成功；人类点击 +1；handoff 后 AI click `INPUT_HUMAN_OWNED`、人类点击再 +1 |
| A1 | assist | on | **PASS** | popup 用户入口：human_presence + #grant-input | ASSIST 进入且 ownership=agent；无 grant `INPUT_ASSIST_REQUIRES_GRANT`；按钮授权后 click 落地、第二条拒绝（31/31 checks 本阶段） |
| A2 | assist | on | **PASS** | popup sendMessage grant_input 一次性消费 | 无 grant 拒绝、grant actions=1、click 落地、消费后无可用 grant、第二条拒绝 |
| A3 | assist | on | **PASS** | 取消 / ownership 变更 / 60s 过期 | 新 presence 清 grant、handoff 后 `INPUT_HUMAN_OWNED`、60s 后 `INPUT_ASSIST_REQUIRES_GRANT` |
| A4 | assist | off | **PASS** | 第二个 Agent 客户端不能复用他人 space/grant | `click` 与 `input_status` 均 `SPACE_NOT_OWNED`；DOM 不变 |
| S1 | shapes | off | **PASS** | 连续文本 type / fill（含中文） | `hello world` + `中文填充-输入仲裁`；input 事件递增 |
| S2 | shapes | off | **PASS** | 拖拽（多 move + release） | 产品 drag：down1/move1/up1/dstUp1；显式 buttons:1 序列：moves 1→5、movesDown 0→4、dstUp 1→2 |
| S3 | shapes | off | **PASS** | 页面内按键组合 Ctrl+A | 页面收到 `key=a ctrl=true trusted=true`；选区 0..20 覆盖全文 |
| S4 | shapes | off | **PASS** | 中文 IME 提交路径（`Input.insertText`/`ImeCommitText`） | 输入框值 `输入仲裁测试` |
| S5 | shapes | - | **BLOCKED** | 真实 TSF/搜狗 IME 组合输入 | 会切换/污染用户输入法状态，未自动化；不用 `dispatchEvent` 冒充 |
| S6 | shapes | on | **PASS** | Feature on：type/fill/key/drag/wheel 全部被内核拒绝且 DOM 不变 | 5/5 `-32000` 内核拒绝；input/keys/drag/wheel 全不变 |
| O1 | oopif | off | **PASS** | 跨站 iframe 是独立 OOPIF target | `type=iframe, url=http://127.0.0.2:<p>/frame.html, parentId=<page target>` |
| O2 | oopif | off | **PASS** | AI 点击落在子帧，主帧计数不变 | 点击 (182,372)：childClicks 0→1，主帧 0→0 |
| O3 | oopif | off | **PASS** | 人类点击落在子帧 | childClicks +1 |
| O4 | oopif | on | **PASS** | Feature on：AI 子帧点击被拒（人类子帧点击在 managed hidden 下 unverified） | AI：`-32000` 且 childClicks 不变；人类 PostMessage 未命中（已记录，不伪造） |
| M1 | multi | off | **PASS** | 一个 HUMAN 一个 AI 互不干扰 | A：AI 被拒、人类 0→1；B：AI 0→1 |
| M2 | multi | off | **PASS** | 前台 / z-order 不变 | foreground 不变；A/B `GW_HWNDPREV` 不变 |
| M3 | multi | on | **PASS** | Feature on：两窗口 AI 都被拒（人类在 managed hidden 下 unverified） | A/B AI 均 `-32000` 且 clicks 不变 |
| F1 | baseline | off | **PASS** | Feature off：完整 AI 输入序列全部落地 | click/hover/wheel/key/insertText/js 全成功；clicks+1、wheel 事件+1、jsRuns+1 |
| F2 | baseline | on | **PASS** | Feature on：所有 CDP `Input.*` 被显式拒绝；`Runtime.evaluate` 仍可改 DOM | 7/7 `-32000`；DOM 不变；`#count=js-touched` |
| F3 | baseline | on | **PASS** | Feature on：11 个输入命令 fail-fast；非输入命令可用；截图 P0 单列 | 11/11 失败且错误可识别；`list_tabs`/`input_status` 可用；产品截图失败→P0 |
| K0 | kernel | on | **PASS** | 内核 API + 未跟踪窗口 AI 投递 | API 上下文（SW）可用；快照可读；version+1 被接受；mode=ai 时 click 落地 |
| K1 | kernel | on | **PASS** | 内核 HUMAN + 版本语义 + Runtime.evaluate 边界 | human 接受；同版本改 mode VERSION_CONFLICT；v-1 STALE_VERSION；v=0 绑定拒绝；mouse/key/insertText 全 `-32000`；DOM 不变；debugger Runtime.evaluate 可改 DOM；恢复 ai 后 click 落地 |
| K2 | kernel | on | **PASS** | 内核 ASSIST（未跟踪窗口） | 无 grant 拒绝；grant#1 后第 1 条成功、第 2 条拒绝；TTL 150ms 拒绝；scope 内成功、end 后拒绝；cancel 退款；detach/reattach 后拒绝；重新 grant 成功；mode 保持 assist |
| K3 | kernel | on | **PASS** | 跨 CDP session（未跟踪窗口） | 第二个并发 CDP 会话输入 `-32000` 且 DOM 不变；扩展会话 grant 未被消耗；mode/version 不变 |
| K4 | kernel | on-visible | **BLOCKED** | human_presence 事件桥 + 1s pause | 冷启动 `--browser-cli-user-explicit-show` 后唯一窗口 `visible=false`（RAW 状态见 §6.10）；未用第二次 show/外部强制显示 |
| R1 | resilience | on | **PASS** | SW 重启恢复 | stopAllWorkers → SW 重探 API、host 新 session 重连、version 不回退、heartbeat/setOwnership 被接受、AI 输入恢复（5 次连续 PASS） |
| R2 | resilience | on | **PASS** | 30s 心跳失联 | 未跟踪窗口无心跳：31.5s 后 stale=true/mode=ai、输入 `-32000` 拒绝；heartbeat 后 stale=false、输入恢复（5 次连续 PASS） |

**最终汇总**：执行 24（PASS 24 / FAIL 0），blocked 5（A1–A3、S5、K4），checks 118/118，
`verdict=PARTIAL`（仅因 blocked + screenshot P0）。本轮报告：

- 全量：`D:\c\logs\input-arbitration-e2e-2026-10-29T10-05-10-036Z.json`（118/118，PARTIAL）
- `--stage=kernel --feature=on`：`D:\c\logs\input-arbitration-e2e-2026-10-29T10-03-31-201Z.json`
  （58/58 checks；K0–K3 PASS，K4 BLOCKED）
- `--stage=assist --feature=off`：A4 PASS、A1–A3 BLOCKED

## 5. Blocked 用例的依赖与解锁条件

| code | 用例 | 依赖 | 解锁后需要补的断言 |
| --- | --- | --- | --- |
| `managed-visible-show-failed` | K4 | 内核/产品修复用户显式 show 的呈现（冷启动创建窗口后 `Show/Activate` 仍 `visible=false`） | human_presence 事件、1s pause、pause 不消耗 grant |
| `real-ime-not-automatable` | S5 | 真实 TSF/搜狗 + 系统输入法状态 | 真实组合输入（候选窗、上屏）路径下 AI 输入仍被仲裁 |

A1–A3 已由 N 的 popup 用户入口解锁并 PASS；K0–K3 已由 patch 029 的 API + 未跟踪窗口
设计解锁并 PASS；R1/R2 已 PASS。

## 6. 新发现 / 风险

### 6.1 产品 drag 的 `mouseMoved` 没有 buttons 位（已记录，不在本任务修改范围）

`src/background/actions.ts::drag` 发送 `mouseMoved` 时没有 `buttons: 1`。页面里常见的
`e.buttons === 1` 拖拽判定因此看不到「按住移动」：本轮 `movesDown=0`。用显式 `buttons:1` 的
CDP 序列可以证明多 move 输入投递正常（moves 1→5、movesDown 0→4）。`actions.ts` 属于本任务
禁改文件，仅记录。

### 6.2 Feature on 且没有调用方推送 mode = 产品输入面整体不可用

Feature on 时内核快照默认 `ASSIST`、无 grant；扩展侧 mode 仍是 `ai`。由于 production API 在
扩展 JS 不可见（§6.8），没有调用方能推送 mode，`click/type/fill/drag/press/wheel/down/up`
全部以内核错误失败（F3 11/11）。错误是可诊断的 `-32000`，不是静默成功。

### 6.3 输入仲裁的边界：`Runtime.evaluate` 不受影响

Feature on 时 `js`（`Runtime.evaluate`）仍可改 DOM（F2：`#count` 变为 `js-touched`）。
扩展命令层在 HUMAN 下会拒绝 `js`（H1），但**内核仲裁只覆盖输入事件**。

### 6.4 多个 `Chrome_RenderWidgetHostHWND` 同时存在

Windows 上每个 Chrome 窗口可能同时有 2 个以上 legacy render widget HWND（managed 模式下全部
`visible=false`），harness 逐个候选尝试并向报告记录实际生效的 HWND。

### 6.5 wheel 的可观察语义

`Input.dispatchMouseEvent{mouseWheel}` 在该非前台/托管窗口里能到达页面（`wheel` 事件、
`deltaY`、target=`#scroll`），但 `scrollTop` 不推进。因此 wheel 的投递证据用页面 `wheel`
事件，`scrollTop` 仅作观察值。

### 6.6 HUMAN 下必须使用外观测通道

HUMAN 时 `js` / `tab_cdp_call` 都被拒绝，状态读取必须走 fixture HTTP beacon。

### 6.7 共享构建目录在会话期间被重建（证据必须绑定构建时间）

`D:\c\src\out\WinDev` 正被其它 Agent 并发重建：同一份 harness 在不同 `content.dll` 上观察到
不同内核语义（早期静默丢弃 → 现在显式 `-32000`）。报告记录 `env.contentDllMtime` /
`env.contentDllFeature` / `env.chromeDllApi`；最终运行的 API 探测为
`chromeDllApi=true`（`chromeDllApiDetail.namespace=true, setOwnership=true, grantInput=true,
beginInputCommand=true, heartbeat=true`）。

### 6.8 已修复：`grantInput` 的 DevTools session 映射（K2/K3 曾因 `NO_DEBUGGER_SESSION` 阻塞）

**最终状态**：K2（17/17）与 K3（7/7）在最终构建全部 PASS；`grantInput` 正常返回
`granted:true` / `actions` / `expiresAt`，session detach 与第二 CDP 会话都按预期拒绝。
本节保留早期构建的排查记录，供后续回归定位。

**当时现象**：扩展已 attach（`chrome.debugger.getTargets` 显示目标 tab
`attached:true, type:"page"`；浏览器级 `Target.getTargets` 没有 `type:"tab"` 的 target），
`grantInput` 仍返回 `{"granted":false,"reason":"NO_DEBUGGER_SESSION"}`。

**当时的精确失败点**：`browser_cli_input_ownership_api.cc::ResolveDebuggerSession()` 用
`content::DevToolsAgentHost::GetForTab(web_contents)`（`WebContentsDevToolsAgentHost`，仅当存在
tab 级 host 时非空），而扩展 `chrome.debugger.attach({tabId})` 走
`DevToolsAgentHost::GetOrCreateFor(web_contents)`（`RenderFrameDevToolsAgentHost`，
`debugger_api.cc:967`）。两者不是同一个 host，`SessionByClient(client)` 找不到 session。
修复方向即：使用 client 自己的 `agent_host()`（或 `GetOrCreateFor(web_contents)`）取 token。
当前构建已按此修复（K2/K3 实测通过）。

### 6.9 P0：managed hidden 窗口的产品截图失败（与输入仲裁无关）

Feature on + managed 模式下窗口以 hidden 创建：

| 路径 | 结果 |
| --- | --- |
| 产品 `screenshot` 命令 | 失败：合成器 `Page.captureScreenshot(fromSurface=true)` 8000ms 超时 + 浏览器快照 `fromSurface=false` 返回 `-32000 Only screenshots from surface are allowed` |
| 原始 CDP `tab_cdp_call Page.captureScreenshot {fromSurface:true}` | **成功**（约 10 KB PNG） |
| 原始 CDP `Page.captureScreenshot {fromSurface:false}` | `-32000 Only screenshots from surface are allowed` |

说明内核/合成器能出帧，问题在产品截图路径/策略或超时。已在报告
`p0Regressions` 单列为 `P0-managed-hidden-product-screenshot`；**不作为输入仲裁用例的失败**，
也没有伪造截图 PASS。存在 P0 时 verdict 最多为 PARTIAL。

### 6.10 K4：managed hidden 窗口无法注入人类输入（事件桥/pause 未验证）

`onHumanPresence` listener 注册与 `setOwnership(assist)` 均 PASS；但 managed 模式下窗口
`visible=false`，`PostMessage` 注入的鼠标事件无法命中页面（`human.landed=false`），因此
K4 的“人类输入 → presence 事件 → 1s pause”链路在本环境无法验证，按
`managed-human-input-unavailable` blocked。feature-off 的 H2/H4/O3/M1 已用同一条 PostMessage
通道证明人类输入不被锁；这里不伪造。

## 7. 未覆盖 / 明确排除

1. **触摸/手势**：patch 028/029 未把 `Input.dispatchTouchEvent` 等接到仲裁点。
2. **真实 IME**：见 S5。
3. **浏览器 UI 快捷键**（Ctrl+L/T/W/F5）：按设计决定 6 不纳入页面输入权；本 harness 不触发。
4. **managed hidden 窗口的人类输入注入**：PostMessage 无法命中；feature-off 用例已用真实链路
   证明人类输入不被锁，feature-on 的 O4/M3/K1 显式记录 unverified。
5. **内核 presence/pause**：K4 被 §6.10 的 managed hidden 人类输入限制阻塞（K0–K3 已 PASS）。

## 8. 复现清单

```bash
npm run build && npm run build:host     # 或加 --no-build 复用
npm run check:process-cleanup           # 静态清理门禁
npm run test:input-arbitration:matrix   # 前置条件 + 矩阵
npm run test:input-arbitration          # 全量（约 2 分钟，两次浏览器会话）
node scripts/test-input-arbitration-e2e.mjs --stage=kernel --feature=on --no-build
node scripts/test-input-arbitration-e2e.mjs --stage=assist --feature=off --no-build
```

产物：

- 报告：`D:\c\logs\input-arbitration-e2e-<ts>.json`（`cases`、`blocked`、`p0Regressions`、
  `env.chromeDllApiDetail`、每个用例的原始 beacon/命令返回值）
- 运行目录：`.e2e-tmp/input-arbitration-<ts>/`

## 9. 与设计文档的对应关系

| 设计要求 | 本矩阵证据 |
| --- | --- |
| §4.1 人类输入永不锁死 | H2、H4、O3、M1（off）；O4/M3/K1 在 managed hidden 下显式 unverified |
| §4.4 HUMAN 下 AI 输入 fail-fast | H1（扩展层 `INPUT_HUMAN_OWNED`）、F2/F3（内核层 `-32000`） |
| §13.3 三个 `Forward*` 汇合点 | F2（mouse/wheel/key 全拒）、S6 |
| §13.4 `Input.insertText` 第四条路径 | S4（off 成功）、S6（on 拒绝） |
| OOPIF 不绕过 | O1–O4 |
| Feature 关闭行为不变 | F1、全部 off 用例 |
| 多窗口/前台隔离 | M1–M3 |
| 生产 API（patch 029） | K0–K3 PASS（HUMAN/版本/grant 生命周期/跨会话）；K4 被 managed hidden 人类输入阻塞（§6.10） |

## 10. 稳定性分析（K/A/R 抖动根因）

### 10.1 最近运行分布

| 时间 | 阶段 | 结果 | 说明 |
| --- | --- | --- | --- |
| 10:26 | assist（on） | 31/31 PASS | A1–A3 首次通过真实 popup 入口 |
| 10:32–10:34 | resilience（on） | R1 PASS，R2 BLOCKED/FAIL | R2 旧方案：SW 停不掉 / popup attach 冲突 / SW 自动重启立即重放 |
| 10:35 | resilience（on） | 32/32 PASS | R2 改为“未跟踪窗口”（无扩展心跳） |
| 10:36 | kernel（on-visible） | K4 BLOCKED | 冷启动 show 创建窗口但 `visible=false` |
| 10:49 | shapes/oopif/multi/baseline/kernel/resilience（on） | 81/87 | **K2 FAIL×6**：旧 K2 在 tracked tab 上改内核 mode，被扩展 10s heartbeat 拉回 ai；S6/O4/M3/F2/F3/R1/R2/K0/K1/K3 PASS |
| 10:51:02 | kernel（on） | 52/53 | **K1 FAIL**：`version-1=0` 被绑定 schema（minimum 1）拒绝，没进内核 |
| 10:51:30 | kernel（on） | 52/53 | 同上（修复前） |
| 10:51:59 | kernel（on） | **53/53 PASS** | K1 先推进到 v1 再切 human；K0–K3 全 PASS |
| 10:52:56 + 3 次重复 | resilience（on） | **32/32 PASS ×4** | 未跟踪窗口 stale 语义连续 4 次通过 |
| 10:56–10:57 | baseline（on）×3 | 20/20、19/20、20/20 | F3 P0（产品截图）**3/3 复现**；唯一失败是 F2 的 beacon 读早了一拍（已改 `waitState`） |
| 修复后 | baseline（on） | 20/20 PASS（P0 仍记录） | F2 beacon race 已消除 |

### 10.2 flaky 归类与修复

| 用例 | 失败现象 | 归类 | 修复 |
| --- | --- | --- | --- |
| K2（旧实现） | TTL 后 click 仍成功、`endInputCommand` UNKNOWN_COMMAND、结束时 mode=ai/version 3 | **测试干扰**：扩展客户端每 10s `setOwnership(ai)`/heartbeat 同步它自己的 Task Space，覆盖了测试直接写入的 ASSIST（产品行为，非竞态） | K0–K3 改用**未跟踪窗口**（不在 `state.spaces`，没有扩展心跳）；不再依赖 tracked tab |
| K1 | `version-1=0` → 绑定层 `Value must be at least 1`，不是 `STALE_VERSION` | **测试 bug** | 先 `setOwnership(ai)` 到 v1，再切 human 到 v2；stale 用 v1；v0 单独断言绑定层拒绝 |
| R1 | “SW 新 target”断言失败（Chrome 复用 targetId） | **测试断言过严** | 改为“SW target 存在 + 新 host session + version 不回退 + heartbeat/setOwnership/输入恢复” |
| R2（旧方案） | stopAllWorkers 不存在 / popup attach 冲突 / SW 自动重启重放 | **测试环境不可控**（不是产品 stale 失败） | 用未跟踪窗口制造“无心跳目标”，不依赖停 SW；稳定 4 次 |
| F2 | `Runtime.evaluate` 检查偶发失败 | **beacon 读早一拍**（200ms 周期） | 改用 `waitState(countText==='js-touched')` |
| F3 | 产品截图失败 | **产品 P0（稳定）** | 3/3 复现：产品 screenshot 失败，原始 CDP `fromSurface=true` 成功；P0 保留 |

### 10.3 结论

- 未观察到**产品 version/stale/session 竞态**：在未跟踪目标上，30s stale、grant 生命周期、
  跨会话隔离、SW 重启恢复均连续多次稳定通过。
- 抖动全部来自 **测试与产品自动同步的相互干扰**、**测试断言/时序** 或 **测试环境副作用**，
  已逐项修复。
- 仍未验证：A1–A3 在当前最终 harness 上只跑过 1 次（10:26，31/31）；其调用路径
  （popup `sendMessage` + `#grant-input`）在之后的改动中没有变化，但严格说样本数 1。
- K4 的冷启动 show 证据：窗口 `36376234`（标题“新标签页 - Chromium”）`visible=false`；
  producer 日志：`human-ownership-granted` → `decision=allow action=show-and-activate` →
  `result=failed reason=created-window-presentation-denied`。即策略层允许，但创建窗口的
  呈现被 host 拒绝（与 §6.10 一致）。
