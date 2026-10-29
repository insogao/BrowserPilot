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
> **结论（patch 029 后）**：可跑的 20 个用例全部实跑通过（79/79 checks，0 failed）；
> **9 个用例 blocked**：K0–K4（生产 API 已编译进 `chrome.dll`，但本构建里
> `chrome.browserCli.inputOwnership` 在任何扩展 JS 上下文里都不可见 —— 见 §6.8，已单列为 P0）、
> A1–A3（扩展命令层用户入口缺失）、S5（真实 IME）。另有两个 **P0 回归单独记录**：
> 扩展 JS 看不到 inputOwnership、managed hidden 窗口产品截图失败。因此 verdict 是
> **PARTIAL**，不是 PASS；blocked/P0 项没有用任何方式伪造通过。

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
6. **patch 029 的生产 API 在本构建不可达**：`chrome.dll` 已含
   `browserCli.inputOwnership.setOwnership/grantInput/beginInputCommand/heartbeat`，
   `gen/.../api_features.cc`/`generated_schemas.cc` 也已包含该命名空间，但扩展 JS
   （popup 页面与 service worker）只能看到 `getCapabilities`。因此 K1–K4 的完整实现已就位，
   但**没有真实调用方**，保持 blocked（根因与修复建议见 §6.8）。

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
node scripts/test-input-arbitration-e2e.mjs --stage=assist --feature=off --no-build
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
| A1 | assist | - | **BLOCKED** | ASSIST 无 grant 全部拒绝（扩展命令层） | 依赖：产品级 `human_presence` / `grant_input` 入口（`markInternalCommand`） |
| A2 | assist | - | **BLOCKED** | grant 按命令消费 1 次 | 同上 |
| A3 | assist | - | **BLOCKED** | grant 过期 / 用尽 / 取消 / ownership 变更 | 同上 |
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
| K0 | kernel | on | **BLOCKED** | 生产 API 可用性 + managed 窗口检查 | popup/SW 都只有 `getCapabilities`；renderer 收到 feature 与 managed switch；→ API 未安装（§6.8） |
| K1 | kernel | on | **BLOCKED** | 内核 HUMAN：setOwnership(human)、版本语义、Runtime.evaluate 边界 | 实现就绪；依赖 API 暴露修复 |
| K2 | kernel | on | **BLOCKED** | 内核 ASSIST：无 grant、一次性消费、TTL、用尽、scope/取消、session detach | 实现就绪；依赖 API 暴露修复 |
| K3 | kernel | on | **BLOCKED** | 跨 CDP session 不得复用 grant | 实现就绪；依赖 API 暴露修复 |
| K4 | kernel | on | **BLOCKED** | human_presence 事件桥 + 1s human pause | 实现就绪；依赖 API 暴露修复 + managed 窗口人类输入 |

**最终汇总**：执行 20（PASS 20 / FAIL 0），blocked 9（A1–A3、S5、K0–K4），checks 79/79，
`verdict=PARTIAL`。本轮报告：

- 全量：`D:\c\logs\input-arbitration-e2e-2026-10-29T09-32-43-483Z.json`（79/79，PARTIAL）
- `--stage=kernel --feature=on`：`D:\c\logs\input-arbitration-e2e-2026-10-29T09-33-48-609Z.json`
  （19/19 checks 全 PASS，K0–K4 全 BLOCKED，verdict=BLOCKED）
- `--stage=assist --feature=off`：`D:\c\logs\input-arbitration-e2e-2026-10-29T09-34-08-053Z.json`
  （17/17，A4 PASS、A1–A3 BLOCKED，PARTIAL）

## 5. Blocked 用例的依赖与解锁条件

| code | 用例 | 依赖 | 解锁后需要补的断言 |
| --- | --- | --- | --- |
| `assist-internal-entry-missing` | A1–A3 | 产品级「用户入口」：popup 操作或内核 `onHumanPresence` 事件桥，能在 SW 内用 `markInternalCommand()` 发 `grant_input` / `human_presence` | ASSIST 无 grant 拒绝、grant 一次成功二次拒绝、过期/用尽/取消后拒绝 |
| `api-not-exposed-to-extension-js` | K0–K4 | patch 029 修订：让 `chrome.browserCli.inputOwnership` 真正安装进扩展 JS bindings（见 §6.8） | K0 环境检查转 PASS；K1 HUMAN/版本语义、K2 grant 生命周期、K3 跨会话、K4 presence/pause |
| `real-ime-not-automatable` | S5 | 真实 TSF/搜狗 + 系统输入法状态 | 真实组合输入（候选窗、上屏）路径下 AI 输入仍被仲裁 |

K1–K4 的代码已经写好并在 `kernelApiReady()` 通过后会完整执行；当前 `kernelApiReady()` 在
popup/SW 都拿不到 `inputOwnership` 时直接 `markBlocked`，不会把失败算成 PASS 或 FAIL。

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

### 6.8 P0：`chrome.browserCli.inputOwnership` 没有暴露给扩展 JS（阻塞 K0–K4）

**现象（可复现）**：

- `chrome-extension://<id>/popup/index.html`（浏览器级 CDP `Runtime.evaluate`）：
  `chrome.browserCli` 存在（`getCapabilities` 可调用），`Object.keys(chrome.browserCli) ===
  ["getCapabilities"]`，`chrome.browserCli.inputOwnership === undefined`；
  `Object.keys(chrome).filter(/browser|input|owner/i)` 只有 `["browserCli"]`，没有扁平别名。
- 扩展 **service worker**（`Target.getTargets` → `service_worker` target，attach 后求值）：
  同样只有 `getCapabilities`，`io=false`。
- 已排除的假设：
  - `--enable-features=InputOwnershipEnforcement` 确实到达 renderer（WMI 读子进程命令行：`feature=true`）；
  - `--browser-cli-background-presentation` 也到达 renderer（`managedSwitch=true`）；
  - `gen/chrome/common/extensions/api/api_features.cc` 含 `browserCli.inputOwnership` 条目；
  - `gen/chrome/common/extensions/api/generated_schemas.cc` 含该 namespace；
  - `chrome.dll` 含 `browserCli.inputOwnership.{setOwnership,grantInput,beginInputCommand,
    endInputCommand,heartbeat,getOwnership,onHumanPresence}` 全部函数名；
  - 同 allowlist/context 的 `browserCli.getCapabilities` 在同一个页面可用。

**根因（源码级）**：`extensions/renderer/feature_cache.cc` 在枚举可安装的顶层 namespace 时跳过
所有「父 feature 存在」的条目：

```cpp
if (api_feature_provider->GetParent(*feature) != nullptr)
  continue;
```

`_api_features.json` 同时定义了父 feature `"browserCli"`（getCapabilities）与子命名空间
feature `"browserCli.inputOwnership"`。`FeatureProvider::GetParent()` 按 `.` 切分并查找前缀，
`"browserCli"` 命中 → `browserCli.inputOwnership` 被当成「子 feature（函数/事件）」跳过，
namespace 的 `BindingAccessor` 从未安装，因此扩展 JS 里没有这个命名空间（函数调用层
browser-side 的 trust/availability 检查根本没有机会执行）。
对比：`enterprise.platformKeys` 这类能工作的点号 namespace 没有同名的父 feature。

**建议修复（供 patch 029 owner 选择）**：

1. 把命名空间改成没有父 feature 的名字（例如 `browserCliInputOwnership` 或
   `inputOwnership`），或把 `inputOwnership` 的函数并入 `browserCli` 单一 namespace；
2. 或在 `feature_cache.cc` 里把「点号 namespace」与「父 feature 的子项」区分开（例如父 feature
   自身也是 namespace 时仍允许子 namespace 安装）；
3. 增加 chrome 层集成测试：在受信扩展页面里断言
   `chrome.browserCli.inputOwnership.setOwnership` 是函数（现有 51 个 content 单测不覆盖
   renderer 侧 bindings 暴露）。

证据记录在报告 `p0Regressions[0]`（`P0-input-ownership-api-not-exposed-to-extension-js`）。

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

## 7. 未覆盖 / 明确排除

1. **触摸/手势**：patch 028/029 未把 `Input.dispatchTouchEvent` 等接到仲裁点。
2. **真实 IME**：见 S5。
3. **浏览器 UI 快捷键**（Ctrl+L/T/W/F5）：按设计决定 6 不纳入页面输入权；本 harness 不触发。
4. **managed hidden 窗口的人类输入注入**：PostMessage 无法命中；feature-off 用例已用真实链路
   证明人类输入不被锁，feature-on 的 O4/M3/K1 显式记录 unverified。
5. **内核 HUMAN/ASSIST/grant/presence**：K0–K4 已实现但被 §6.8 阻塞。

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
| 生产 API（patch 029） | K0（可用性 P0）；K1–K4 实现就绪、blocked |
