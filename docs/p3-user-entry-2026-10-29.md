# P3 用户授权入口（popup）— 2026-10-29

范围：给 P3 输入权仲裁补上**最小可信用户入口**。在此之前，`grant_input` / `human_presence`
只有命令层和内核桥，没有产品级用户操作入口，导致 A1–A3（扩展命令层 ASSIST/grant）与
K4（真实 human_presence + IME 前置）保持 blocked。

结论：popup 增加「我在操作 / 允许一次输入 / 显示窗口」三个动作与实时输入权状态卡；
身份仍然是 SW 进程内 `markInternalCommand()`，外部 host/TCP、URL 参数、消息字段都不能伪造。
真实 E2E 由 L 的 harness 点击 popup 完成（选择器与消息协议见 §5）。

---

## 1. 入口与行为

| 用户动作 | popup 消息 | SW 构造的命令（进程内） | 成功语义 |
| --- | --- | --- | --- |
| 我在操作 | `{kind:"human_presence", spaceId}` | `human_presence {spaceId, tabId?, source:"popup:user", immediate:true}` | 进入 ASSIST，**不改 ownership**；HUMAN 空间返回 `already-human` |
| 允许一次输入 | `{kind:"grant_input", spaceId}` | `grant_input {spaceId, tabId?, actions:1}` | 仅在 ASSIST 下发放 1 次 grant（TTL 走命令层默认 60s） |
| 显示窗口 | `{kind:"ensure_visible", spaceId}` | `ensure_visible {spaceId, tabId?, focus:false}` | 请求恢复窗口呈现；managed 策略拒绝时返回明确错误（§4） |
| 刷新输入权 | `{kind:"input_status", spaceId}` | 只读 `input_status {spaceId, tabId?}` | 返回 mode/ownership/剩余 grant/内核同步视图 |

popup 只发送 `kind` 与目标 `spaceId`。命令名、`args`、`source`、`immediate`、`actions`、
`focus`、`tabId` 全部由 SW 在进程内构造；消息里的同名字段（以及 `_clientId`、`internal`、
`_channel` 等）不会被读取。`tabId` 由 SW 从 space 的绑定 tab / 窗口活动 tab 解析，popup
无法指定任意 tab。

目标解析顺序（`src/background/index.ts::resolvePopupTarget`）：

1. popup 下拉框显式选择的 `spaceId`（必须是窗口仍存在的非 inactive space）；
2. 当前窗口活动 tab 所属的 live space（真实 action popup 的常规路径）；
3. 最近聚焦普通窗口的活动 tab 所属 live space；如果该 space 只有扩展页面（自动化把
   popup 当普通标签页打开、且它独占一个 space），回退到最近更新且含真实页面标签的
   live space；
4. 解析不到 → popup 显示「先 open_space 或选择一个 Task Space」，按钮禁用，
   **不会自动创建窗口**。

---

## 2. 信任边界（为什么外部 Agent 不能调用）

```
用户点击 popup
  → chrome.runtime.sendMessage({kind, spaceId})        // 无身份字段
  → SW chrome.runtime.onMessage(sender)
  → isPopupSender(sender)：sender.url 必须是 chrome-extension://<id>/popup/
  → resolvePopupTarget()（只解析目标，不读身份）
  → buildPopupInputCommand()：SW 进程内构造 Command + markInternalCommand()
  → dispatch()（既有命令层守卫继续生效）
```

- `markInternalCommand()` 是 `spaces.ts` 里的进程内 `WeakSet<object>`；JSON / native
  messaging 反序列化出来的对象永远不可能带这个标记。测试用
  `JSON.parse(JSON.stringify(cmd))` 验证标记丢失后身份降级为 `anonymous:untrusted`。
- `commandClientId()` 只接受 `agent:<id>` 形状或进程内标记；`_clientId:
  "browserpilot-internal"`、`_channel:"internal"`、`args.internal:true` 全部无效。
- `native-bridge.ts`（host/TCP 通道）不 import、也不调用 `markInternalCommand` /
  `buildPopupInputCommand` / `handlePopup`；外部命令只能走普通 `dispatch(cmd)`。
- `handlePopup` 不导出；三个输入动作额外要求 `sender.url` 是 popup 页面。options、
  content script、kernel/offscreen 转发都不会被接受（`PERMISSION_DENIED`）。
- popup 源码不读取 `_clientId` / `internal` / URL 参数（`URLSearchParams` /
  `location.search`），也不注册 `chrome.runtime.onMessage`。

命令层守卫保持原样：`grant_input` 仅 internal 可发（Agent 自证 → `INPUT_GRANT_FORBIDDEN`），
HUMAN 下拒绝 grant（`INPUT_HUMAN_OWNED`），AI 下无意义（`INPUT_GRANT_NOT_IN_ASSIST`），
`human_presence` 仅 internal（Agent → `INPUT_PRESENCE_FORBIDDEN`）。popup 只是提供一个
不可伪造的内部入口，没有新增 ownership 状态机，也没有写 ownership 的代码。

### 2.1 用户入口可以操作任意 Task Space

`spaces.ts::assertOwnership()` 对 `INTERNAL_CLIENT_ID` 直接放行（包括 `ownership:"user"`
的空间）。理由：popup 代表用户本人，用户有权对自己的任何 Agent 空间执行
`ensure_visible`、`human_presence`、`grant_input`；身份由进程内标记保证。Agent 之间的
`SPACE_NOT_OWNED` 隔离保持不变（测试覆盖：`agent:b` 仍不能操作 `agent:a` 的空间）。

---

## 3. 错误码（popup 原样显示）

| 错误码 | 触发场景 |
| --- | --- |
| `SPACE_NOT_FOUND` | 没有 live Task Space；下拉框选中的 space 已关闭；popup 未选择且活动 tab 不属于任何 space |
| `SPACE_INACTIVE` | space 窗口已关闭 / 已退休 |
| `TAB_OUTSIDE_SPACE` | 解析出的 tab 不属于该 space 的窗口 |
| `INPUT_HUMAN_OWNED` | HUMAN（`ownership:"user"`）下点「允许一次输入」 |
| `INPUT_GRANT_NOT_IN_ASSIST` | AI 模式下点「允许一次输入」 |
| `INPUT_GRANT_INVALID` | 命令层参数校验失败（popup 固定 actions=1，正常不可达） |
| `INPUT_GRANT_FORBIDDEN` | 非用户入口尝试 grant（popup 正常不可达，保留展示） |
| `INPUT_ASSIST_REQUIRES_GRANT` | Agent 输入无 grant（popup 不产生此错误，用于 E2E 断言 Agent 侧） |
| `INPUT_PRESENCE_FORBIDDEN` | 非用户入口尝试 human_presence（popup 正常不可达） |
| `INPUT_IDENTITY_UNTRUSTED` | 缺可信身份（外部帧/未打标） |
| `PERMISSION_DENIED` | 非 popup 页面调用三个动作；`chrome.windows.update` 被拒绝；managed 策略拒绝显示窗口 |
| `WINDOW_NOT_RESTORED` | `ensure_visible` 后窗口仍为 minimized |
| `FOREGROUND_BUSY` | 另一个 Agent 持有全局前台租约（`ensure_visible`） |
| `INTERNAL_ERROR` | 未预期异常（无 `code`） |

SW 的错误响应形状：

```json
{ "__bpError": "…", "__bpErrorCode": "INPUT_HUMAN_OWNED", "__bpErrorDetail": { … } }
```

popup 把 `code: message` 写入 `#input-toast`，并设置 `data-code` / `data-ok` 供自动化断言。

---

## 4. managed 模式下的「显示窗口」（重要限制）

内核侧（`--browser-cli-background-presentation`）把扩展 `chrome.windows.*` 归因为
`ForegroundOrigin::kExtension`。`BrowserCliPresentationPolicy::AllowPresentation()` 对
**未拥有窗口**的 Show/Restore/Maximize/Fullscreen/SetZOrder 一律拒绝
（`background-suppresses-native-presentation`），Windows 侧还在
`HWNDMessageHandler::OnWindowPosChanging` 静默剥离 `SWP_SHOWWINDOW`。因此：

- 扩展 API 的 `chrome.windows.update()` **可能返回成功但原生窗口仍隐藏**；
- 旧的 `ensureTabVisible()` 还会吞掉 `windows.update` 异常，属于“静默失败”。

本实现不再静默：

1. `ensureTabVisible()` 返回 `updateError`（不吞异常）；
2. `ensure_visible` 的结果带上 `updateError`；
3. popup 的「显示窗口」在以下情况返回明确错误：
   - `updateError` → `PERMISSION_DENIED`（reason `window-update-rejected`）；
   - `state === "minimized"` → `WINDOW_NOT_RESTORED`；
   - enhanced + managedMode 且窗口未获得焦点 → `PERMISSION_DENIED`
     （reason `managed-presentation-policy`，`requires:"user-explicit-show"`）。
4. 窗口已获得焦点（`focused:true`，隐藏窗口不可能 focused）时视为已呈现，返回成功。

**结论：K4 / 真实 IME 仍被阻塞。** 当前内核没有面向扩展的“用户显式 show”API；唯一能让
managed 后台窗口上桌面的产品路径是用户显式启动
`--browser-cli-user-explicit-show`（或非 managed 的普通 Chrome）。popup 现在会明确报告
`PERMISSION_DENIED`，而不是假装显示成功——这正是 K4 需要的前置诊断。

---

## 5. 给 L 的自动化入口

### 5.1 页面元素（稳定选择器）

| 选择器 | 作用 |
| --- | --- |
| `#space-select` | Task Space 下拉框；option `value` = `spaceId` |
| `#human-presence` / `[data-bp-action="human_presence"]` | 我在操作 |
| `#grant-input` / `[data-bp-action="grant_input"]` | 允许一次输入 |
| `#show-window` / `[data-bp-action="ensure_visible"]` | 显示窗口 |
| `#input-refresh` / `[data-bp-action="input_status"]` | 刷新输入权 |
| `#input-mode` | `HUMAN（用户接管）` / `ASSIST（人类在场）` / `AI（Agent 自主）` |
| `#input-ownership` | `Agent` / `用户` / `已结束` / `未知` |
| `#input-grant` | 剩余次数 + 过期秒数，或 `无（未授权）` |
| `#input-kernel` | `ready` / `degraded（fail closed）` / `unsupported（…）` |
| `#input-target` | 目标 space 名称 + `/ tab <id>` |
| `#input-toast` | 最近一次动作结果：成功 `data-ok="true"` + `data-code=""`；失败 `data-ok="false"` + `data-code="<错误码>"`；另有 `data-action`、`data-at`、`data-seq` |
| `#input-hint` | 无目标 / `input_status` 读取失败时的持久提示 |

按钮请求在途时带 `data-busy="true"` 并临时 disabled；响应落地后移除。自动化建议等待：

```js
await waitFor(() => document.querySelector('#input-toast').dataset.ok === "true"
  && document.querySelector('#input-toast').dataset.code === "");
```

### 5.2 点击流程

```js
// 1) 打开 popup 页面（L 现有 ensurePopup 已用 open_space 打开 popup/index.html）
// 2) 等下拉框出现目标 space（popup 每秒刷新一次）
const select = document.querySelector('#space-select');
await waitFor(() => select.querySelector('option[value="' + spaceId + '"]'));
select.value = spaceId;
select.dispatchEvent(new Event('change', { bubbles: true }));

// 3) 三个动作
document.querySelector('#human-presence').click();   // → ASSIST
document.querySelector('#grant-input').click();      // → 1 次 grant
document.querySelector('#show-window').click();      // → managed 下预期 PERMISSION_DENIED

// 4) 读结果
const mode = document.querySelector('#input-mode').textContent;
const grant = document.querySelector('#input-grant').textContent;
const code = document.querySelector('#input-toast').dataset.code;
```

按钮在 `#space-select` 没有有效选择时是 `disabled`。若 popup 打开在独占的 popup space，
默认目标会回退到最近更新且含真实页面标签的 live space；多 space 场景请显式设置下拉框。

### 5.3 直接消息协议（必须在 popup 页面上下文发送）

```js
// chrome-extension://<id>/popup/index.html 的页面主世界 / popup 自身
await chrome.runtime.sendMessage({ kind: "human_presence", spaceId });
// → {spaceId, tabId, mode:"assist", ownership:"agent", changed:true, scheduled:false,
//    source:"popup:user", debounceMs:500}

await chrome.runtime.sendMessage({ kind: "grant_input", spaceId });
// → {spaceId, mode:"assist", tabId, grant:{token:"xxxxxxxx…", actions:1, expiresAt}}

await chrome.runtime.sendMessage({ kind: "ensure_visible", spaceId });
// → {presented:true, tabId, windowId, state:"normal", focused:false, managedMode:true}
// 或 {__bpError, __bpErrorCode:"PERMISSION_DENIED", __bpErrorDetail:{reason:"managed-presentation-policy"}}

await chrome.runtime.sendMessage({ kind: "input_status", spaceId });
// → 完整 PopupStatus：{input:{mode, ownership, grantActionsRemaining, kernel, …},
//    spaces:[{spaceId, name, mode, …}], target:{spaceId, tabId, windowId}}
```

从非 popup 页面（content script / options / 普通标签页）发送三个动作会得到
`PERMISSION_DENIED`（sender 校验）。

### 5.4 A1 按钮回归修复与 A3 TTL 结论（2026-10-29 追加）

真实 E2E 首轮结果：A2（直接 `chrome.runtime.sendMessage`）全 PASS；A1 的 `human_presence`
按钮 PASS，但 `#grant-input` 按钮没有产生 grant；A3 的 60s 过期项失败。根因与修复：

1. **点击时读取 `#space-select` 当前值**：原实现点击使用内存里的 `selectedSpaceId`。
   自动化只设置 `select.value`（不派发 `change`）时，内存值仍是初始化/自动选择的空间，
   grant 发到了错误 space（通常是 popup 自己所在的 space），随后 Agent 在目标 space
   点击自然得到 `INPUT_ASSIST_REQUIRES_GRANT`。现在 `requireSpaceId()` 每次点击都调用
   `currentSpaceId()` 读取 `select.value`。
2. **轮询重建 option 不再清掉选择**：`renderSpaces()` 在重建 `<option>` 前记住
   `select.value`，重建后若仍有效立即恢复；SW 返回的 `spaces` 也改为稳定顺序
   （`createdAt`/`spaceId`，不再按 `updatedAt` 抖动）。
3. **按钮不再因瞬态状态置灰**：只有 `liveSpaceCount === 0`（完全没有 Task Space）才
   disabled；存在 space 但尚未选择时点击会明确报 `SPACE_NOT_FOUND`，不会静默无响应。
   请求在途用 `data-busy="true"` 临时禁用，完成后恢复。
4. **完成信号**：成功后 `#input-toast[data-ok="true"][data-code=""]`，并更新
   `#input-mode` / `#input-grant`；同时 `data-action` / `data-at` / `data-seq` 可供等待。
5. **TTL**：`grant_input` 不传 `ttlMs`，命令层默认 60000ms；popup 的 1s 轮询只调用
   `get_status` / `input_status`（只读），不会重新发放 grant，也不会改写 `expiresAt`。
   新增假时钟单测：grant 后 30s 仍可用且 `assistExpiresAt` 不变；60.001s 后命令层以
   `INPUT_ASSIST_REQUIRES_GRANT`（reason `expired`）拒绝并清空 grant。首轮 A3 失败是
   A1 未发出 grant 的连带结果，修复按钮后应按该语义通过。

Headless 验证（真实构建产物 + mock SW，不是直接消息）：

```bash
npm run test:popup-ui
```

脚本 `scripts/test-popup-ui-headless.mjs` 用 headless Chrome 加载
`dist/popup/index.html` + `index.js`，注入 mock `chrome.runtime.sendMessage`，然后：
设置 `select.value="space-test"`（**不派发 change**）→ 等待 1.2s 让轮询强制重建 option
→ 点击 `#grant-input` → 断言消息 `{kind:"grant_input", spaceId:"space-test"}`、SW 返回
`actions:1`、`#input-grant` 显示 `1 次`、`#input-mode` 显示 ASSIST、toast 成功信号与
`data-busy` 生命周期正确；再用 `change` 事件选择另一 space 点击 `#human-presence`，
断言目标随选择变化。

---

## 6. 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/background/popup-entry.ts`（新） | 唯一的 popup 命令构造器：固定 args + `markInternalCommand()`；`buildPopupStatusCommand()` |
| `src/background/index.ts` | `handlePopup` 新增 `input_status` / `grant_input` / `human_presence` / `ensure_visible`；popup sender 校验；目标解析；稳定错误响应；managed 显示窗口后置校验 |
| `src/background/spaces.ts` | `ensureTabVisible` 返回 `updateError`（不再静默）；`ensure_visible` 透出；`assertOwnership` 允许 internal 用户入口操作任意 space |
| `src/shared/types.ts` | `PopupRequest` 新增四个 kind；`PopupInputView` / `PopupSpaceOption` / `PopupErrorInfo`；`PopupStatus` 增加 input/spaces/target/inputError |
| `src/popup/index.ts` / `index.html` | 输入权状态卡、space 下拉框、三个动作按钮、刷新按钮、错误码展示；点击时读取 `select.value`；成功后 `data-ok="true"`/`data-code=""`，请求中 `data-busy` |
| `scripts/test-input-ownership.mjs` | 新增 §12：构造器运行时测试、JSON 标记丢失、60s TTL 假时钟、popup 源码守卫（点击读 DOM、稳定信号、轮询不 grant）、SW case/sender 守卫、外部通道守卫 |
| `scripts/test-popup-ui-headless.mjs`（新） | headless Chrome 加载真实 `dist/popup` + mock SW，点击 `#grant-input` / `#human-presence` 的最小 UI 验证 |
| `package.json` | 新增 `test:popup-ui`（build + headless UI 测试） |
| `docs/p3-user-entry-2026-10-29.md`（新） | 本文 |

未修改（按边界要求）：`cdp.ts`、`screenshot-policy.ts`、`virtual-cursor.ts`、`mask.ts`、
`actions.ts`、`debugger-bridge.ts`、Chromium 源码。

---

## 7. 复现与测试原始结果

```bash
npm run typecheck
npm run build
npm run test:core
npm run test:trust-boundary
npm run test:popup-ui        # build + headless Chrome + mock SW
```

`npm run test:core` 原始输出（节选，2026-10-29 本 worktree）：

```
PASS input-ownership: mode derivation is a pure view over ownership(+assist)
PASS input-ownership: AI allows, HUMAN rejects INPUT_HUMAN_OWNED, ASSIST rejects without grant
PASS input-ownership: grant is consumed once per command, cleared on exhaustion/expiry
PASS input-ownership: grant_input validates counts/TTL, is user-entry-only, and returns a truncated token
PASS input-ownership: ownership transitions clear the assist lease and cancel pending presence
PASS input-ownership: enter/exit assist only writes the assist lease, never ownership
PASS input-ownership: human_presence is gated, debounced, and never rewrites ownership
PASS input-ownership: tab-based space resolution prevents cross-space bypass
PASS input-ownership: every input-injecting command (including js/tab_cdp_call) is guarded
PASS input-ownership: single ownership state machine (source guards), no new ownership values
PASS input-ownership: user identity is a process-local marker; wire fields cannot forge it
PASS input-ownership: source guards keep identity fail-closed (no field-based fallback)
PASS input-ownership: popup entry builds fixed, internally marked commands (grant/presence/show)
PASS input-ownership: popup grant TTL is 60s and status polling never renews it
PASS input-ownership: popup source guards (no forgeable fields, fixed actions, popup-only sender)
...
PASS input-ownership-api: kernel human_presence enters ASSIST through the internal bridge only
PASS input-ownership-api: source guards keep one ownership source and the kernel bridge isolated
```

`npm run test:trust-boundary` 原始输出（节选）：

```
PASS trust-boundary: real host assigns `agent:<id>` server-side and strips every spoofed field
  [deny] host 转发帧（owner=agent:socket-1，agentId=browserpilot-internal）grant_input -> INPUT_GRANT_FORBIDDEN
  [deny] host 转发帧 human_presence -> INPUT_PRESENCE_FORBIDDEN
  [deny] 其他 Agent 对 space-x grant_input -> SPACE_NOT_OWNED
  [deny] host 回归：_clientId=browserpilot-internal grant_input -> INPUT_IDENTITY_UNTRUSTED
  [deny] host 回归：_clientId=browserpilot-internal human_presence -> INPUT_IDENTITY_UNTRUSTED
  [deny] 纯 _channel=internal 字段 -> INPUT_IDENTITY_UNTRUSTED
  [deny] owner Agent + args.internal=true grant_input -> INPUT_GRANT_FORBIDDEN
  [allow] 用户入口 grant_input -> {"mode":"assist","actions":2}
  [allow] 用户入口 human_presence -> {"mode":"assist","changed":true}
PASS trust-boundary: 外部客户端无法伪造 browserpilot-internal；grant_input/human_presence 全部被拒；用户入口仍可用
```

`npm run test:popup-ui` 原始输出（节选；headless Chrome + mock SW）：

```
popup-ui-headless raw: {
  "checks": {
    "options": true,
    "autoSelected": true,
    "valueSurvivedPoll": true,
    "enabled": true,
    "busySet": true,
    "toastOk": true,
    "toastCodeEmpty": true,
    "toastAction": "grant_input",
    "busyCleared": true,
    "mode": "ASSIST（人类在场）",
    "grant": "1 次，60s 后过期",
    "grantMessage": {"msg":{"kind":"grant_input","spaceId":"space-test"}, ...},
    "senderIsPopup": true,
    "presenceOk": true,
    "presenceSpace": "space-auto"
  },
  "pass": true
}
PASS popup-ui-headless: select.value + #grant-input sends the selected space, SW actions:1, UI signal stable
PASS popup-ui-headless: change event + #human-presence follows the new selection
```

未运行真实 Browser CLI / 内核 E2E（按任务分工由 L 的 harness 完成）；headless UI 测试使用
独立临时 `--user-data-dir`，不加载用户真实 profile、不显示窗口、不触碰注册表。

---

## 8. 新风险 / 未覆盖

1. **managed 模式无法从扩展显示窗口**（§4）：K4 / 真实 IME 仍 blocked，除非内核提供
   用户显式 show 的扩展入口，或测试改用非 managed 会话。popup 现在会明确报
   `PERMISSION_DENIED`，不会伪造成功。
2. **`focused` 是 managed 模式下唯一的“已呈现”信号**：窗口可见但未聚焦时会被判为
   `PERMISSION_DENIED`（保守 fail explicit）。若未来内核提供 `getPresentationState`，
   应替换此启发式。
3. **sender.url 校验依赖 Chrome 的 MessageSender 语义**：真实 popup 与扩展标签页都会带
   `chrome-extension://<id>/popup/`；若某版本缺字段则 fail closed（按钮会报
   `PERMISSION_DENIED`），不会放行。
4. **popup 每秒轮询** `get_status`：会对每个 live space 调一次 `chrome.windows.get`，
   space 很多时有少量开销；`input_status` 直接读状态、不 dispatch，避免每秒续期遮罩。
5. **目标自动回退**：popup 独占一个只有扩展页面的 space 时，默认目标会回退到最近更新且
   含真实页面标签的 live space；多 space 自动化必须显式设置 `#space-select`，否则可能
   选到非预期空间。点击时始终以 `select.value` 为准，但 option 尚未加载时点击仍会得到
   `SPACE_NOT_FOUND`（需先等 `option[value]` 出现）。
6. **headless 测试使用 mock SW，不是真实 SW**：它验证 popup UI 接线（选择、点击、信号、
   目标透传），真实 SW 的命令层语义由 `test:core` 覆盖；真实 Browser CLI 链路仍需 L 的
   harness 复跑 A1/A2/A3。
7. **grant TTL 固定为命令层默认 60s**：popup 不提供 TTL/次数输入，避免用户误放大授权；
   若产品需要可配置，应在 UI 上显式限制上限。轮询只读，不会续期（单测用假时钟锁定）。
8. **`human_presence` 使用 `immediate:true`**：显式点击不需要 500ms 去抖；内核事件桥仍
   走去抖路径。
9. **内部身份在 `assertOwnership` 的放行面**：用户入口现在可以操作任意 space 的
   `ensure_visible`/空间命令。所有 internal 命令都来自 SW 代码（popup 四个固定动作、
   options 模板白名单、内核 presence 桥、全局 stop），没有消息字段透传；但若未来新增
   internal 命令入口，需要重新审视这一放行面。
