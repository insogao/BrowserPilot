---
type: DeveloperArchitecture
status: draft-for-review
generated: { by: agent-d, at: 2026-10-28T00:00:00+08:00 }
stale_after: 2027-04-28
scope: 输入权（谁可以给这个窗口/标签页发输入）设计；本阶段不改 D:\c\src，不新增 chromium patch
---

# 输入权隔离设计（Input Ownership）

> 状态：**方案草案，待主代理/项目 owner 审核后才实施**。本轮交付只包含设计；Chromium 源码零改动。
>
> 一句话：**窗口所有权只有一个真源（`state.ts` 的 `SpaceState.ownership` + `ownerClientId`），
> 内核只负责把「自动化输入」与「真实人类输入」在同一个入口处区分开，并按所有权快照投递或丢弃。**
> 不新建第二套状态机，不引入新的 tab 级所有权。

---

## 0. 结论摘要

1. **HUMAN / ASSIST / AI 不是三个新状态，而是既有 `ownership` 的派生视图。**
   `ownership: "user"` → HUMAN；`ownership: "agent"` → AI；ASSIST = `ownership: "agent"` + 一个
   从属的「协助租约」（人类被允许临时操作，AI 保留所有权但不发输入）。所有迁移仍然走
   `claim_space` / `handoff_space` / `complete_space` / `close_space` 与
   `handoffSpaceForTab` / `claimSpaceForTab` / `syncSpaceForTab`，不新增迁移边。
2. **tab 级输入控制与窗口级所有权分离。** 现有 mask（`activeMasks` / `takeover`）继续作为
   tab 级 override 的实现层；tab 级策略只影响「输入投递」，永远不改变 `ownership`。
3. **内核已有可信信号 `blink::WebInputEvent::kFromDebugger`。**
   `content/browser/devtools/protocol/input_handler.cc` 在 `GetEventModifiers()`(:97) 与
   `GetMouseEventButton()`(:165) 里给所有 `Input.dispatch*` 事件加上这个位。
   **不能用 `event.isTrusted`**：CDP 注入的事件在页面里 `isTrusted === true`（本项目集成测试
   实测打印为 true），它区分的是「内核派发 vs 脚本 dispatchEvent」，与「人类 vs 自动化」无关。
4. **仲裁点选在 `RenderWidgetHostImpl` 的输入汇合处**（`ForwardMouseEventWithLatencyInfo` /
   `ForwardWheelEventWithLatencyInfo` / `ForwardKeyboardEventWithCommands`）：OS 人类输入与
   DevTools 注入输入在这里唯一汇合，差异只有 `kFromDebugger` 位，是唯一不会漏掉 OOPIF 的入口。
5. 所有内核改动由 `base::Feature` 包住，默认关闭；关闭时行为与今天完全一致。

---

## 1. 现状与缺口

### 1.1 现有所有权模型（窗口级，已实现）

`src/background/state.ts`：

```ts
export interface SpaceState {
  spaceId: string;
  windowId?: number;
  tabId?: number;
  ownerClientId?: string;
  ownership?: "agent" | "user" | "inactive";
  ...
}
```

`src/background/spaces.ts` 里的语义：

| 迁移 | 实现 | 现状含义 |
|---|---|---|
| `open_space` | 建窗口 + `ownership:"agent"` | 新建 Agent 独占窗口 |
| `handoff_space` | `patchSpace(..., {ownership:"user"})` | 人类接管，Agent 页面命令被 `SPACE_USER_IN_CONTROL` 拦截 |
| `claim_space` | `patchSpace(..., {ownership:"agent"})` | 人类明确许可后 Agent 恢复 |
| `complete_space` / `close_space` | `ownership:"inactive"` + 关闭窗口 | 空间退休 |
| 窗口消失 | `registerSpaceLifecycleHandlers` → `inactive` | 惰性/事件双路径退休 |
| 遮罩上的「人工接管」 | `mask.requestTakeover` → `handoffSpaceForTab` | tab 级临时接管并降级窗口所有权 |

关键点：**`ownership` 现在只回答「谁有权发命令」，不回答「谁有输入权」**。人类鼠标/键盘
可以直接落到 Agent 窗口；反过来，Agent 的 CDP 注入也不受「人类正在打字」影响。这正是本设计
要补的那一层。

### 1.2 缺口清单

1. 人类物理输入没有任何检测：AI 与人类可能在同一窗口交替输入（验证码、支付表单被覆盖）。
2. tab 级 mask 只拦页面内 pointer 事件，不拦浏览器 UI 快捷键（Ctrl+L / Ctrl+T / F5），也不拦
   键盘输入（它只让拦截层 `pointer-events:auto`，键盘仍然进页面）。
3. `ownership:"user"` 只在命令层拦截 AI，第三方 CDP 客户端、DevTools 手工调试、其它扩展
   仍然可以往同一窗口注入输入。
4. 没有「人类存在」事件可供 Agent 做礼貌性让位（例如人类滚了一下页面，Agent 应暂停滚到底）。

---

## 2. 所有权模型：窗口级与 tab 级分离

### 2.1 窗口级三态（派生，不新增状态机）

| 模式 | 派生条件（唯一真源） | AI 输入 | 人类页面输入 | 典型场景 |
|---|---|---|---|---|
| `AI` | `ownership === "agent"` 且无 assist lease | 投递 | 按策略（见 §4.2） | Agent 自主执行 |
| `ASSIST` | `ownership === "agent"` 且有 assist lease | **默认丢弃**（需 grant 才放行） | 投递 | 人类帮忙过验证码/补齐一次输入 |
| `HUMAN` | `ownership === "user"` | 丢弃 + 命令层拒绝 | 投递 | 人类完全接管 |

```ts
// state.ts 的唯一增量（可选字段，默认不存在 = AI）
export interface SpaceState {
  ...
  /** ASSIST 租约：只是 ownership==="agent" 时的从属标记，不产生新的所有权迁移。
   *  ownership 一变（handoff/claim/complete/close/窗口消失）必须一并清除。 */
  assist?: {
    since: number;
    tabId?: number;
    /** 只允许这一次输入：grant 用完即清。 */
    grant?: { token: string; actions: number; expiresAt: number };
  };
}
```

**为什么这样设计**：

- 不引入 `ownership:"assist"`，避免所有既有 `assertOwnership` / `ensureCommandSpace` 判断分支
  （它们按 `"agent"|"user"|"inactive"` 穷举）需要重写，也避免 `storage.session` 旧数据迁移。
- `assist` 的生命周期完全挂在 ownership 上：`patchSpace(spaceId, {ownership:"user"})` 时顺手
  `delete assist`。只有一处收口，不会出现「ownership 是 user 但 assist 还挂着」的脏状态。
- 视图层（CLI / popup / 事件）统一用 `getInputMode(space): "human"|"assist"|"ai"` 派生，不存第二份。

### 2.2 tab 级输入控制（独立，不改所有权）

tab 级策略是「投递过滤器」，来源与实现：

```ts
type TabInputPolicy = "inherit" | "block-human" | "block-ai" | "block-all";
```

- `inherit`（默认）：跟随窗口派生模式。
- `block-human`：等价于今天的 mask 拦截层（人类 pointer/keydown 不投递给页面）。
- `block-ai`：只允许人类（AI 的 tab 被独占给人类，例如正在填密码）。
- `block-all`：冻结页面输入（调试/截图定格用）。

现有实现直接复用：

- `src/content/mask.ts` 的 closed shadow overlay + `pointer-events` 开关（人类 pointer 拦截）；
- `src/background/mask.ts` 的 `activeMasks` / `takeover` / `withCdpAllow`（AI 侧临时放行）；
- 新增的 `src/background/virtual-cursor.ts` 的 `onMaskStateChange`（mask 启停时清理光标）。

**约束**：tab 级策略永远不写 `ownership`、永远不调用 `claim_space`/`handoff_space`。
它只在投递路径上做加法（额外 drop），不做状态迁移。

---

## 3. 内核如何区分真实人类输入与自动化输入

### 3.1 已有信号：`kFromDebugger`

```cpp
// third_party/blink/public/common/input/web_input_event.h:138
kFromDebugger = 1 << 23,
```

```cpp
// content/browser/devtools/protocol/input_handler.cc:97
int result = blink::WebInputEvent::kFromDebugger;   // GetEventModifiers()
// content/browser/devtools/protocol/input_handler.cc:165
*event_modifiers = blink::WebInputEvent::kFromDebugger;  // GetMouseEventButton()
```

这个位已经被内核自己用作「注入事件」标记（`InputHandler::InputInjector::OnInputEventAck()`
在 `input_handler.cc:839` 用它过滤 ack），所以它是**内核语义的一部分**，不是我们发明的。

两个入口：

- 自动化：`InputInjector::InjectMouseEvent()`（`input_handler.cc:739`，函数体在 `:757` 调
  `widget_host_->ForwardMouseEvent(mouse_event)`）；键盘 `InjectKeyboardEvent()`；
- 真实人类：平台事件 → `RenderWidgetHostViewAura::OnMouseEvent()`（`render_widget_host_view_aura.cc:2577`）
  → `RenderWidgetHostImpl::ForwardMouseEvent()`。

两条路径在 `RenderWidgetHostImpl` 汇合：

```cpp
// content/browser/renderer_host/render_widget_host_impl.cc:1669
void RenderWidgetHostImpl::ForwardMouseEvent(const WebMouseEvent& mouse_event) {
  ForwardMouseEventWithLatencyInfo(mouse_event, ui::LatencyInfo());
  ...
}
// :1676 ForwardMouseEventWithLatencyInfo → :1696 IsIgnoringWebInputEvents → input_router()->SendMouseEvent
// :1748 ForwardWheelEventWithLatencyInfo → :1753 IsIgnoringWebInputEvents → input_router()->SendWheelEvent
// :1811 ForwardKeyboardEventWithCommands → :1828 IsIgnoringWebInputEvents → ...
```

### 3.2 为什么不用 `event.isTrusted`

1. **语义不对**：`isTrusted` 的定义是「事件是否由用户代理（内核）派发，而非脚本 `dispatchEvent`」。
   CDP `Input.dispatchMouseEvent` 是内核真实派发的，因此 `isTrusted === true`。
   本项目集成测试实测（`scripts/test-virtual-cursor-browser.mjs` 原始输出）：
   `{"type":"click","x":400,"y":320,"trusted":true}` —— 页面完全无法用它区分自动化与人类。
2. **页面可伪造的一面也不对**：`isTrusted` 只读，页面脚本无法把它改成 true，但页面可以用
   `dispatchEvent` 造出 `isTrusted === false` 的事件；这与「谁拥有输入权」毫无关系。
3. **Blink 侧无法在派发前改变它**：即使内核想「给自动化事件打标」，`isTrusted` 也不是可写的
   `WebInputEvent` 字段，它由事件派发路径决定（`Event::isTrusted`）。
4. **结论**：`kFromDebugger`（内核 modifier 位）是唯一可信、可写、可跨进程传递的自动化标记；
   `isTrusted` 只能用来识别「页面脚本合成事件」，与本设计无关（这类事件不参与仲裁）。

### 3.3 人类输入探测（不是拦截）

`RenderWidgetHost::InputEventObserver::OnInputEvent()`（`content/public/browser/render_widget_host.h:250`）
已经在被 DevTools injector 使用（`OnInputEvent` 只是记录 `input_queued_`）。我们可以在同一
observer 通道里，对**不含 `kFromDebugger`** 的事件发出 `human_presence` 信号（去抖 300ms），
供扩展决定是否转 ASSIST/HUMAN。

### 3.4 是否要新增自动化来源位？

可选增强：`Input.dispatchMouseEvent` 增加可选参数 `automationSource: "agent"|"devtools"|"third-party"`，
内核映射成新 modifier 位（当前 `1 << 23..26` 已占用，`modifiers_` 是 `int`，`1 << 27` 起可用，
但需同时检查 `kKeyModifiers` / `kInputModifiers` 等掩码与 blink 序列化）。

**本方案的建议**：第一阶段**不新增位**，只用 `kFromDebugger` 的「有/无」；来源细分放在扩展层
（扩展知道自己发的每一条命令），内核只在 ASSIST 的 grant 场景需要一个「本次放行」标记——那可以
用 CDP 会话级 grant 表 + 现有 `kFromDebugger` 位实现，不需要新位。

---

## 4. 仲裁规则草案

仲裁器是一个纯函数（便于单测与形式化）：

```cpp
enum class InputOwnerMode { kAi, kAssist, kHuman };
struct Decision { enum { kDeliver, kDrop, kQueue } action; const char* reason; };
Decision Decide(InputOwnerMode mode, bool fromDebugger, EventKind kind,
                TabInputPolicy tabPolicy, bool hasAssistGrant);
```

### 4.1 不变量

1. **人类永远不被锁死**：任何模式下，真实人类输入（`!fromDebugger`）最多被 tab 级
   `block-human` 策略拦截；窗口级所有权**不得**丢弃人类输入。
2. **所有权只有一个写入者**：扩展 SW（`state.ts`）。内核只有只读快照 + 单调版本号。
3. **未知/过期一律降级**：内核不知道窗口或版本落后超过 30s → 按 ASSIST 处理（AI 输入丢弃）。
4. **浏览器 UI 快捷键不属于页面输入权**：Ctrl+L / Ctrl+T / Ctrl+W 由浏览器 UI 处理，不进页面，
   仲裁器不介入（避免把用户锁在页面里）。

### 4.2 AI 拥有（`ownership:"agent"`，无 assist）

| 事件来源 | 规则 |
|---|---|
| 人类鼠标/键盘/滚轮 | **投递**（默认 `pause` 策略），同时发 `human_presence` |
| 人类输入触发抢占 | 由扩展决定（见下），内核不擅自改所有权 |
| AI（`kFromDebugger`） | 投递 |

三种可选策略（扩展层配置，内核读取）：
- `pause`（**建议默认**）：人类输入照常投递，AI 继续；扩展收到 `human_presence` 去抖 500ms 后
  自动 `enter_assist`（人类优先，AI 输入立刻被内核丢弃）。
- `preempt`：内核在收到第一条人类输入时立刻把本地快照切成 ASSIST（并上报），不等扩展确认；
  扩展随后对齐（若扩展拒绝则恢复 AI）。原子性差一些，但响应更快。
- `ignore-human`：内核丢弃人类页面输入（等价全局 mask），只保留浏览器 UI 快捷键。**默认禁止**，
  仅用于无人值守的自动化窗口。

### 4.3 ASSIST

| 事件来源 | 规则 |
|---|---|
| 人类 | 投递 |
| AI，无 grant | **丢弃**，命令层返回 `INPUT_ASSIST_REQUIRES_GRANT` |
| AI，有 grant（一次性 token） | 投递，grant 计数减一，用尽即清 |

这样 ASSIST 的安全边界写在两个地方：扩展在命令层就拒绝（不浪费 IPC），内核在投递层再挡一次
（防止第三方 CDP 绕过扩展）。内核只认「有没有 grant」，不认业务语义。

### 4.4 HUMAN

| 事件来源 | 规则 |
|---|---|
| 人类 | 投递 |
| AI | **丢弃** + 扩展命令层直接返回 `INPUT_HUMAN_OWNED`（复用 `SPACE_USER_IN_CONTROL` 的语义，
  但错误码更精确） |

排队 vs 拒绝：
- **建议默认拒绝（fail fast）**：Agent 的 `click/type/fill` 在 HUMAN 模式下必须立刻失败，避免
  Agent 重试风暴/超时占用。
- 可选 FIFO 队列（容量 1，TTL 5s）在**扩展层**实现，不在内核。理由：内核队列要处理
  renderer 崩溃/导航/OOPIF 生命周期，复杂度与收益不成比例；而扩展已经能拿到完整命令上下文。

### 4.5 接管与恢复协议

```
人类物理输入（去抖 300ms）
   └─ 内核 OnInputEvent → human_presence(tabId, kind, at)
        └─ 扩展 SW：policy=assist → patchSpace({assist:{since,tabId}})   [ownership 不变]
                     policy=human → handoff_space()                      [ownership: user]
        └─ 扩展推 setOwnership(windowId, mode, version) 到内核
             └─ 内核更新快照（拒绝旧 version），后续 AI 注入按 §4.3/§4.4 丢弃

恢复
   用户点 mask 上的「AI 继续」/ CLI claim_space
        └─ 扩展：patchSpace({ownership:"agent"}), delete assist
        └─ 内核收到 mode=ai/version+1 → 恢复投递
```

- 幂等：`setOwnership` 带 `version`，重复/乱序推送直接丢弃。
- 竞态：内核先按本地快照拒绝 AI 输入，扩展随后对齐；**宁可短暂多丢几条 AI 输入，也不多放**。
- SW 重启：`ownership` 在 `storage.session` 里，`restoreMaskState()` 已有恢复路径；内核快照由
  扩展在 SW 启动后重新推一次（`alarms` 心跳里带 version）。

---

## 5. 需要的内核 patch 点（文件 / 函数级，本阶段不实施）

| # | 文件 | 函数/位置 | 改动 |
|---|---|---|---|
| P1 | `content/browser/renderer_host/render_widget_host_impl.cc` | `ForwardMouseEventWithLatencyInfo()` (~1676) | 在 `IsIgnoringWebInputEvents` 之前调用 `input_ownership_->ShouldDeliver(event, kind)`；`kDrop` 直接 return（不投递、不产生 ack 语义变化） |
| P2 | 同上 | `ForwardWheelEventWithLatencyInfo()` (~1748) | 同上 |
| P3 | 同上 | `ForwardKeyboardEventWithCommands()` (~1811) | 同上；注意保留 `KeyPressListenersHandleEvent` 与 `PreHandleKeyboardEvent` 的既有顺序（浏览器 UI 快捷键必须在仲裁之后仍然生效） |
| P4 | 新增 `content/browser/input_ownership/input_ownership_registry.{h,cc}` | — | 按 `WebContents`/`RenderWidgetHost` 存 `{mode, version, tab_policies}`；提供 `ShouldDeliver()` 与 `OnHumanInput()`；**只读快照 + 单调 version** |
| P5 | `content/browser/devtools/protocol/input_handler.cc` | `GetEventModifiers()`(:97) / `GetMouseEventButton()`(:165) | 保持 `kFromDebugger` 语义不变；可选：读取会话级 grant 表，在 grant 有效时给事件附加 `kFromDebugger` 之外的放行标记（第一阶段可完全不改，由扩展层拒绝代替） |
| P6 | `content/public/browser/web_contents_delegate.h` + `RenderWidgetHostImpl::owner_delegate_` | 现有 delegate 通道 | 扩展私有 API（`chrome.browserCli.inputOwnership.*`）经 Browser CLI 的内建扩展绑定到 `InputOwnershipRegistry`；**普通 Chrome 没有这条通道**，退化为只有扩展命令层守卫 |
| P7 | `content/public/browser/render_widget_host.h` | `InputEventObserver::OnInputEvent()`(:250) | 复用现有 observer 上报 `human_presence`（去抖在 registry 里做，避免逐事件 IPC） |

**明确不改**：

- 不改 `blink::WebInputEvent` 的位定义（除非 §3.4 的增强被批准）；
- 不改 aura 层 OS 事件处理（`RenderWidgetHostViewAura::OnMouseEvent`），避免影响浏览器 UI；
- 不改 `IsIgnoringWebInputEvents()` 的语义（它表达「渲染器忽略输入」，与所有权无关）；
- 不改 `Input.dispatch*` 现有参数与默认行为（不传新参数 = 今天的行为）。

---

## 6. 协议字段

### 6.1 扩展命令层（普通 Chrome 也可用，纯 JS 守卫）

```ts
// 新命令
"input_ownership": {
  action: "state" | "assist" | "handoff" | "claim" | "grant";
  tabId?: number;
  grant?: { actions: number; ttlMs?: number };
}
// 返回
{ mode: "ai"|"assist"|"human", spaceId, tabId?, assist?, version }

// 新事件（drainEvents 可见）
"input_human_presence": { tabId, kind: "mouse"|"key"|"wheel", mode, at }
"input_ownership_changed": { spaceId, windowId, mode, version }
```

新错误码（`TaskSpaceError.code` 同款路径透出）：

- `INPUT_HUMAN_OWNED`：HUMAN 模式下 AI 输入类命令
- `INPUT_ASSIST_REQUIRES_GRANT`：ASSIST 模式下无 grant 的 AI 输入类命令

### 6.2 内核私有 API（仅 Browser CLI enhanced host，Phase 7 capability 门禁）

```ts
chrome.browserCli.inputOwnership.setOwnership({ windowId, mode, version });
chrome.browserCli.inputOwnership.setTabPolicy({ tabId, policy });
chrome.browserCli.inputOwnership.getOwnership({ windowId }); // → { mode, version }
// 事件
chrome.browserCli.inputOwnership.onHumanPresence(cb);
chrome.browserCli.inputOwnership.onOwnershipChanged(cb);
```

版本规则：`version` 单调递增（扩展侧每次 `patchSpace` 变更 +1），内核只接受更大的 version；
同 version 重复推送幂等。

---

## 7. 失败模式

| 失败 | 现象 | 处理 |
|---|---|---|
| 内核与扩展失联 / 心跳超时 30s | 内核快照过期 | **降级为 ASSIST**：AI 输入被丢弃，人类始终可用（绝不锁死人类） |
| SW 重启 | 扩展内存态清空 | `ownership` 在 `storage.session`；SW 启动后重推快照（version 继续递增，持久化在 SpaceState 里） |
| 第三方调试器占用同一 tab | 所有注入都带 `kFromDebugger`，来源不可区分 | 一视同仁按所有权丢弃；扩展在 `debugger.attach` 时已能识别「already attached 且不可控」，记录告警 |
| OOPIF / 子帧 | 子帧输入绕过？ | 不会：仲裁在 `RenderWidgetHostImpl::Forward*`，父帧 RWHI 是唯一入口，`RenderInputRouter` 在其后 |
| 事件洪泛（鼠标移动） | 大量 `human_presence` | registry 层 300ms 去抖 + 只在「mode 变化候选」时上报 |
| 页面脚本合成事件 | `isTrusted=false` | 不参与仲裁（既不当作人类也不当作 AI；它就是页面自己的事件） |
| grant 泄漏 | ASSIST 下 AI 持续操作 | grant 携带 `actions` 计数 + `expiresAt`，任一到点即清；`ownership` 变更同时清 grant |
| 人类用快捷键关闭窗口 | 空间消失 | 既有 `windows.onRemoved` → `ownership:"inactive"`；内核快照随 WebContents 销毁 |

---

## 8. 回滚方案

1. **内核侧**：全部改动由 `base::Feature kInputOwnershipEnforcement`（默认 disabled）包住。
   关闭时：`ShouldDeliver()` 恒返回 `kDeliver`，`OnHumanInput()` 不触发，行为与今天逐字节一致。
   以编号 patch 入库（`chromium/patches/`），单文件可逆。
2. **扩展侧**：命令层守卫是纯 JS，独立于内核能力。`host_capabilities.mode === "generic"` 时只启用
   命令层守卫（HUMAN 时拒绝 AI 命令），不推任何内核 API，退化为今天的语义 + 更严格的命令门禁。
3. **数据面**：`SpaceState.assist` 是可选字段，旧版本扩展读不到就忽略；`ownership` 取值集合不变，
   无需迁移 `storage.session`。
4. **灰度**：先只开 `human_presence` 上报（只读、无投递影响），观察误报率，再逐窗口打开
   ASSIST/HUMAN 投递拦截。

---

## 9. 与当前实现的衔接（本阶段已落地部分）

- **可视化先行**：`src/content/cursor.ts` + `src/background/virtual-cursor.ts` 已经能在页面里显示
  AI 光标（`pointer-events:none`，不移动系统鼠标，截图默认排除）。内核仲裁落地后，同一套 overlay
  状态应跟随所有权：HUMAN 时隐藏、ASSIST 时半透明/换色（复用 `cursor` 命令的 `style`）。
- **tab 级清理已接好**：`background/mask.ts` 在 `maskOn` / `maskOff` / `requestTakeover` 时调用
  `virtual-cursor.onMaskStateChange()`；`registerVirtualCursorHandlers()` 负责导航 / tab 切换清理。
- **isTrusted 事实已被测试锁定**：`scripts/test-virtual-cursor-browser.mjs` 会打印页面侧
  `trusted:true`，作为「不能用 isTrusted 做输入权判定」的回归证据。
- **本轮不改 Chromium**：以上 P1–P7 只是设计，需 owner 审核后按 patch 编号实施。

---

## 10. 待审问题（给主代理 / owner）

1. **ASSIST 的 grant 放哪一层？** 只靠扩展命令层拒绝（实现简单，但第三方 CDP 可绕过），
   还是内核也认 grant（更硬，但需要在 DevTools 会话上挂 grant 表）？
2. **默认策略**：`pause`（人类输入照常、AI 继续，500ms 后自动转 ASSIST）还是 `preempt`
   （人类一动手 AI 立刻停）？对「AI 正在长任务」的场景影响很大。
3. **HUMAN 时 AI 命令**：fail-fast（建议）还是排队 1 条？排队要定义 TTL 与丢弃时的错误码。
4. **自动化来源细分**：是否需要区分「DevTools 手工调试」与「插件 AI 自动化」？
   需要的话要新增 modifier 位（1<<27 起）并核对 blink 序列化/掩码。
5. **ASSIST 能否自动产生**：人类在 Agent 窗口里输入就自动进入 ASSIST（无需点按钮）
   是否符合产品预期？会不会让 Agent 频繁被打断？
6. **窗口级 vs 页面级**：Ctrl+L / Ctrl+T / F5 这类浏览器 UI 输入是否也要纳入「窗口输入权」
   （例如 HUMAN 模式下允许，AI 模式下禁止 Agent 触发）？本设计默认不纳入。
7. **多 Agent**：同一窗口只有一个 ownership，但可能有多个 Agent 客户端。是否允许「Agent 之间
   抢同一个 space」？当前 `assertOwnership` 已经按 `ownerClientId` 拒绝，无需新增。

---

## 11. 主代理审核决定（2026-10-28，P3 实施前）

状态：**方案通过，按以下决定进入 P3；本轮不修改 Chromium 源码。** 任何内核改动仍须由
`base::Feature` 默认关闭，并作为编号 patch 入 `chromium/patches/`。

| # | 决定 | 理由 |
| --- | --- | --- |
| 1 | grant **双层执行**：扩展命令层先 fail-fast；内核在 DevTools 会话上维护一次性 grant 表，并在 HUMAN/ASSIST 下二次拦截 | 只靠扩展层挡不住第三方 CDP；内核只认 token/计数，不认业务语义，复杂度可控 |
| 2 | 默认 `pause`：人类输入照常投递，500ms 去抖后转 ASSIST；`preempt` 作为可配选项 | 人类输入永远不能被丢弃；AI 长任务不会在第一次滚轮时被打断 |
| 3 | HUMAN 时 AI 输入命令 **fail-fast**（`INPUT_HUMAN_OWNED`），不排队 | 排队会让“人类操作之后 AI 突然继续点”不可预测；调用方重试语义清晰 |
| 4 | **不新增**自动化来源位；沿用 `kFromDebugger` | 现有位已能区分“内核派发的人类输入”与“DevTools 注入”；新增位要改 blink 掩码与序列化，收益低 |
| 5 | 允许人类输入自动进入 ASSIST（去抖 500ms），但 AI 必须拿 grant 才能继续输入 | 符合“人类随时可接管”；AI 停止输入而不是被强制失败，恢复路径明确 |
| 6 | 浏览器 UI 输入（Ctrl+L/T/N、F5 等）**不纳入**页面输入权；由窗口级 ownership 的现有命令层约束 | 页面输入权只解决“谁往页面里打字/点击”；浏览器 UI 属于窗口呈现与导航，交给 space ownership |
| 7 | 同一窗口只允许一个 owner；多 Agent 抢同一 space 继续由 `assertOwnership` 拒绝 | 不新增第二套所有权；keyed 租约已保证同目标命令互斥 |

实施顺序（P3）：先扩展层 guard + `assist` 租约字段 + grant 协议；再引入内核快照 API 与
`RenderWidgetHostImpl` 汇合点仲裁；最后接 `human_presence` 事件与审计日志。每一步都要有
“关闭 Feature 后行为与今天完全一致”的回归证据。

