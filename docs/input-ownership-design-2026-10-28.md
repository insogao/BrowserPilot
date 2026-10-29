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

---

## 12. P3 实施细节（扩展侧已落地，2026-10-28）

状态：**扩展侧已实现并通过离线单测 + 真实 headless Chromium 集成测试；本轮仍不改
`D:\c\src`，未生成任何 Chromium patch 文件。** 内核侧方案见 §13，等待主代理审核后实施。

### 12.1 文件与职责

| 文件 | 角色 |
|---|---|
| `src/background/state.ts` | `SpaceState.assist?: AssistLease`（唯一新增字段）；`patchSpace()` 在单一收口处保证「assist 只存在于 ownership==="agent"」；`onOwnershipChanged()` 同步回调只用于作废待触发的 presence 定时器 |
| `src/background/input-ownership.ts`（新） | 模式派生 `inputModeForSpace()`、统一守卫 `guardInputCommand()`、`enterAssist()` / `exitAssist()` / `noteHumanPresence()`、grant 生命周期、`grant_input` / `input_status` / `human_presence` 三个命令、审计事件 |
| `src/background/commands.ts` | `dispatch()` 在 handler 之前调用守卫；保留既有 `hasTakeover()` 检查（两者叠加）；新增三条命令；guide 增补 |
| `src/shared/types.ts` | `CommandName` 增加 `grant_input` / `input_status` / `human_presence` |
| `scripts/test-input-ownership.mjs`（新） | 离线单测（也由 `test-core.mjs` 末尾 import） |
| `scripts/test-input-ownership-browser.mjs`（新） | 真实 headless Chromium 集成测试（真实 commands/actions/cdp + 真实 CDP 注入） |

**未修改**（按边界要求）：`cdp.ts`、`screenshot-policy.ts`、`virtual-cursor.ts`、`mask.ts`、
`actions.ts`、`debugger-bridge.ts`、`content/*`。守卫放在 `dispatch()`，不需要改动
`debugger-bridge`；若未来要把守卫下沉到 `sendCommand()`，精确插入点是
`debugger-bridge.ts::sendCommand()` 在 `chrome.debugger.sendCommand` 之前按 method 白名单
（`Input.*`）调用 `guardInputCommand`，但当前方案不需要。

### 12.2 单一状态机与不变量

```ts
// state.ts —— 唯一增量
export interface SpaceState {
  ownership?: "agent" | "user" | "inactive"; // 取值集合不变
  assist?: {
    since: number;
    reason?: string;
    tabId?: number;
    grant?: { token: string; actions: number; expiresAt: number };
  };
}
```

`patchSpace()` 的收口规则：

1. `result.ownership !== "agent"` → `delete result.assist`（覆盖 handoff / complete / close /
   窗口消失 / 旧数据）；
2. 同一 patch 显式写了 `ownership`（即使值相同，例如 `claim_space` 对已在 `agent` 的
   ASSIST 空间）→ 清空 assist；
3. 只有「单独写 assist」的路径（`enterAssist` 直接 `mutateState`）能保留 assist。

所有迁移仍然只走既有命令/函数：`handoff_space`、`claim_space`、`complete_space`、
`close_space`、`handoffSpaceForTab`、`claimSpaceForTab`、`registerSpaceLifecycleHandlers`。
本模块**没有任何写 ownership 的代码**（离线测试用源码守卫锁定）。tab 级 mask/takeover
只影响输入投递，从不写 ownership。

去抖定时器的失效：`onOwnershipChanged()` 在 `patchSpace` 写 ownership 后同步触发，
`input-ownership.ts` 注册的回调只做 `cancelPendingPresence(spaceId)`。这保证
「`claim_space` 之后迟到的 human_presence 不会把空间重新拉回 ASSIST」。

### 12.3 模式派生（纯函数，不落第二份状态）

| `ownership` | `assist` | `inputModeForSpace()` | AI 输入 |
|---|---|---|---|
| `"user"` | 任意（不变量保证不存在） | `"human"` | 拒绝 |
| `"agent"` | 不存在 | `"ai"` | 放行 |
| `"agent"` | 存在（含/不含 grant） | `"assist"` | 无 grant 拒绝；有 grant 逐次消耗 |
| `"inactive"` / `undefined` | — | `"human"`（fail closed） | 拒绝/交回既有 `SPACE_INACTIVE` 错误 |

### 12.4 统一守卫

`commands.ts::dispatch()` 顺序（**既有检查优先，新增守卫叠加**）：

```
try {
  if (ACTION_NAMES.has(name) && hasTakeover()) { ...human_takeover_in_progress... }  // 原有
  if (INPUT_COMMANDS.has(name)) await guardInputCommand(cmd);                        // 新增
  return await KNOWN[name](cmd);
}
```

`INPUT_COMMANDS`：`click`、`dblclick`、`hover`、`drag`、`wheel`、`down`、`up`、`press`、
`type`、`fill`、`selectOption`、`check`、`uncheck`、`setChecked`、`js`、`tab_cdp_call`。
`js` / `tab_cdp_call` 纳入的理由与既有 `ACTION_NAMES` 一致：它们能执行 `el.click()` 或直接
`Input.dispatch*`，不纳入等于给 HUMAN/ASSIST 留旁路。`download_image` / `download_resource`
只读页面/下载，不注入输入，继续只受 mask/takeover 约束。

守卫的错误语义：

| 模式 | 行为 | 错误码 |
|---|---|---|
| HUMAN | fail fast，不 attach、不发任何 CDP | `INPUT_HUMAN_OWNED`（`detail.reason = "ownership-user"`） |
| ASSIST 无 grant | fail fast | `INPUT_ASSIST_REQUIRES_GRANT`（reason `no-grant` / `no-assist`） |
| ASSIST grant 过期 | 清 grant 后拒绝 | `INPUT_ASSIST_REQUIRES_GRANT`（reason `expired`） |
| ASSIST grant 用尽 | 清 grant 后拒绝 | `INPUT_ASSIST_REQUIRES_GRANT`（reason `exhausted`） |
| ASSIST grant 可用 | 原子消耗 1 次后放行 | — |
| AI | 放行 | — |
| space 不存在 / inactive | 返回 `undefined`，交回既有路径给出 `SPACE_*` | — |

守卫的 space 解析是**只读**的（不调用 `ensureCommandSpace`，避免它先把 HUMAN 报成
`SPACE_USER_IN_CONTROL`）：显式 space 选择器（`cmd.space` / `args.spaceId` / `args.space` /
`args.name`）> `args.tabId` 所在窗口 > 调用方 `activeSpaceIds[clientId]`。不回落全局
`activeSpaceId`，避免把别的 Agent 的空间误当目标。

归属校验先于模式判定：非 owner 的 Agent 显式指定别人的 space 时直接 `SPACE_NOT_OWNED`
（与 `ensureCommandSpace` 的错误优先级一致），**不会消耗 owner 的 grant**，也不会泄露该
space 的输入模式（防跨 Agent DoS/探测）。

### 12.5 grant 生命周期

- 参数：`actions` 必须是正整数（拒绝 `0` / 负数 / 小数 / 非 number），上限 `10000`；
  `ttlMs` 正整数，默认 `60000`，上限 `600000`。
- token：`crypto.randomUUID()` 存完整值；对外（返回值/审计）只给 `前 8 位 + "…"`。
- 消耗：`mutateState` 内原子读改写，一条输入命令消耗 1 次（不是一条 CDP 事件）；
  并发命令不会重复使用同一个 grant。
- 用尽 / 过期 → 删除 `assist.grant`，保留 ASSIST 租约（人类仍在场，AI 只是需要重新申请）。
- ownership 变更 → `patchSpace` 清空整个 `assist`（含 grant）。
- 新的 `human_presence` / `enterAssist` → 清掉未用完的 grant（人类优先，AI 必须重新申请）。
- `grant_input` 只在 ASSIST 下有意义：HUMAN → `INPUT_HUMAN_OWNED`（grant 不能绕过
  ownership，必须先 `claim_space`）；AI → `INPUT_GRANT_NOT_IN_ASSIST`。
  **仅用户入口可发**（身份 = SW 进程内 `markInternalCommand` 标记，不是消息字段，见 §12.11）；
  非 owner → `SPACE_NOT_OWNED`；owner Agent 自己调用 → `INPUT_GRANT_FORBIDDEN`。
  grant 是“人类允许 AI 这一次输入”的凭据，如果 Agent 能自证，ASSIST 就失去意义。

### 12.6 `human_presence`（内核事件/测试入口）

- 授权：**只接受扩展内部入口（popup / 内核事件桥，用 `markInternalCommand` 打标）**。
  `args.internal === true`、`_clientId: "browserpilot-internal"`、`_channel` 等消息字段
  一律不构成旁路（§12.11）；owner Agent 即使带这些字段也会得到 `INPUT_PRESENCE_FORBIDDEN`，
  缺可信身份则直接 `INPUT_IDENTITY_UNTRUSTED`。
  非 owner 的 Agent 先被 `SPACE_NOT_OWNED` 拦住，不能替别人进入 ASSIST。
- 目标解析：用户入口没有 `activeSpaceIds`，因此必须显式给 `space`/`spaceId` 或 `tabId`
  （内核事件天然带 `tabId`）；否则返回 `SPACE_NOT_FOUND`。
- 默认 trailing debounce 500ms（`args.debounceMs` 可覆盖，0–5000ms）；命令立即返回
  `{scheduled:true, applyAt, debounceMs}`，到点后 `enterAssist()`。
- `args.immediate === true` 立即进入（测试/未来 `preempt` 策略）。
- HUMAN 空间是无操作（`mode:"human"`, `changed:false`, `reason:"already-human"`），
  **永不改 ownership**。

### 12.7 新命令协议

```jsonc
// grant_input  {space?|spaceId?, tabId?, actions, ttlMs?}
{"type":"command","name":"grant_input","args":{"actions":1,"ttlMs":5000},"requestId":"1"}
// → data
{"spaceId":"space-test","mode":"assist","tabId":1,
 "grant":{"token":"3e4bc7a4…","actions":1,"expiresAt":1793182927798}}

// input_status  {space?|spaceId?, tabId?}
// → data
{"spaceId":"space-test","windowId":1,"tabId":1,"mode":"assist","ownership":"agent",
 "ownerClientId":"agent:tester","assistSince":1793182927000,"assistReason":"kernel:mouse",
 "assistExpiresAt":1793182927798,"grantActionsRemaining":1,
 "grant":{"token":"3e4bc7a4…","actions":1,"expiresAt":1793182927798,"expiresInMs":4821}}

// human_presence  {space?|spaceId?, tabId?, source?, immediate?, debounceMs?, internal?}
// → data（默认去抖）
{"spaceId":"space-test","tabId":1,"mode":"ai","ownership":"agent",
 "changed":false,"scheduled":true,"source":"kernel:mouse","debounceMs":500,"applyAt":1793182927500}
```

错误码通过既有 native-bridge 路径透出：`errorCode` 字段与 `error` 文本同时存在
（`InputOwnershipError.code`；`TaskSpaceError.code` 保持不变）。

### 12.8 审计事件（`drainEvents` 可见）

| 事件 | 何时 | 关键字段 |
|---|---|---|
| `input_command_rejected` | HUMAN / ASSIST 无 grant / 过期 / 用尽 | `spaceId, tabId, clientId, command, mode, code, reason, at` |
| `input_grant_consumed` | grant 被消耗一次 | `spaceId, tabId, clientId, command, remaining, expiresAt, token(截断), at` |
| `input_grant_issued` | `grant_input` 成功 | `spaceId, tabId, clientId, actions, ttlMs, expiresAt, token(截断), at` |
| `input_assist_entered` | 进入 ASSIST | `spaceId, tabId, source, reason, at` |
| `input_assist_exited` | `exitAssist` | `spaceId, reason, at` |
| `input_presence_scheduled` | 收到内核/测试 presence | `spaceId, tabId, clientId, source, applyAt, debounceMs, at` |
| `input_presence_ignored` | HUMAN 空间收到 presence | `spaceId, tabId, source, reason:"already-human", at` |

事件只写 `events.ts` 的缓冲（`drainEvents`），不额外推 host，避免与 native 连接生命周期耦合；
拒绝路径同时抛错，调用方无需轮询审计。

### 12.9 测试与复现

```bash
npm run typecheck
npm run build
npm run test:core                 # 末尾 import 了 test-input-ownership.mjs
npm run test:input-ownership      # 离线单测（独立脚本）
npm run test:input-ownership:browser
```

真实 headless 运行隔离：`--headless=new --disable-gpu --in-process-gpu` + `mktemp` 独立
`--user-data-dir`，不使用 `--no-sandbox`，不触碰用户真实 profile/Chrome。

集成测试逐次记录页面状态（节选，原始输出见测试日志）：

| 步骤 | `input_status.mode` | 命令结果 | 页面 `__clicks` / DOM `#count` |
|---|---|---|---|
| 初始 | `ai` | — | 0 / "0" |
| AI click | `ai` | 成功 | **1 / "1"**（受信 click） |
| `handoff_space` 后 click | `human` | `INPUT_HUMAN_OWNED` | **1 / "1"**（未点击） |
| HUMAN 下 js | `human` | `INPUT_HUMAN_OWNED` | `__jsRuns` 仍为 0 |
| HUMAN 下 grant_input | `human` | `INPUT_HUMAN_OWNED` | — |
| `claim_space` → `human_presence`（500ms 去抖） | `assist` | — | — |
| owner Agent 的 `human_presence`（含 `internal:true`） | `ai` | `INPUT_PRESENCE_FORBIDDEN` | — |
| ASSIST 无 grant click | `assist` | `INPUT_ASSIST_REQUIRES_GRANT` | **1 / "1"** |
| ASSIST 下 Agent 自行 `grant_input` | `assist` | `INPUT_GRANT_FORBIDDEN` | **1 / "1"** |
| 用户入口 `grant_input {actions:1}` 后第一次 click | `assist` | 成功 | **2 / "2"** |
| 第二次 click | `assist` | `INPUT_ASSIST_REQUIRES_GRANT`（no-grant） | **2 / "2"** |
| `grant_input {actions:2, ttlMs:120}` + 等待 400ms 后 click | `assist` | `INPUT_ASSIST_REQUIRES_GRANT`（expired） | **2 / "2"** |
| `claim_space` 后 click | `ai` | 成功 | **3 / "3"** |

审计事件计数（同一次运行）：`input_command_rejected=6`、`input_grant_consumed=1`、
`input_grant_issued=2`。最终 `SpaceState`：`ownership:"agent"`、`assist` 不存在。

### 12.10 已知限制（扩展侧）

1. **grant 在命令执行前消耗**：因此「授权了但动作失败（元素不存在等）」也会消耗一次；
   语义是「投递尝试次数」，不是「成功次数」。
2. **ASSIST 没有自动到期**：只有 ownership 变更、`exitAssist` 或人类再次输入（刷新租约）
   才会改变；这是设计 §4.3 的保守选择（不擅自把输入权还给 AI）。
3. **SW 重启**：`assist` 与 grant 在 `storage.session` 里，会随 SW 重启恢复；内存中的
   去抖定时器会丢失，需要内核/调用方重发 presence（内核方案里由 30s 心跳兜底）。
4. **`js` / `tab_cdp_call` 一律纳入**：即使只是 `Runtime.evaluate` 读数据，也会在 HUMAN/ASSIST
   被拒；这是 fail-closed 的代价，调用方应先 `input_status`。
5. **扩展层挡不住第三方 CDP**：这正是 §13 内核侧第二条防线存在的原因。
6. **人类真实输入检测尚未接入**：本轮 `human_presence` 只有测试/未来内核入口；没有真实
   OS 输入探测（扩展没有该 API），必须等内核 patch。

### 12.11 信任边界加固（2026-10-28，P3 审计后）

**审计问题**：`grant_input` / `human_presence` 之前只认
`commandClientId(cmd) === "browserpilot-internal"`，而 `commandClientId` 的实现是
`cmd._clientId?.trim() || "browserpilot-internal"`。这是「字段缺失即最高权限」的 fail-open
结构，且身份是否可伪造完全取决于 `native-host/host.js` 的一行字符串前缀。

**真实 host 探针（原始输出；`npm run test:trust-boundary` 可复现）**：

| 客户端自报 | host 转发给扩展的 `_clientId` | 结论 |
|---|---|---|
| `agentId: "browserpilot-internal"` | `agent:browserpilot-internal` | 不是保留 ID（前缀 `agent:`） |
| `_clientId: "browserpilot-internal"` | `agent:socket-1`（被覆盖） | 不可伪造 |
| `agentId: "a:b"` | 旧：`agent:a:b`；新：`agent:socket-1` | 冒号不再进入身份 |
| `_channel: "internal"` | 旧：**原样转发**；新：丢弃 | 这是唯一真实的“可伪造字段”隐患 |

结论：**TCP 路径当前不能直接伪造 `browserpilot-internal`**（前缀挡住了），但：
1. 身份是“字符串约定”，不是结构性保证；任何 host 回归/换实现都会让它失守；
2. `commandClientId` 的缺省回退把「没有字段」当成「用户」，属于 fail-open；
3. 未知的 `_` 前缀字段会被原样转发——如果内部通道用一个消息字段表示，它立刻可被伪造。

**修复（本轮已落地）**：

1. **用户身份不是消息字段**：`spaces.ts` 新增进程内 `WeakSet<object>` +
   `markInternalCommand()`。只有 SW 内部（`index.ts` 的 popup/options dispatch、内核事件桥）
   构造的命令对象会被打标；JSON / native messaging 反序列化的对象永远不可能带这个标记。
2. **`commandClientId()` fail closed**：`_clientId` 只接受 `agent:<id>` 形状；其它值（含
   `browserpilot-internal`）→ `anonymous:untrusted`；没有 `_clientId` 且未打标 → 同样是
   `anonymous:untrusted`。特权命令遇到不可信身份直接 `INPUT_IDENTITY_UNTRUSTED`。
3. **模板子命令继承**：`inheritInternalCommand()` 保证内部入口发起的 `run_template`
   子步骤仍属于用户入口，外部 Agent 的子步骤仍继承 `agent:<id>`。
4. **host 服务端分配身份**：`agentId` 只允许 `[A-Za-z0-9._-]{1,64}`，保留 ID 表
   （`browserpilot-internal` / `internal` / `user` / `kernel` / …）直接改派 `socket-<n>`；
   转发采用**字段白名单**（`type`/`name`/`args`/`space` + host 注入的 `requestId`/`_clientId`），
   任何 `_` 前缀字段、`_foregroundLeaseToken`、`args.internal` 都不再透传。
5. **测试锁定**：`scripts/test-trust-boundary.mjs`（真实 host + 真实扩展命令层）、
   `scripts/test-input-ownership.mjs` §11（离线负向用例 + 源码守卫）、
   `scripts/test-input-ownership-browser.mjs`（真实 headless 浏览器上的伪造拒绝）。

**用户入口仍然可用**：同一组操作改用 `markInternalCommand()` 后，`grant_input` 与
`human_presence` 均成功（证据见 §13.0 与测试原始输出）。popup 的 `stop` / `template_command`
已在 `index.ts` 打标，行为不变。

---

## 13. 内核侧待审 patch 方案（本轮不实施，不改 `D:\c\src`）

> 本节只描述方案与精确插入点，**不生成、不应用任何 Chromium patch 文件**。所有改动默认由
> `base::Feature kInputOwnershipEnforcement` 关闭；关闭时行为与今天逐字节一致。
> 行号基于当前基线 156.0.8067.0 源码（`content/browser/renderer_host/render_widget_host_impl.cc`
> 的 `ForwardMouseEventWithLatencyInfo` :1676、`ForwardWheelEventWithLatencyInfo` :1743、
> `ForwardKeyboardEventWithCommands` :1811、`IsIgnoringWebInputEvents` :3883），实施时需按当时
> 版本复核。
>
> **2026-10-28 审计后更新**：扩展侧身份已改为不可伪造的进程内标记（§12.11），因此内核侧
> 可以只信任「受信扩展通过受信 API 写入的快照」；§13.0 给出完整的信任边界与调用方校验，
> §13.5 给出 grant 表，§13.9 给出独立验证与回滚。

### 13.0 威胁模型：内核如何确认快照 / `human_presence` 来自受信扩展

#### 13.0.1 信任层级（从低到高）

| 主体 | 能做什么 | 能否成为「用户入口」 |
|---|---|---|
| 网页 / renderer / 页面脚本 | 只能触发页面自己的事件；`isTrusted=false` 的合成事件不参与仲裁 | 否 |
| content script（本扩展） | 只能发固定的 `content_ready` / `mask_user_takeover` 消息 | 否 |
| 本机任意进程（TCP 客户端） | 持 capability token 可当 Agent；自报 `agentId` 只能得到 `agent:<sanitized>` | 否 |
| `native-host/host.js` | 唯一能给扩展注入 `_clientId` 的主体；只写 `agent:<id>` | 否（host 不是用户） |
| 扩展 SW 内部入口（popup / options / 内核事件桥） | 进程内构造命令并 `markInternalCommand()` | **是（唯一）** |
| 内核（Browser CLI 构建） | 只接受受信扩展 API 写入的快照 | 内核不产生用户身份，只消费扩展的结论 |

#### 13.0.2 内核只信「受信扩展 + 受信 API」的三层校验

`chrome.browserCli.inputOwnership.*` 是 chrome 层的 `ExtensionFunction`，运行在**浏览器进程**，
调用方身份由 Chromium 自己给出（不是消息字段）。三层校验缺一不可：

1. **构建期（API 是否存在）**
   - 只有 Browser CLI 产品构建定义 `BUILDFLAG(BROWSER_CLI)` 时才注册
     `chrome/browser/extensions/api/browser_cli/`；普通 Chrome / Chromium 没有这个 API，
     扩展侧 `host_capabilities.mode === "generic"` 自动退化为纯 JS 命令守卫（§12）。
   - `chrome/common/extensions/api/_api_features.json` 里给 `browserCli.inputOwnership`
     加 `"allowlist": ["<Browser CLI 内置扩展 ID>"]`（旧版键名 `whitelist`，实施时按当时
     Chromium 版本选键）；不在 allowlist 的扩展即使声明同名 permission 也拿不到 API。
   - `browser_cli.json` 的 `permission` 名称使用产品私有命名空间，避免与公开 API 撞名。
2. **扩展身份（调用方是谁）**
   - 每个 `ExtensionFunction` 在 `Run()` 开头校验
     `extension()->id() == kBrowserCliExtensionId`；常量由 `config/product-identity.env`
     在构建期生成（与 `manifest.json` 的 `key` 同源），**不在运行时读 manifest 文本**。
   - 扩展 ID = 扩展公钥 DER 的 SHA-256 前 128 bit 映射到 `a-p`，因此**钉住 ID 等价于钉住
     公钥哈希**；替换 manifest `key` 会得到不同 ID，直接被拒。
   - 同时拒绝：`source_context_type() != ExtensionFunction::SourceContextType::kExtension`、
     `extension()->location()` 不在允许集合（`UNPACKED` / `EXTERNAL_PREF` / `EXTERNAL_REGISTRY`，
     具体集合由产品安装方式决定）、incognito split mode、`browser_context()->IsOffTheRecord()`。
   - 不提供任何 `contentScript` / `web page` 可达的重载：API 不注册 `content_script` context。
3. **托管模式（产品是否允许）**
   - `policy::BrowserCliEnabled`（managed policy）为 true 才注册 API；未托管/被禁用时
     API 不存在，扩展侧同样退化为命令层守卫。
   - 这样即使有人把扩展 sideload 到普通 Chrome，也拿不到内核快照写入能力。

**明确拒绝**：renderer、网页、任意第三方扩展、DevTools 前端、`--remote-debugging-port`
客户端都不能调用该 API。第三方 CDP 仍然能注入输入，但注入事件带 `kFromDebugger`，
会被 controller 按当前快照一视同仁地丢弃（§13.5）——它只能拿“自动化”身份，拿不到“用户”身份。

#### 13.0.3 快照与事件的方向性

- **扩展 → 内核**：`setOwnership({windowId, mode, version})`、`setTabPolicy(...)`、
  `grantInput({windowId, actions, ttlMs})`。全部是幂等写入 + 单调 version。
- **内核 → 扩展**：`onHumanPresence({windowId, tabId, kind, at})`、`onOwnershipChanged(...)`。
  只读事件，不携带任何“请把所有权改成 X”的指令；内核永不自行改 mode。
- 内核不接受来自 renderer 的 `postMessage` / Mojo 直接调用；controller 只挂在
  `WebContentsUserData` 上，由 `RenderWidgetHostImpl` 在浏览器进程内查询。

### 13.1 新增模块与公共接口

| # | 文件 | 内容 |
|---|---|---|
| K1 | `content/public/browser/input_ownership.h`（新） | 面向 chrome 层的公共门面：`InputOwnershipMode {kAi,kAssist,kHuman}`、`InputOwnershipSnapshot {mode, version}`、`struct InputOwnershipController` 的静态入口（见下）。只前置声明 `WebContents` / `RenderWidgetHost` / `blink::WebInputEvent`，**不 include** `web_contents.h`，因此 `renderer_host/DEPS` 允许其被 RWHI 引用 |
| K2 | `content/browser/input_ownership/input_ownership_controller.{h,cc}`（新） | 每个 `WebContents` 一个 controller（`WebContentsUserData<InputOwnershipController>`）；保存 `{mode, version, last_update, tab_policies, debugger_grant_table, human_presence_debounce}`；提供 `Decide()` / `ConsumeDebuggerGrant()` / `NoteHumanPresence()`；**只读快照 + 单调 version**；grant 表按 DevTools session 记录 `{remaining, expires_at, gesture_open_until}` |
| K3 | `content/browser/renderer_host/render_widget_host_delegate.h` | 新增虚函数 `virtual InputOwnershipController* GetInputOwnershipController() { return nullptr; }`（默认 nullptr = 不启用） |
| K4 | `content/browser/web_contents/web_contents_impl.{h,cc}` | 实现 `GetInputOwnershipController()` 返回本 WebContents 的 controller；在 WebContents 构造/销毁时创建/释放（覆盖 OOPIF、导航、窗口关闭） |
| K5 | `content/browser/renderer_host/render_widget_host_impl.cc` | 三个 `Forward*` 汇合点调用 `Decide()`（见 §13.3） |
| K6 | `content/browser/devtools/protocol/input_handler.cc` | `Input.insertText` 显式走同一 controller 的 `ConsumeDebuggerGrant(kText)`（它绕过 `ForwardKeyboardEvent`，见 §13.4）；`GetEventModifiers` / `GetMouseEventButton` 的 `kFromDebugger` 语义保持不变 |
| K7 | `chrome/browser/extensions/api/browser_cli/browser_cli_input_ownership_api.{h,cc}` + `chrome/common/extensions/api/browser_cli.json` + `_api_features.json` | 受信扩展 API：`browserCli.inputOwnership.setOwnership / setTabPolicy / getOwnership / grantInput` 与 `onHumanPresence` / `onOwnershipChanged` 事件。**每个 Function 入口先过 `IsTrustedBrowserCliExtension()`**（§13.0.2 的三层校验），再写 controller；`grantInput` 是唯一能写 grant 表的入口 |
| K8 | `chrome/browser/extensions/api/browser_cli/browser_cli_extension_identity.{h,cc}`（新） | 单一身份校验点：`kBrowserCliExtensionId`（构建期由 `config/product-identity.env` 生成）、`IsTrustedBrowserCliExtension(ExtensionFunction*)`、允许的 `Manifest::Location` 集合、managed policy 检查。所有 `browserCli.*` Function 复用，禁止各自复制判断 |
| K9 | `chrome/browser/extensions/api/browser_cli/browser_cli_input_ownership_apitest.cc`（新，仅测试） | 扩展 API 的浏览器测试：受信扩展可写、伪造扩展 ID 被拒、API 未注册时调用得到 `lastError`；见 §13.9 |

公共门面（K1）形状：

```cpp
namespace content {

class RenderWidgetHost;
class WebContents;

enum class InputOwnershipMode { kAi, kAssist, kHuman };

struct InputOwnershipSnapshot {
  InputOwnershipMode mode = InputOwnershipMode::kAssist;  // 未知 → ASSIST（fail closed）
  uint64_t version = 0;
  bool stale = true;  // 超过 30s 没收到 setOwnership
};

// 全部为静态入口；内部通过 WebContentsUserData 找到 controller。
// 只有 chrome 层的受信扩展 API（K7/K8 校验通过）才允许调用这些写入口；
// content 层不提供任何 renderer/Mojo 可达的绑定。
void SetInputOwnership(WebContents* contents,
                       InputOwnershipMode mode,
                       uint64_t version);          // version 必须严格递增
InputOwnershipSnapshot GetInputOwnership(WebContents* contents);
void GrantDebuggerInput(WebContents* contents, uint32_t actions,
                        base::TimeDelta ttl);      // 仅受信扩展可调用；写 controller 的 grant 表
void SetInputOwnershipTabPolicy(WebContents* contents, int tab_id,
                                TabInputPolicy policy);  // P3 可选，先留空实现
void SetHumanPresenceCallback(
    base::RepeatingCallback<void(WebContents*, InputEventKind)> cb);

}  // namespace content
```

### 13.2 controller 内部状态与不变量

```cpp
class InputOwnershipController {
 public:
  enum class EventKind { kMouse, kWheel, kKey, kText, kTouch };
  enum class Decision { kDeliver, kDrop };

  Decision Decide(const blink::WebInputEvent& event, EventKind kind,
                  base::TimeTicks now);
  bool ConsumeDebuggerGrant(const DevToolsAgentHost* session,
                            EventKind kind, base::TimeTicks now);
  void NoteHumanPresence(const blink::WebInputEvent& event);

 private:
  InputOwnershipMode mode_ = InputOwnershipMode::kAssist;
  uint64_t version_ = 0;
  base::TimeTicks last_extension_update_;   // 只有受信扩展 API 会写它
  struct DebuggerGrant {
    uint32_t remaining = 0;
    base::TimeTicks expires_at;
    base::TimeTicks gesture_open_until;   // 一次手势内不再重复扣减
    std::string owner_extension_id;       // 写入 grant 的扩展（审计用，不做跨进程校验）
  };
  // key = DevToolsAgentHost*（session）。第三方 CDP 会话拿不到 grant 的“用户授权”语义，
  // 但可以消耗预算；见 §13.5 的已知限制。
  base::flat_map<DevToolsAgentHost*, DebuggerGrant> grants_;
};
```

不变量：

1. **人类输入永不丢弃**（除非 tab 级 `block-human`，P3 不接）：`!(mods & kFromDebugger)` →
   `kDeliver` + `NoteHumanPresence()`（300ms 去抖）。
2. `version_` 单调；`SetInputOwnership` 只接受更大的 version，重复/乱序幂等丢弃。
3. `now - last_extension_update_ > 30s` → 视为 `kAssist`（AI 输入丢弃，人类始终可用）。
4. controller 随 WebContents 销毁；不跨导航保存，不做全局单例。
5. Feature 关闭 → `Decide()` 恒 `kDeliver`，`NoteHumanPresence()` 不触发，没有任何 IPC/事件；
   `SetInputOwnership` / `GrantDebuggerInput` 直接 return（连状态都不写）。
6. **写入口只有 chrome 层受信 API**（K7 + K8）；content 层不暴露任何写入口给 renderer/Mojo。
7. grant 表只在 `GrantDebuggerInput()` 里增加，只在 `ConsumeDebuggerGrant()` 里减少；
   `remaining == 0` 或 `now >= expires_at` 即删除该 session 的记录。

### 13.3 四个入口中的三个 `Forward*` 汇合点（第四个 `insertText` 见 §13.4）

> P3 的输入仲裁共四个入口：`ForwardMouseEventWithLatencyInfo`、
> `ForwardWheelEventWithLatencyInfo`、`ForwardKeyboardEventWithCommands`（本节 A/B/C）+
> `InputHandler::InsertText`（§13.4，绕过键盘路径）。四个入口之外没有第二条注入路径；
> `Input.dispatchTouchEvent` 等未纳入的路径在 §13.10 明确列出。

**(A) `RenderWidgetHostImpl::ForwardMouseEventWithLatencyInfo`（:1676）** — 放在类型 CHECK 之后、
`mouse_event_callbacks_` 循环之前（保证被丢弃的事件不会触发任何 observer/callback）：

```cpp
  CHECK_GE(mouse_event.GetType(), WebInputEvent::Type::kMouseTypeFirst);
  CHECK_LE(mouse_event.GetType(), WebInputEvent::Type::kMouseTypeLast);

  if (base::FeatureList::IsEnabled(features::kInputOwnershipEnforcement)) {
    if (auto* controller = delegate_ ? delegate_->GetInputOwnershipController() : nullptr) {
      if (controller->Decide(mouse_event, EventKind::kMouse, base::TimeTicks::Now()) ==
          Decision::kDrop) {
        return;
      }
    }
  }

  for (auto& mouse_event_callback : mouse_event_callbacks_) { ... }
  if (IsIgnoringWebInputEvents(mouse_event)) return;
```

**(B) `ForwardWheelEventWithLatencyInfo`（:1743）** — 放在 `ScopedSafetyChecksExclusion` 之后、
`IsIgnoringWebInputEvents` 之前：同上，`EventKind::kWheel`。

**(C) `ForwardKeyboardEventWithCommands`（:1811）** — **必须放在浏览器 UI 预处理之后**，
否则 Ctrl+L / Ctrl+T / Ctrl+W 会被页面输入权拦掉（设计 §4.1 不变量 4）：

```cpp
  // 既有：owner_delegate_->MayRenderWidgetForwardKeyboardEvent
  // 既有：IsIgnoringWebInputEvents
  // 既有：Escape 关闭 unbounded surface
  // 既有：KeyPressListenersHandleEvent
  // 既有：suppress_events_until_keydown_ 处理
  // 既有：delegate_->PreHandleKeyboardEvent()  ← Ctrl+L/T/W/F5 在这里被浏览器 UI 处理并 return

  // ↓ 新增：浏览器快捷键已经处理完，剩下的才是“要进页面”的键盘输入
  if (base::FeatureList::IsEnabled(features::kInputOwnershipEnforcement)) {
    if (auto* controller = delegate_ ? delegate_->GetInputOwnershipController() : nullptr) {
      if (controller->Decide(key_event, EventKind::kKey, base::TimeTicks::Now()) ==
          Decision::kDrop) {
        // 丢掉 RawKeyDown 后，同一物理键的后续 Char/KeyUp 必须一起丢，
        // 否则页面会看到“只抬起没按下”的残键。
        if (key_event.GetType() == WebKeyboardEvent::Type::kRawKeyDown ||
            key_event.GetType() == WebKeyboardEvent::Type::kKeyDown) {
          suppress_events_until_keydown_ = true;
        }
        return;
      }
    }
  }

  // 既有：touch_emulator->HandleKeyboardEvent / SendKeyboardEvent
```

> 注意：`delegate_` 就是 `RenderWidgetHostDelegate*`（FrameTree 的 render_widget_delegate，
> 即 `WebContentsImpl`），主帧与 local child root 都拿得到；`owner_delegate_`（RenderViewHostImpl）
> 不用于该查询。

### 13.4 `Input.insertText` 是必须显式补的第四条路径

`actions.ts` 的 `type` / `fill` 走 `Input.insertText`，它在
`content/browser/devtools/protocol/input_handler.cc::InputHandler::InsertText`（:1281）里直接
`widget_host->GetWidgetInputHandler()->ImeCommitText(...)`，**不经过**
`ForwardKeyboardEventWithCommands`。若只改三个 `Forward*`，`type`/`fill` 会绕过输入权。
方案：在 `InputHandler::InsertText` 取到 `widget_host` 之后：

```cpp
  if (base::FeatureList::IsEnabled(features::kInputOwnershipEnforcement)) {
    auto* controller = widget_host->delegate()
        ? widget_host->delegate()->GetInputOwnershipController() : nullptr;
    // host() = 当前 InputHandler 所属的 DevToolsAgentHost（实施时按当时版本的
    // InputHandler 成员/访问器取值），grant 表按 session 记录。
    if (controller && !controller->ConsumeDebuggerGrant(host(), EventKind::kText,
                                                        base::TimeTicks::Now())) {
      callback->sendFailure(Response::ServerError(
          "InputOwnership: insertText rejected (grant required)"));
      return;
    }
  }
```

`Input.dispatchTouchEvent` / `DispatchWebTouchEvent`（:1655）在 P3 暂不纳入（见 §13.10）。

### 13.5 `kFromDebugger` 判定、grant 表与来源绑定

#### 13.5.1 判定只有一处

`(event.GetModifiers() & blink::WebInputEvent::kFromDebugger) != 0`。
`GetEventModifiers()`（:97）与 `GetMouseEventButton()`（:165）已经给所有 `Input.dispatch*`
事件置位；`InputInjector::OnInputEventAck()`（:839）已经用同一位过滤 ack。**不新增 modifier 位**
（§11 决定 4）。人类输入 = `!kFromDebugger`，**永远投递**（窗口级不丢弃）。

#### 13.5.2 grant 表（内核侧第二道防线）

- 写入：只有 `chrome.browserCli.inputOwnership.grantInput({windowId, actions, ttlMs})` 能写；
  该 Function 先过 §13.0.2 的三层校验，再调用 `GrantDebuggerInput()`。
- 记录：`{remaining, expires_at, gesture_open_until, owner_extension_id}`，按
  `DevToolsAgentHost*`（session）分桶；`remaining` 上限 `10000`、`ttl` 上限 `600000ms`
  （与扩展侧 §12.5 的常量一致）。
- 消耗：只有 `Decide()` 的自动化分支与 `InputHandler::InsertText` 会调用
  `ConsumeDebuggerGrant(session, kind, now)`；没有 grant → `kDrop`（`insertText` 返回
  `ServerError`）。
- 清理：`remaining == 0`、过期、`setOwnership` 变更、WebContents 销毁都会删除对应记录。
- **已知限制（明确记录）**：`chrome.debugger` 的注入会话与第三方 CDP 会话在内核里都是
  `DevToolsAgentHost`，`kFromDebugger` 不区分来源（§11 决定 4）。因此第三方 CDP 可以
  *消耗* grant 预算，但不能*增加*它；最坏结果是“人类授权的 N 次输入被第三方抢走”，
  不会出现“无授权也能输入”。如果未来需要严格绑定到扩展自己的 session，可让
  `grantInput` 额外携带扩展侧的 `debuggee` 标识，并在 `ExtensionDevToolsClientHost`
  上做匹配；P3 不做（避免依赖未稳定的内部类型）。

#### 13.5.3 手势级计数（不是逐事件）

grant 计数按**输入手势**，而不是按单个 `WebInputEvent`（否则一次 click 的
pressed+released、一次 press 的 keyDown+keyUp+char 会吃掉多次 grant）：

| 手势 | 扣减时机 | 同一手势内免扣 |
|---|---|---|
| 鼠标 | `kMouseDown`（无按键的 `kMouseMove`/hover 每次扣 1） | 直到 `kMouseUp` 后 200ms 内的 move/up/click |
| 滚轮 | 每个 `kMouseWheel` 扣 1 | — |
| 键盘 | `RawKeyDown` / `KeyDown` 扣 1 | 同一物理键的 Char/KeyUp 直到下一个 RawKeyDown |
| 文本 | 每次 `Input.insertText` 扣 1 | 300ms 内的连续 insertText 只扣一次（覆盖 `type` 逐字输入） |

语义边界：内核 grant 是**第二道防线**，计数与扩展命令不是 1:1；权威的「每条命令一次」预算
仍在扩展层（§12.5）。内核只需要保证「没有 grant 时绝不投递 AI 输入」。

被丢弃事件的 DevTools 回调语义：事件在 `Forward*` 前直接 return，`InputInjector` 的
`OnInputEvent` observer 不会收到事件，`input_queued_` 保持 false，注入器会立即
`sendSuccess()`（既有逻辑）。也就是说第三方 CDP 会收到成功应答但页面没有输入——这是
有意的 fail-closed；`insertText` 路径则显式返回 `ServerError`，便于第三方诊断。

### 13.6 `human_presence` 上报（只由受信扩展消费）

复用既有 `RenderWidgetHost::InputEventObserver`（`content/public/browser/render_widget_host.h:250`），
或在 `Decide()` 的人类分支里直接调用 `controller->NoteHumanPresence(event)`：

1. 仅对 `!kFromDebugger` 事件调用；浏览器 UI 快捷键不会到 RWHI，因此不会误报。
2. controller 内 300ms 去抖（鼠标 move 洪泛只保留最后一个），去抖后通过
   `SetHumanPresenceCallback()` 注册的回调上报；chrome 层把它转成
   `browserCli.inputOwnership.onHumanPresence({windowId, tabId, kind, at})`。
   **事件只投递给 §13.0.2 校验通过的扩展**；扩展卸载/失联时事件直接丢弃（不广播给其它扩展）。
3. 扩展收到后按 §12.6 走 500ms 去抖 → `enterAssist()`；默认 `pause` 策略下人类输入照常投递。
   扩展侧的身份判定不依赖事件内容：内核事件桥在扩展 SW 内部用 `markInternalCommand()`
   调用 `humanPresenceCommand`（§12.11），外部 Agent 无法伪造同样的调用。
4. 内核**不**自行改 mode；人类输入只产生事件，不产生状态迁移。
5. 反向保护：内核**不**接受任何“扩展说人类在场”的直接写 mode 调用；
   `human_presence` 只产生事件，`enterAssist` 的决策仍在扩展层（人类优先、可审计）。

### 13.7 Feature、灰度与回滚

#### 13.7.1 Feature 开关

- `base::Feature kInputOwnershipEnforcement` 放 `content/public/common/content_features.{h,cc}`，
  `FEATURE_DISABLED_BY_DEFAULT`；`chrome://flags/#input-ownership-enforcement` 可显式开启（仅开发）。
- 关闭时（默认）：
  - `SetInputOwnership` / `GrantDebuggerInput` / `SetInputOwnershipTabPolicy` 直接 return；
  - `Decide()` 恒 `kDeliver`；`ConsumeDebuggerGrant()` 恒 true；
  - `NoteHumanPresence()` 不触发，不注册 observer，不发任何事件；
  - 每个入口只有一次 `base::FeatureList::IsEnabled()` 检查（静态缓存），不改变任何既有分支顺序。
- 回归证据：同一套 browser test 在 feature off 下必须全部恢复今天的 DOM 计数/事件序列；
  `Input.dispatch*` 的参数与默认行为零改动。

#### 13.7.2 灰度顺序（每一档都可独立回滚）

1. 只开 `human_presence` 上报（只读）：观察误报率与事件量，不影响投递。
2. 开 HUMAN 丢弃：只对 `ownership=user` 的窗口生效，人类输入不受影响。
3. 开 ASSIST grant：先只对显式 `grant_input` 的窗口生效。
4. 全量：扩展侧 `setOwnership` 心跳覆盖所有 space。

#### 13.7.3 回滚

- 内核：一个编号 patch 集合整体 revert（K1-K9 同进同退）；feature 常量保留但不再被引用。
- 扩展：命令层守卫独立于内核能力，回滚内核后仍是「今天的语义 + 更严格的命令门禁」；
  `host_capabilities.mode === "generic"` 时只启用命令层守卫。
- 数据面：`SpaceState.assist` 是可选字段，回滚不需要迁移 `storage.session`。
- 信任边界修复（§12.11）与内核 patch 无耦合：即使内核方案全部回滚，外部客户端仍然
  无法伪造用户身份。

### 13.8 失败模式（内核侧）

| 失败 | 现象 | 处理 |
|---|---|---|
| Feature 关闭 / 未注入 API | 扩展拿不到内核能力 | 只启用扩展命令层守卫；内核行为与今天一致 |
| 扩展与内核失联 > 30s | 快照过期 | 降级 ASSIST：AI 输入丢弃，人类始终可用 |
| version 回退/乱序 | 旧快照 | 拒绝，保持当前 mode |
| SW 重启 | 扩展内存态清空 | `assist` 在 `storage.session`；扩展重连后重推 `setOwnership`（version 继续递增） |
| 第三方 CDP | 注入带 `kFromDebugger` | 与自有 AI 一视同仁：HUMAN 丢弃、ASSIST 需 grant；来源不可区分是已知限制 |
| OOPIF / 子帧 | 是否绕过 | controller 属于 WebContents，主帧与 local child root 的 `delegate_` 都是 `WebContentsImpl`；实施时必须加 OOPIF browser test 验证 |
| 人类用快捷键关窗 | 空间消失 | `windows.onRemoved` → ownership inactive；controller 随 WebContents 销毁 |
| grant 泄漏 | AI 持续操作 | 计数 + 绝对 TTL；手势级扣减；ownership 变更/新 presence 清空 |
| 事件洪泛 | 大量 presence | controller 300ms 去抖 + 扩展 500ms 去抖 |
| 伪造扩展调用 API | 非 allowlist 扩展 / 非 managed mode | API 未注册或 `lastError`；controller 状态不变（§13.0.2） |
| 扩展侧身份不可信 | 缺 host 身份且非内部标记 | `INPUT_IDENTITY_UNTRUSTED`，不消耗 grant、不改 mode（§12.11） |
| 第三方 CDP 抢 grant 预算 | 人类授权的 N 次被提前消耗 | 只会“少放”，不会“多放”；重新 `grant_input` 即可（§13.5.2 已知限制） |

### 13.9 独立验证计划（实施时；与扩展侧测试分开跑）

| 层级 | 测试 | 断言 |
|---|---|---|
| 单元 | `InputOwnershipControllerTest`（content_unittests） | version 单调/乱序丢弃；30s 过期→ASSIST；grant 手势级扣减；feature off 恒 `kDeliver`；人类输入永不被 drop |
| 单元 | 仲裁纯函数表驱动 | `Decide(mode, fromDebugger, kind, hasGrant)` 覆盖 3×2×5×2 组合，与 §4 的表格逐项一致 |
| 浏览器 | `InputOwnershipBrowserTest` | 真实 `Input.dispatchMouseEvent` / `insertText`：AI 可点；HUMAN DOM 计数不变；ASSIST 无 grant 不点；grant 后恰好一次；`insertText` 无 grant 返回 `ServerError` |
| 浏览器 | OOPIF / 子帧 | iframe 内按钮在主帧与子帧输入下都受同一 controller 约束 |
| 浏览器 | 浏览器 UI 快捷键 | HUMAN 下 Ctrl+L / Ctrl+T / F5 仍生效（不纳入页面输入权） |
| 真实输入 | 独立 CI 机器（隔离 profile） | 用不带 `kFromDebugger` 的 `RenderWidgetHostImpl::ForwardMouseEvent` 模拟 OS 人类输入：事件必达页面，300ms 去抖后只上报一次 `human_presence`；自动化注入在 HUMAN/ASSIST 下被丢弃 |
| 安全负向 | 扩展 API 身份测试（K9） | 非 allowlist 扩展 ID 调用 `browserCli.inputOwnership.*` 得到 `lastError`；普通 Chrome 无该 API；managed policy 关闭时 API 不存在；API 不接受任何“调用方身份”参数（身份只来自 `ExtensionFunction`） |
| 安全负向 | 第三方 CDP | 第二个 CDP 客户端在 HUMAN 下注入鼠标/键盘/`insertText` 全部不落地；ASSIST 下无 grant 不落地 |
| 回归 | Feature-off 全量 | 上述 browser test 在 feature 关闭时逐项恢复今天行为（DOM 计数/事件序列一致） |
| 回滚 | patch revert 演练 | 单独 revert K1-K9 后编译通过、扩展侧 `test:input-ownership*` 全绿、`host_capabilities` 自动降级 |

**独立验证原则**：内核测试不得复用扩展侧 JS 断言作为唯一证据；同一行为必须同时有
（a）内核单测/浏览器测试的 DOM/事件证据，和（b）扩展侧 `input_status` / 审计事件证据。
两套测试由不同 CI job 跑，结果都贴原始输出（本仓库已有扩展侧原始输出，见 §12.9/§12.11）。

### 13.10 明确未覆盖（待后续 patch）

1. **触摸 / 手势注入**（`Input.dispatchTouchEvent`、`ForwardGestureEvent`）：P3 不纳入，
   需要单独的 controller 检查点。
2. **IME 组合输入**（`ImeSetComposition` / `ImeCommitText` 的其它调用方）：P3 只覆盖
   `InputHandler::InsertText` 这一条 DevTools 路径。
3. **自动化来源细分**（DevTools 手工调试 vs 插件 AI）：沿用 `kFromDebugger` 不区分（§11 决定 4）。
4. **grant token 的跨进程校验**：P3 内核 grant 表由受信扩展 API 写入，token 只用于扩展侧
   审计；内核按 `{remaining, ttl}` 计数，不解析 token，也不做 session 级来源绑定（§13.5.2）。
5. **内核侧审计事件**：P3 只做 UMA/`TRACE_EVENT` 与 `human_presence` 回调，不新增 DevTools
   domain；扩展仍是审计真源。
6. **扩展 ID allowlist 的运维**：ID 常量随产品构建生成；扩展签名/公钥轮换需要同步发版
   （这是有意的：轮换等同于更换受信主体）。

### 13.11 与扩展侧信任修复的衔接（已落地）

- 扩展侧用户身份 = `markInternalCommand()` 的进程内 WeakSet 标记（§12.11），内核侧
  不需要、也不能信任任何“扩展说自己是用户”的消息字段。
- 内核事件桥（未来 `browserCli.inputOwnership.onHumanPresence` 的扩展侧回调）在 SW 内部
  构造命令并打标，等价于 popup 入口；外部 Agent 即使同时持有 capability token，
  也无法产生同样的调用。
- 内核 `grantInput` 的授权语义来自**人类在 popup/遮罩上的显式操作**；扩展侧 `grant_input`
  仍要求进程内标记。两层都不接受 `_clientId` / `_channel` / `internal` 字段。
- 因此 P3 的信任链是：人类点击（扩展 UI）→ SW 内部标记 → 受信扩展 API（内核校验扩展 ID /
  managed mode）→ controller 快照/grant → `RenderWidgetHostImpl` 仲裁。
  链上任何一环都不依赖可伪造的消息字段。
