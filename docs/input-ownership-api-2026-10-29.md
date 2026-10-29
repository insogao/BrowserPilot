---
type: DeveloperArchitecture
status: production-api-design + extension-side-implemented
generated: { by: agent-k, at: 2026-10-29T12:00:00+08:00 }
stale_after: 2027-04-29
scope: |
  P3 输入权生产 API：chrome.browserCli.inputOwnership 的 schema、信任边界、版本/心跳、
  session 绑定、命令↔手势语义、失败模式与回滚。扩展侧客户端已实现并通过离线单测；
  内核侧（patch 028 修订 + chrome 扩展 API 层）由 Agent J / 主代理后续实现。
---

# 输入权生产 API（`chrome.browserCli.inputOwnership`）

> 设计依据：`docs/input-ownership-design-2026-10-28.md` §11（主代理决定）、§12（扩展侧已落地）、
> §13（内核方案与信任模型）；内核现状：`chromium/patches/028-input-ownership-arbitration.patch`
> + `docs/windows-input-arbitration-kernel-2026-10-29.md`（J，最小集，尚无扩展 API / 心跳 /
> session 绑定）。
>
> 一句话：**扩展仍是所有权唯一真源；内核只接受受信扩展写入的「每目标 mode + 单调 version」
> 快照，并用 session 绑定的 grant 做第二道投递防线。** 普通 Chrome / Feature 关闭时 API 不存在，
> 扩展退化为纯命令层守卫，行为与今天一致。

---

## 0. 结论摘要

| # | 决定 | 状态 |
|---|---|---|
| 1 | 命名空间：`chrome.browserCli.inputOwnership`，6 个方法 + 1 个事件 | 本文设计 |
| 2 | `setOwnership` / `heartbeat` / `getOwnership` 是核心；`grantInput` + `beginInputCommand` / `endInputCommand` 是 ASSIST 命令 scope 三件套 | 设计 |
| 3 | **采用** `beginInputCommand` / `endInputCommand`：一条扩展命令 = 一次内核 grant；解决 `dblclick`（2 次 press/release）、`type`（N 次 insertText）、`wheel`（多 tick）与内核手势计数不一致 | 设计 + 客户端已实现 |
| 4 | 每目标单调 `version`；同 version 同 mode 幂等并刷新 `last_update`；低 version 拒绝；同 version 不同 mode 冲突拒绝 | 设计；需 J 补 `last_update`/`stale` |
| 5 | 心跳 10s（`setInterval`）；30s 无确认内核降级 ASSIST 并清 grant；扩展侧同时标记 degraded，AI 输入 fail closed | 客户端已实现；内核待补 |
| 6 | grant 绑定到「受信扩展的 `chrome.debugger` 会话 + 目标 WebContents」；第三方 CDP 会话不能复用 | 设计；需 J 补 session 绑定 |
| 7 | 网页 / content script / 任意第三方扩展 / DevTools 前端 / `--remote-debugging-port` 客户端**不可达**该 API | 设计；K7/K8 实现 |
| 8 | Feature 默认关闭；关闭时 API 不注册、内核 `Decide()` 恒放行、扩展零调用 | 继承 §13.7 |
| 9 | 明确边界：`Runtime.evaluate` 直接改 DOM 不参与输入仲裁；第三方 CDP 只能拿到「自动化」身份 | 本文 §7 |

---

## 1. 命名空间与 schema

### 1.1 命名空间

```jsonc
// chrome/common/extensions/api/browser_cli.json（在现有 getCapabilities 之后追加）
{
  "namespace": "browserCli",
  "types": [
    { "id": "InputOwnershipMode", "type": "string", "enum": ["ai", "assist", "human"] },
    { "id": "InputOwnershipTarget", "type": "object", "properties": {
      "tabId":    { "type": "integer", "optional": true },
      "windowId": { "type": "integer", "optional": true }
    }},
    { "id": "InputOwnershipSnapshot", "type": "object", "properties": {
      "mode":      { "$ref": "InputOwnershipMode" },
      "version":   { "type": "integer" },
      "stale":     { "type": "boolean" },
      "lastUpdateAt": { "type": "integer", "optional": true }
    }},
    { "id": "InputOwnershipGrant", "type": "object", "properties": {
      "remaining": { "type": "integer" },
      "expiresAt": { "type": "integer" }
    }}
  ],
  "functions": [
    { "name": "setOwnership",  "type": "function" },
    { "name": "grantInput",    "type": "function" },
    { "name": "beginInputCommand", "type": "function" },
    { "name": "endInputCommand",   "type": "function" },
    { "name": "heartbeat",     "type": "function" },
    { "name": "getOwnership",  "type": "function" }
  ],
  "events": [
    { "name": "onHumanPresence", "type": "function" }
  ]
}
```

约束：

- 上面的 JSON 省略了每个 function 的 `parameters` / `returns_async` 明细（完整签名见 §1.2–§1.8）；
  实施时 `browser_cli.json` 必须逐个补齐，字段名用 camelCase（Chromium API 生成器会转 snake_case）。
- `target` **必须且只能**包含 `tabId` 或 `windowId` 之一；两者都给或都不给 → `INVALID_TARGET`。
- `windowId` 目标由 chrome 层展开为该窗口当前及未来（`TabStripModelObserver`）的 WebContents；
  `tabId` 是精确覆盖（优先级高于窗口快照）。
- 所有 `version` / `actions` / `ttlMs` / 时间戳都是整数；浮点、负数、字符串一律 `INVALID_ARGUMENT`。
- 所有 Promise 拒绝都带 `reason` 字符串（稳定的机器码），`message` 只用于诊断。

### 1.2 `setOwnership({target, mode, version})`

```ts
setOwnership(request: {
  target: { tabId: number } | { windowId: number };
  mode: "ai" | "assist" | "human";
  version: number; // 0 < version <= 2^53-1
}): Promise<{
  accepted: boolean;
  mode: "ai" | "assist" | "human";
  version: number;
  reason?: string; // STALE_VERSION | VERSION_CONFLICT | UNKNOWN_TARGET | INVALID_ARGUMENT | FEATURE_DISABLED
}>;
```

语义：

1. 目标当前接受版本为 `V`。
   - `version > V`：接受；写入 `configured_mode = mode`、`version = version`、`last_update = now`，
     **清空该目标所有 session grant**，`stale = false`。
   - `version === V` 且 `mode === configured_mode`：幂等接受，仅刷新 `last_update`（不 bump）。
   - `version === V` 且 `mode !== configured_mode`：拒绝 `VERSION_CONFLICT`，返回当前 `mode/version`
     （扩展必须用 `V+1` 重发）。
   - `version < V`：拒绝 `STALE_VERSION`，返回当前 `mode/version`（扩展采纳后重试）。
2. 目标不存在（窗口/标签已关闭）→ `UNKNOWN_TARGET`，不创建状态。
3. **mode 变化必须清 grant**；同 mode 幂等重放不清（避免心跳把刚发的 grant 清掉）。
4. 该调用是**唯一**能推进 `version` 的入口；`heartbeat` 不能推进。

### 1.3 `grantInput({target, actions, ttlMs, session?})`

```ts
grantInput(request: {
  target: { tabId: number };   // windowId 目标拒绝：grant 必须绑定到具体 session + WebContents
  actions: number;             // 1..10000
  ttlMs: number;               // 1..600000
  session?: string;            // 可选 opaque token；缺省由内核按调用方扩展 + tabId 解析
}): Promise<{
  granted: boolean;
  actions: number;
  expiresAt: number;           // 绝对时间（ms since epoch）
  sessionToken?: string;       // 内核解析出的 session 标识（仅诊断/审计）
  reason?: string;             // NO_DEBUGGER_SESSION | SESSION_MISMATCH | INVALID_TARGET | INVALID_ARGUMENT
}>;
```

语义：

1. 内核解析**调用方扩展自己的** `chrome.debugger` 会话：
   `extension_id + tabId → ExtensionDevToolsClientHost → DevToolsAgentHost/DevToolsSession*`。
   找不到 → `NO_DEBUGGER_SESSION`（扩展需要先 attach）。
2. grant 记录 key = `{WebContents*, DevToolsSession*}`，值 = `{remaining, expires_at, session_token,
   owner_extension_id, command_scope?}`。**不会**写到别的 session 桶里。
3. `expiresAt = now + ttlMs` 是绝对截止；到点即删，与有没有被消费无关。
4. `actions`/`ttlMs` 夹紧上限（与扩展侧 §12.5 常量一致：10000 / 600000ms）。
5. 若目标已处于 HUMAN：grant 可以写（记录存在），但 HUMAN 下任何 debugger 输入仍然丢弃；
   扩展层本来就不允许 HUMAN 下 `grant_input`（`INPUT_HUMAN_OWNED`）。
6. 同一 session 重复 `grantInput`：**替换**而不是累加（一次协助只有一个预算；避免泄漏）。
7. `grantInput` 不改 `mode`、不刷新 `last_update`、不影响 `version`。

### 1.4 `beginInputCommand({target, commandId, kind, session?})`

```ts
beginInputCommand(request: {
  target: { tabId: number };  // 只接受具体 tab
  commandId: string;          // 扩展生成，单次命令唯一；同 commandId 幂等
  kind: string;               // 扩展命令名（click/dblclick/type/...），内核只用于 TTL/审计，不做业务判断
  session?: string;           // 可选；缺省同 grantInput
}): Promise<{
  ok: boolean;
  scopeId?: string;
  deadline?: number;          // 绝对截止（ms）
  grantRemaining?: number;
  reason?: string;            // GRANT_REQUIRED | SCOPE_EXISTS | SESSION_MISMATCH | UNKNOWN_TARGET
}>;
```

语义：

1. 只有 ASSIST 需要 scope。`mode === "ai"` 时返回 `ok:true` + 不占 grant（扩展客户端不会在 AI 调用）。
2. **预占** 1 个 grant 单位（`remaining -= 1`，但不删除记录；`remaining === 0` 时标记为 reserved）。
   没有有效 grant → `GRANT_REQUIRED`。
3. 建立 command scope：`{scope_id, command_id, session, deadline}`；
   `deadline = min(now + kind_ttl(kind), grant.expires_at)`；`kind_ttl`：鼠标类 10s、
   `type`/`fill` 60s、`js`/`tab_cdp_call` 120s（客户端 `commandTtlFor()` 与之对齐）。
4. 同一 `commandId` 重试 → 返回同一个 scope（幂等），不重复扣减。
5. scope 内所有来自**同一 session** 的 debugger 输入都算「已授权」且**不再逐事件/逐手势扣减**；
   这就是「一条扩展命令 = 一次内核 grant」的落点。
6. scope 外的事件回到 §5 的手势级计数（兼容不调用 begin 的旧客户端）。

### 1.5 `endInputCommand({target, commandId, outcome?, session?})`

```ts
endInputCommand(request: {
  target: { tabId: number };
  commandId: string;
  outcome?: "ok" | "failed" | "cancelled"; // default "ok"
  session?: string;
}): Promise<{ closed: boolean; reason?: string }>;
```

语义：

1. 正常关闭 scope；**预占的单位在 `ok` / `failed` 下都保持已消耗**（与扩展侧 §12.10
   「按投递尝试次数计费」一致），`cancelled` 允许内核在「scope 内没有任何输入事件」时退回 1 单位。
2. 未知 `commandId` → `{closed:false, reason:"UNKNOWN_COMMAND"}`，不报错（幂等/迟到 end）。
3. scope 到期未 end：内核自动关闭；预占单位保持消耗；`deadline` 之后该 scope 的输入按普通规则
   （没有 grant 就丢）。
4. end 失败/丢失不会让授权长期有效：绝对 `deadline` + grant `expiresAt` 双重兜底。

### 1.6 `heartbeat({target, version})`

```ts
heartbeat(request: {
  target: { tabId: number } | { windowId: number };
  version: number;            // 必须是内核当前接受的 version
}): Promise<{
  ok: boolean;
  mode: "ai" | "assist" | "human";
  version: number;
  stale: boolean;             // 本次调用后仍为 stale 才为 true（正常应为 false）
  grant?: { remaining: number; expiresAt: number };
  reason?: string;            // STALE_VERSION | VERSION_UNKNOWN | UNKNOWN_TARGET
}>;
```

语义：

1. 成功：刷新目标的 `last_update = now`、`stale = false`；对 window 目标重新展开当前 tab 集合并
   刷新每个绑定 WebContents 的 `last_update`（新 tab 在这里被纳入）。
2. **不改变 mode、不推进 version、不清 grant**。
3. `version < 内核 version` → `ok:false, reason:"STALE_VERSION"`，返回内核 `mode/version`。
4. `version > 内核 version` → `ok:false, reason:"VERSION_UNKNOWN"`（只有 setOwnership 能推进版本）。
5. 目标未知 → `ok:false, reason:"UNKNOWN_TARGET"`（扩展删除账本，不重试）。
6. 内核在 `now - last_update > 30s` 时把 **effective mode** 视为 `assist` 并清 grant；**不覆写
   configured_mode**。心跳恢复后 effective mode 立即回到 configured_mode（无需 setOwnership）。
   这一点是 J 的内核必须补的语义（当前 patch 只存 `mode_`，没有 `last_update`/`stale`）。

### 1.7 `getOwnership({target})`

```ts
getOwnership(request: {
  target: { tabId: number } | { windowId: number };
}): Promise<{
  mode: "ai" | "assist" | "human";
  version: number;
  stale: boolean;
  lastUpdateAt?: number;
  grant?: { remaining: number; expiresAt: number };
  sessionToken?: string;
  reason?: string;
}>;
```

只读；**不**刷新 `last_update`、不改变任何状态。扩展用于诊断、版本冲突时读取内核真值。

### 1.8 `onHumanPresence` 事件

```ts
chrome.browserCli.inputOwnership.onHumanPresence.addListener((event: {
  tabId: number;
  windowId?: number;
  kind: "mouse" | "wheel" | "key" | "text" | "touch" | string;
  at: number;                 // 内核时间（ms since epoch）
}) => void);
```

约束：

1. 只投递给 §2 校验通过的受信扩展；扩展卸载/失联时事件直接丢弃，**不广播**给其它扩展。
2. 事件语义只有「人类在场」，不携带「请把 mode 改成 X」；内核永不自行改 mode。
3. 内核侧 300ms 去抖；扩展侧再做 500ms trailing 去抖（设计 §11 决定 2），然后走
   `human_presence` 内部命令进入 ASSIST。
4. 浏览器 UI 快捷键（Ctrl+L/T/W、F5）在 RWHI 之前被处理，不会产生该事件（§7）。

### 1.9 错误码（稳定字符串）

| reason | 触发 |
|---|---|
| `INVALID_TARGET` | target 同时/都没有 tabId/windowId；window 目标用于 grant/begin/end |
| `INVALID_ARGUMENT` | version/actions/ttlMs 非整数、越界、commandId 为空 |
| `UNKNOWN_TARGET` | tab/window 已关闭或从未注册 |
| `STALE_VERSION` | version 小于内核当前接受版本 |
| `VERSION_CONFLICT` | 同 version 不同 mode |
| `VERSION_UNKNOWN` | heartbeat version 大于内核版本 |
| `NO_DEBUGGER_SESSION` | grantInput/begin 时调用方扩展没有该 tab 的 debugger 会话 |
| `SESSION_MISMATCH` | 传入的 session token 与解析出的会话不一致 |
| `GRANT_REQUIRED` | ASSIST 下 begin 时没有有效 grant |
| `SCOPE_EXISTS` | 同 commandId 已存在且参数不兼容（正常重试应幂等成功） |
| `UNKNOWN_COMMAND` | end 一个不存在的 commandId |
| `FEATURE_DISABLED` | API 被注册但 feature 关闭（本设计选择不注册，理论上不可见） |
| `PERMISSION_DENIED` | 调用方未通过 §2（正常应表现为 API 不存在 + `lastError`） |

---

## 2. 可信调用方校验

> 核心原则：**身份只来自 Chromium 的 `ExtensionFunction`，不接受任何请求字段**。API 不接受
> `extensionId` / `clientId` / `internal` / `token` 之类的“我是谁”参数。

### 2.1 构建期：API 是否存在

| 条件 | 结果 |
|---|---|
| 构建定义了 Browser CLI 产品宏，且 `features::kInputOwnershipEnforcement` 启用 | `chrome.browserCli.inputOwnership` 注册 |
| 普通 Chrome / Chromium | 命名空间不存在 → 扩展 `host_capabilities.mode === "generic"`，客户端零调用 |
| Browser CLI 但 feature 关闭（默认） | **不注册**该命名空间（比“注册后返回 FEATURE_DISABLED”更安全：调用方无法探测/误用） |
| Browser CLI 但 managed mode 关闭 | 不注册（与 Phase 7 `getCapabilities().managedMode` 一致） |

`_api_features.json`：

```jsonc
"browserCli.inputOwnership": {
  "channel": "stable",
  "extension_types": ["extension"],
  "contexts": ["blessed_extension"],          // 明确排除 content_script / web_page
  "allowlist": ["<Browser CLI 内置扩展 ID>"], // 旧版键名 whitelist，按当时版本选
  "min_manifest_version": 3
}
```

### 2.2 扩展身份：ID allowlist + SHA-256 哈希

1. 构建期由 `config/product-identity.env` + `manifest.json` 的 `key` 生成
   `kTrustedBrowserCliExtensionIdHashes[] = { sha256(extension_id) }`（小写 hex）。
   本仓库当前扩展 ID 为 `nnollghpaggbcdkkgoieneffnlijinio`
   （SHA-256 `0fc2b72bf7525eefa66518c54db602118b38eb5e8ae1b2992eeb0e57911c1722`）。
2. 每个 Function 入口统一调用 `IsTrustedBrowserCliExtension(this)`：
   `sha256(extension()->id())` 必须命中哈希表；**不**在源码里比较明文 ID，
   避免出现可被字符串搜索/替换的单点常量。
3. 扩展 ID = 公钥 DER 的 SHA-256 前 128 bit → 钉住 ID 等价于钉住公钥；替换 `manifest.key`
   会得到不同 ID，直接拒绝。
4. 允许集合（`Manifest::Location`）：
   - 发布版只允许 `EXTERNAL_PREF` / `EXTERNAL_REGISTRY`（产品安装路径）；
   - 开发构建可额外允许 `UNPACKED`，但必须由构建期宏 `BROWSER_CLI_DEVTOOLS_EXTENSIONS` 控制，
     发布构建不得打开。
   - 明确拒绝 `COMPONENT` / `POLICY` 之外的所有未知位置（默认拒绝，不枚举）。

### 2.3 每次调用的上下文校验（缺一不可）

```cpp
bool IsTrustedBrowserCliExtension(ExtensionFunction* function) {
  if (!function) return false;
  const Extension* extension = function->extension();
  if (!extension) return false;                                   // 不是扩展调用
  if (function->source_context_type() !=
      ExtensionFunction::SourceContextType::kExtension) {
    return false;                                                 // content script / web page
  }
  if (!IsAllowlistedExtensionIdHash(extension->id())) return false;
  if (!IsAllowedManifestLocation(extension->location())) return false;
  if (extension->is_incognito_split_mode()) return false;          // split incognito
  if (function->browser_context()->IsOffTheRecord()) return false; // OTR / 隐身
  if (!IsManagedModeEnabled()) return false;                       // --browser-cli-background-presentation
  return true;
}
```

- **不提供** content script / 网页可达的重载；`contexts` 已在 API feature 层排除。
- 不读 manifest 文本、不读 URL、不读请求里的任何身份字段。
- `chrome.debugger` 会话查找同样以 `extension()->id()` 为准（`ExtensionDevToolsClientHost`），
  不接受扩展传入的 session 归属声明。

### 2.4 managed mode

`policy::BrowserCliEnabled` + `views::BrowserCliPresentationPolicy::IsManagedModeEnabled()`：

- API 注册与每次调用都要求 managed mode；
- 未托管/被策略禁用时 API 不存在；扩展侧 `detectHostCapabilities()` 返回 generic，
  客户端不探测第二次、不发送任何调用。

### 2.5 不可达的调用方

| 调用方 | 结果 |
|---|---|
| 网页 / renderer / 页面脚本 | 无扩展 API 权限；`chrome.browserCli` 不可见 |
| content script（本扩展） | `contexts` 排除；即使消息转发到 SW，SW 侧也没有对应 Function 入口 |
| 任意第三方扩展（含同名 permission 声明） | 不在 allowlist → API 不存在 / `lastError` |
| DevTools 前端 / `--remote-debugging-port` 客户端 | 不是扩展调用；只能走 CDP，拿不到「用户」身份 |
| 本机任意进程（TCP 客户端） | 只能经 host → SW 的命令通道；`_clientId` 由 host 分配，不能成为用户身份 |
| 扩展 popup / options | **不是** API 调用方；它们是 SW 内部入口，用 `markInternalCommand()` 产生用户意图 |

### 2.6 与扩展侧身份的关系

两层信任链（设计 §13.11）：

```
人类点击（popup/遮罩）
  → SW 进程内 markInternalCommand()（不可由消息字段伪造）
  → grant_input / input_status / human_presence
  →（只有 grant/scope 同步才调用）chrome.browserCli.inputOwnership
  → IsTrustedBrowserCliExtension()（ID 哈希 + context + location + managed）
  → content::SetInputOwnership / GrantDebuggerInput
  → RenderWidgetHostImpl 仲裁
```

内核不需要、也不能信任「扩展说自己是用户」的消息字段；扩展也不需要信任内核返回的 mode
作为所有权（只用于版本对齐）。

---

## 3. 版本与心跳

### 3.1 每目标单调 version

- 目标键：`win:<windowId>` / `tab:<tabId>`，版本空间互相独立。
- `version` 由扩展生成并持久化在 `GlobalState.kernelInputOwnership.targets[key]`
  （`{version, mode, lastAckAt, lastAttemptAt}`，**不是**所有权真源，只是同步账本）。
- 推进规则：
  - 首次同步：`1`；
  - 派生模式变化：`+1`；
  - SW 重启且模式未变：**重放同一 version**（幂等），不 +1；
  - 内核拒绝旧版本：采纳内核更高 version 后 `+1` 重试，最多一次。
- 扩展绝不发送比账本更小的 version；内核绝不接受更小的 version。

### 3.2 10s 心跳 / 30s 降级

| 时间 | 扩展侧 | 内核侧 |
|---|---|---|
| 0s | `setOwnership(version=1)` | 接受，`last_update=now` |
| 每 10s | `heartbeat(version)`（模式没变） | 刷新 `last_update`；window 目标重新展开 tabs |
| 30s 无更新 | `degraded = true`（仅在该目标最后一次同步失败时）；AI 输入 `INPUT_KERNEL_SYNC_LOST` | `stale = true`，effective mode = ASSIST，清空 grants |
| 恢复 | 下一条命令/心跳先 `setOwnership` 或 `heartbeat` | `last_update` 刷新，effective mode 回到 configured mode（grant 需要重新发） |

实现细节：

- MV3 `chrome.alarms` 的最小周期是 30s，因此 10s 心跳用 `setInterval`；
  `index.ts` 已有的 30s alarm 额外调用 `heartbeatKernelInputOwnership("alarm")` 兜底。
- SW 被回收时定时器消失；**内核按 30s 失联降级**（安全方向）。下一次命令唤醒 SW 后，
  `withKernelInputScope` 会先 `ensureFreshRecord()` 重新同步，成功才允许执行。
- 扩展侧 **不**把 degraded 写成 `assist` 租约：`kernelInputOwnershipStatusForWindow()` 返回
  `effectiveMode: "assist"`，输入守卫 fail closed；恢复后自动回到原模式，避免 SW 正常休眠
  把 AI 空间永久变成 ASSIST。

### 3.3 内核必须采用的状态模型（对 J 的明确要求）

```cpp
struct InputOwnershipState {
  InputOwnershipMode configured_mode = InputOwnershipMode::kAssist; // 扩展写的
  uint64_t version = 0;
  base::TimeTicks last_update;          // setOwnership 接受 / heartbeat 成功时刷新
  bool stale = false;                   // now - last_update > 30s

  InputOwnershipMode EffectiveMode(now) const {
    return stale ? InputOwnershipMode::kAssist : configured_mode;
  }
};
```

- **stale 是标志，不覆写 configured_mode**。否则心跳恢复后无法回到 AI，只能靠扩展重新
  `setOwnership`；这会引入不必要的版本 churn。
- grant 只在 `EffectiveMode() == kAssist` 时被消耗；`stale` 变 true 时清空所有 grant。
- 当前 patch 028 的 `InputOwnershipDecider` 只有 `mode_`/`version_`，需要新增
  `last_update_`、`stale_`、`Refresh()`；`SetInputOwnership` 需要允许「同 version 同 mode
  幂等 + 刷新 last_update」。
- `snapshot()` 增加 `stale` 与 `last_update`（`InputOwnershipSnapshot` 结构体扩展；
  J 文档 §4 已把“无 stale 字段”列为差异）。

### 3.4 SW 重启恢复

`initKernelInputOwnership()`（SW 每次启动）：

1. 重新探测 `globalThis.chrome.browserCli?.inputOwnership`（不缓存跨会话结果）；
2. 读取 `storage.session` 里的 `spaces` + `kernelInputOwnership` 账本；
3. 对每个活动 space：派生模式，按账本 version 重放 `setOwnership`（同 version 幂等）；
4. 重新注册 `onHumanPresence` 监听器；
5. 启动 10s 心跳；`index.ts` 的 30s alarm 继续兜底。

浏览器重启（内核 version 归零）：扩展账本 version 仍为 N，`setOwnership(N, mode)` 被接受
（N > 0），无需重置；若内核返回 `STALE_VERSION` 则采纳内核值再 +1。

### 3.5 版本冲突处理（客户端已实现）

| 场景 | 内核返回 | 扩展动作 |
|---|---|---|
| 账本 version 落后（内核有更高值） | `accepted:false, reason:"STALE_VERSION", version:K, mode:M` | `record.version = K`，`record.mode = M`；若派生模式不同则用 `K+1` 重试**一次** |
| 同 version 不同 mode | `accepted:false, reason:"VERSION_CONFLICT"` | 同上（采纳 + `+1` 一次） |
| 重试仍被拒 | — | 记录 `lastError`，不发第二次；30s 后按目标 degraded |
| heartbeat `VERSION_UNKNOWN` | `ok:false, version:K` | 采纳 K，下一次同步走 `setOwnership(K+1)` |
| `UNKNOWN_TARGET` | `ok:false` | 删除内存 + 持久账本；窗口关闭时不再重试 |

审计事件：`input_ownership_version_conflict`、`input_ownership_mode_mismatch`、
`input_ownership_sync_failed`、`input_ownership_sync_lost`。

---

## 4. session 绑定

### 4.1 映射链（受信扩展的 `chrome.debugger` → 内核 `DevToolsSession*`）

```
chrome.debugger.attach({tabId}, "1.3")           // 扩展发起
  → extensions::ExtensionDevToolsClientHost       // 归属 extension_id + debuggee(tab)
  → DevToolsAgentHost*                            // 该 tab 的 agent host
  → DevToolsSession*                              // 实际注入会话
```

`grantInput` / `beginInputCommand` 在 chrome 层执行：

1. 用 `IsTrustedBrowserCliExtension()` 已确认的 `extension()->id()`；
2. 在 `ExtensionDevToolsClientHost` 注册表里查该扩展 + 目标 tab 的会话；
3. 得到 `DevToolsAgentHost*` / `DevToolsSession*`，生成 opaque `session_token`
   （建议 `base::Token`/随机 128bit + 单调 generation）；
4. grant 记录 key = `{WebContents*, DevToolsSession*}`（或 `{web_contents_id, session_token}`）。

扩展**不需要**理解 token：缺省时内核按「调用方扩展 + tab」解析；token 只在诊断/审计
（`sessionToken` 返回值）与显式 `session` 匹配时使用。

### 4.2 grant 只作用于该 session + 目标 WebContents

- 内核在 `Decide()` / `ShouldDeliverDebuggerEvent()` 里必须知道事件的**来源 session**。
  `Forward*` 本身不带 session，因此 J 的修订需要：
  - `InputInjector` / `InputHandler` 在把事件交给 `RenderWidgetHostImpl` 前，把来源 session
    写入 controller 的「当前注入上下文」（同一调用栈的作用域 token），由 `Forward*` 的检查消费并
    清除；或
  - 在 controller 中维护 `pending_injection = {session, event_seq}`，`InputInjector` 逐事件推进。
  - **无法归因 → fail closed（丢弃）**，不允许「无法判断就放行」。
- `Input.insertText` 路径在 `InputHandler::InsertText` 内直接有 host/session，最容易做精确绑定。
- 第三方 CDP 会话（`--remote-debugging-port`、DevTools 前端、其它调试器）：
  - 可以 attach、可以注入，事件同样带 `kFromDebugger`；
  - 但它们没有 grant 桶（`grantInput` 只接受 allowlist 扩展的调用）；
  - HUMAN 下照常丢弃；ASSIST 下没有 grant → 丢弃；
  - **不能复用**扩展的 grant：key 不匹配。这是与 J 当前「单一全局 grant 桶」的关键差异
    （当前实现下第三方可以消耗扩展预算；见 §10 风险）。

### 4.3 detach / 导航 / 窗口关闭

| 事件 | 内核动作 | 扩展动作 |
|---|---|---|
| 扩展 `chrome.debugger.detach` / tab 关闭 | 删除该 session 的所有 grant/scope | 无需处理；下一次 ASSIST 命令重新 attach + grant |
| tab 导航（同 WebContents） | grant 保留到 TTL（同一 session）；mode 不变 | 无需处理（`navVersion` 由既有逻辑维护） |
| tab 跨窗口移动 | 重新绑定 window 快照/精确覆盖；版本不变 | 下一次 heartbeat 重新展开 |
| WebContents 销毁 | controller 随之销毁 | 账本保留；`UNKNOWN_TARGET` 时删除 |
| SW 重启（扩展侧） | 内核仍认为旧 session 有效直到 detach/TTL | 重新探测 + 重放；ASSIST 命令重新 attach |

### 4.4 为什么不在协议里传 `DevToolsSession*` 指针

- 指针是进程内地址，不能跨扩展/内核边界，也不稳定；
- 用 `extension_id + tabId` 由内核解析，调用方无法伪造归属；
- 显式 `session` 参数只是诊断用的 opaque token，不构成授权依据。

---

## 5. 命令 ↔ 手势语义

### 5.1 两层预算

| 层 | 单位 | 权威性 | 实现 |
|---|---|---|---|
| 扩展层 grant（`assist.grant.actions`） | **每条输入命令 1 次** | 权威预算；用户发放；Agent 不能自证 | `input-ownership.ts::consumeAssistGrant`（已落地） |
| 内核层 grant | ASSIST 下：一条命令 1 次（command scope）；无 scope 时按手势 | 第二道防线；只保证「没授权绝不投递」 | J 的 controller + 本文 §1.4/§1.5 |

命令 scope 打开时，内核把该 session 的所有注入事件视为同一个授权单位，**不再逐手势扣减**；
scope 关闭/到期后回到手势计数。这样：

- `dblclick`（2 次 press/release）在扩展层是 1 次，内核也是 1 次；
- `type`（N 次 `Input.insertText`）在扩展层是 1 次，内核也是 1 次（不受 300ms 滑动窗口影响）；
- `wheel` 多 tick / `hover` 多次 move 同理。

### 5.2 语义表

| 命令 | 实际 CDP / 实现 | 扩展 grant 单位 | 内核无 scope 时的手势单位 | 内核有 scope 时 | 备注 |
|---|---|---|---|---|---|
| `click` | `mousePressed` + `mouseReleased` | 1 | 1（press 扣，release 免费） | 1 | 30ms 间隔 |
| `dblclick` | 2 × (`mousePressed`+`mouseReleased`) | 1 | **2**（两个 press） | **1** | 采用 begin/end 的主要理由 |
| `hover` | `mouseMoved`（无按键） | 1 | 1（每次 move） | 1 | 光标动画产生的多次 move 在 scope 内合并 |
| `drag` | press + move + release | 1 | 1（press 开手势） | 1 | 手势绝对截止兜底 |
| `wheel` | 1 × `mouseWheel` | 1 | 1（每个 tick） | 1 | `actions.wheel` 只发一次；多 tick 应合并为一次 `deltaY` |
| `down` | `mousePressed`（无 release） | 1 | 1（press 扣） | 1 | 手势在 1s 绝对截止后强制关闭（J 必须补） |
| `up` | `mouseReleased`（无 press） | 1 | 无匹配 press → 丢弃 | 1 | scope 让「只有 up」也能作为一次命令 |
| `press` | `keyDown` + `keyUp` | 1 | 1（RawKeyDown 扣，char/up 免费） | 1 | `text` 一并发送 |
| `type` | N × `Input.insertText`（默认 8ms/字） | 1 | 每 300ms 滑动窗口 1 次；慢速输入会 >1 | 1 | 采用 `insertText`，见 §5.3 |
| `fill` | 聚焦/全选 + 1 × `Input.insertText` | 1 | 1 | 1 | |
| `selectOption` | `Runtime.evaluate` 直接改 `value` + `change` | 1 | **0**（不产生输入事件） | 1（scope 预占） | 见 §7.1 |
| `check` / `uncheck` / `setChecked` | `Runtime.evaluate` 改 `checked` + `change` | 1 | **0** | 1 | 同上 |
| `js` | `Runtime.evaluate` | 1 | **0**（除非脚本自己 `Input.dispatch*`） | 1 | 见 §7.1 |
| `tab_cdp_call` | 任意 CDP 透传 | 1 | 取决于 method：`Input.*` 按上表；`Runtime.evaluate` 为 0 | 1 | 扩展层统一守卫 |
| `snapshot` / `readText` / `screenshot` / `cursor` / `download_*` | 只读/下载 | 不守卫 | — | — | 不在 `INPUT_COMMANDS` |

### 5.3 `type` 用 `insertText` 还是逐键

**选择 `Input.insertText`**（现状）：

- 一次 IME commit，不依赖键盘布局/修饰键；
- 对表单与 `contenteditable` 都直接改值，和 `fill` 的语义一致；
- 内核侧只需在 `InputHandler::InsertText` 一处做 grant 检查，路径最短；
- 代价：页面只监听 `keydown`/`keypress` 的富文本编辑器（Slate/CodeMirror 某些模式）可能收不到
  逐键事件。这是既有行为，不在本 API 改变；需要逐键时用 `press` 或 `tab_cdp_call`
  （`Input.dispatchKeyEvent`）。

### 5.4 `wheel` 多 tick 合并

- `actions.wheel` 当前只发一个 `mouseWheel`（`deltaX`/`deltaY`），因此天然 1 单位。
- 如果未来需要多 tick：**命令内合并为一个 `mouseWheel`**（累加 delta），或在同一个 command scope
  内发多个事件（scope 内只扣 1）；不允许在 scope 外循环发多个 tick 来“省” grant。
- 内核侧：scope 内所有 `kMouseWheel` 共用 1 单位；scope 外每个 tick 1 单位。

### 5.5 绝对截止与异常清理

| 对象 | 截止 | 到期行为 |
|---|---|---|
| grant | `expiresAt = now + ttlMs`（≤600s） | 删除；后续 ASSIST 输入丢弃/`GRANT_REQUIRED` |
| command scope（鼠标类：click/dblclick/hover/drag/down/up/wheel/press） | `min(now + 10s, grant.expiresAt)` | 自动关闭；预占单位保持消耗；后续输入按普通规则 |
| command scope（文本类：`type` / `fill`） | `min(now + 60s, grant.expiresAt)` | 同上（逐字输入可能很久） |
| command scope（`js` / `tab_cdp_call`） | `min(now + 120s, grant.expiresAt)` | 同上（可能等待网络/长任务） |
| 鼠标手势（无 scope） | press 后 1s（J 必须补；当前实现无上限） | 强制关闭；后续 move/up 需新 grant |
| 键盘手势（无 scope） | RawKeyDown 后 2s | 强制关闭；后续 char/up 按新 grant 处理 |
| 文本窗口（无 scope） | 每次 insertText 后 300ms 滑动，最多 2s | 之后需要新 grant |

异常清理：

1. `withKernelInputScope()` 用 `try/finally` 保证 handler 抛错时仍调用
   `endInputCommand({outcome:"failed"})`；
2. `end` 本身失败只写审计 `input_kernel_scope_end_failed`，不改变命令结果；
3. scope 丢失（SW 重启/内核重启）由 `deadline` 兜底，不需要补偿事务；
4. `begin` 成功但 handler 未执行（例如 attach 后立即失败）：`grantInput` 的一次性 grant 在
   `expiresAt` 后自然消失，且只属于该 session，第三方无法使用。

---

## 6. 失败模式与回滚

### 6.1 失败模式矩阵

| 失败 | 检测 | 扩展行为 | 内核行为 | 用户可见结果 |
|---|---|---|---|---|
| 普通 Chrome / API 缺失 | `getInputOwnershipApi()` 返回 undefined | 零调用、零定时器；`kernel.state="unsupported"` | 无 API | 与今天一致（仅命令层守卫） |
| Browser CLI 但 feature 关闭 | API 命名空间不存在 | 同上（reason `api-absent`） | `Decide()` 恒放行 | 与今天逐字节一致 |
| generic 但全局残留 API | `hostCapabilities.mode === "generic"` | 不调用（reason `generic-host`） | 不应存在 | 零行为变化 |
| 调用抛错（瞬时） | Promise reject | 记录 `lastError`；本次不降级；30s 后 degraded | 状态不变 | 本次命令可能在 AI 下被内核丢弃（安全） |
| 调用挂死 | 2s 硬超时（`KERNEL_API_TIMEOUT_MS`） | 按失败处理；不阻塞 SW 初始化/命令 | 状态不变（迟到结果被忽略） | 同“调用抛错” |
| 30s 无确认 | 心跳 + 账本时间 | `degraded=true`，AI 命令 `INPUT_KERNEL_SYNC_LOST` | effective ASSIST + 清 grant | AI 明确失败，不静默；人类可用 |
| version 乱序 | 内核返回 `STALE_VERSION` | 采纳内核 version，`+1` 重试一次 | 保持当前 mode | 一次额外调用 |
| 同 version 不同 mode | `VERSION_CONFLICT` | 同上 | 拒绝 | 一次额外调用 |
| 心跳丢失（SW 休眠） | 定时器消失 | 不主动标记；下一次命令先同步 | 30s 后 ASSIST | 命令前多一次同步 |
| session detach | `grantInput` → `NO_DEBUGGER_SESSION` | 重新 attach 后重试一次（本次命令） | 删除该 session grant | ASSIST 下命令失败/重试 |
| SW 重启 | 新 SW 启动 | 重新探测 + 重放 setOwnership + 心跳 | 旧快照 30s 后 stale | 最多一个同步周期 |
| 扩展更新（同 key） | 新 SW 启动 | 同上 | extension id 不变，仍受信 | 无感 |
| 扩展 key 轮换 | 内核 allowlist 不匹配 | API 不存在/`PERMISSION_DENIED` | 不写入 | 必须随内核发版更新 allowlist |
| 窗口/标签关闭 | `UNKNOWN_TARGET` | 删除账本，不重试 | controller 随 WebContents 销毁 | 无 |
| 浏览器重启 | 内核 version 归零 | 账本 version N 重放 | 接受更高 version | 无 |
| 半实现 API（缺 grant/begin/end） | 方法缺失 | ASSIST `INPUT_OWNERSHIP_API_INCOMPLETE`；AI 正常 | — | 明确失败，不放行 |
| begin 被拒 | `{ok:false}` | 拒绝命令（handler 不执行） | 不投递 | 明确失败 |

### 6.2 Feature 默认关闭时的零行为变化

三层证据（与 J 的 §5 对应）：

1. **API 层**：feature 关闭时 `browserCli.inputOwnership` 不注册；扩展探测为 unsupported，
   全程零调用。
2. **内核层**：`kInputOwnershipEnforcement` 关闭时 `ShouldDropAutomationInput()` 第一行返回
   false；不查 delegate/controller；`GetInputOwnershipController()` 返回 nullptr（不创建
   WebContentsUserData）；决策器不读不写状态。
3. **扩展层**：`getInputOwnershipApi()` 返回 undefined 时 `withKernelInputScope` 直接
   `run()`；`initKernelInputOwnership` 不启动定时器；`input_status.kernel.state = "unsupported"`，
   但既有字段完全不变。

### 6.3 回滚

| 层级 | 回滚方式 | 影响 |
|---|---|---|
| 内核 | 整组 revert K1-K9 + K10-K13（patch 028 及其扩展 API 层），或仅关闭 feature | 扩展自动降级为 generic/unsupported；命令层守卫保留 |
| 扩展 | 删除/停用 `input-ownership-api.ts` 的调用（或 `hostCapabilities` 降级） | 内核仍按最后快照/30s stale 工作；不会放开人类输入 |
| 数据面 | `GlobalState.kernelInputOwnership` 是可选字段，旧版本忽略 | 无需迁移 `storage.session` |
| 运维 | 扩展 ID 轮换 = 信任主体更换，必须同步内核 allowlist；回滚时保留旧 ID 哈希一个版本 | 见 §2.2 |

灰度顺序（每一档可独立回滚）：

1. 只开 `onHumanPresence`（只读，不影响投递）；
2. 只开 HUMAN 丢弃；
3. 开 ASSIST grant + command scope；
4. 全量 `setOwnership` 心跳。

---

## 7. 边界声明

### 7.1 `Runtime.evaluate` 直接改 DOM 不参与输入事件仲裁

以下命令通过 `Runtime.evaluate` 修改 DOM / 属性，**不产生 `Input.*` 事件**，因此内核的
`Forward*` / `InsertText` 仲裁看不到它们：

- `selectOption`（`el.value = v; dispatchEvent(change)`）；
- `check` / `uncheck` / `setChecked`（`el.checked = b; dispatchEvent(change)`）；
- `js`（任意表达式，包括 `el.click()`、`dispatchEvent`、直接改 `innerHTML`）；
- `fill` 的“聚焦 + 全选”前置步骤（真正的值写入仍是 `Input.insertText`，受仲裁）；
- `tab_cdp_call` 的 `Runtime.evaluate` / `Runtime.callFunctionOn`。

信任边界：

- **BrowserPilot 命令层仍然保留所有权校验**：这些命令都在 `INPUT_COMMANDS` 里，
  HUMAN → `INPUT_HUMAN_OWNED`，ASSIST 无 grant → `INPUT_ASSIST_REQUIRES_GRANT`（P3 已落地）。
- 第三方 CDP 可以直接 `Runtime.evaluate` 改 DOM，内核无法阻止；这是“页面内脚本执行”与
  “输入事件”的边界，不是本 API 能解决的。第三方 CDP 仍然拿不到“用户”身份，也拿不到 grant。
- 因此 `selectOption` / `check` 等在 kernel 侧没有 grant 消耗；command scope 预占的 1 单位
  是扩展层“一条命令一次”的镜像，不会因为“没有事件”而放行别的输入。

### 7.2 第三方 CDP 的信任边界

| 能力 | 第三方 CDP | 受信扩展 |
|---|---|---|
| attach / 注入 `Input.*` | 是 | 是 |
| 事件带 `kFromDebugger` | 是 | 是 |
| HUMAN 下被丢弃 | 是 | 是（扩展层先拒绝，内核再挡） |
| ASSIST 下无 grant 被丢弃 | 是 | 是 |
| 获取 grant | **否** | 是（仅用户入口 + `grantInput`） |
| 复用他人 grant | 否（session key 不匹配） | 否（只用自己的 session） |
| 读取 `onHumanPresence` | 否（只投递受信扩展） | 是 |
| 写 `setOwnership` | 否（API 不存在/不可达） | 是 |

已知限制：J 当前 patch 的 grant 是单个全局桶，第三方 CDP 可以**消耗**扩展预算（不能增加）。
本设计要求改为 session 绑定；在 J 完成前，扩展层必须继续把命令层守卫当作权威，不依赖内核
作为唯一防线。

### 7.3 浏览器 UI 输入

Ctrl+L / Ctrl+T / Ctrl+W / F5 等在 `RenderWidgetHostImpl::ForwardKeyboardEventWithCommands`
的 `PreHandleKeyboardEvent` 之前被浏览器处理，不进页面，也不产生 `human_presence`；
本 API 不纳入页面输入权（设计 §11 决定 6）。

### 7.4 触摸 / 手势 / IME

- `Input.dispatchTouchEvent` / `ForwardGestureEvent` P3 不纳入（J §13.10）；
  通过 `tab_cdp_call` 调用时可能绕过仲裁。**风险**：ASSIST/HUMAN 下 `tab_cdp_call` 仍被扩展层
  拒绝（`INPUT_COMMANDS` 包含它），所以只对“已获 grant 的 ASSIST 命令”开放；AI 模式下无影响。
- 其它 IME 入口（`ImeSetComposition` 等）不覆盖；`Input.insertText` 已覆盖。

---

## 8. 扩展侧实现（本轮已落地）

### 8.1 文件

| 文件 | 变更 |
|---|---|
| `src/background/input-ownership-api.ts`（新） | 探测、账本、setOwnership/heartbeat、degraded、命令 scope、presence 事件桥、测试钩子 |
| `src/background/state.ts` | 新增可选 `kernelInputOwnership?: {targets: Record<key,{version,mode,lastAckAt,lastAttemptAt}>}`；**ownership 取值集合不变** |
| `src/background/input-ownership.ts` | `InputGuardResult.windowId`；新增 `onInputModeChanged()`（enter/exit assist 的唯一通知点）；新增两个错误码 |
| `src/background/commands.ts` | `dispatch` 在守卫后用 `withKernelInputScope` 包裹 handler；`input_status` 增加 `kernel` 视图 |
| `src/background/index.ts` | SW 启动 `initKernelInputOwnership()`；30s alarm 兜底 `heartbeatKernelInputOwnership("alarm")` |
| `scripts/test-input-ownership-api.mjs`（新） | 12 组离线单测（见 §8.4） |
| `scripts/test-core.mjs` / `package.json` | 接入 `test-core` 与 `npm run test:input-ownership-api` |
| `scripts/test-input-ownership.mjs` | 更新 dispatch 源码守卫（守卫 + scope 的新形状） |

**未修改**（按边界要求）：`cdp.ts`、`screenshot-policy.ts`、`virtual-cursor.ts`、`mask.ts`、
`actions.ts`。

### 8.2 客户端状态机

```
                ┌──────────── unsupported (generic / API absent / feature off)
                │                 │ 零调用、零定时器、withKernelInputScope 直接 run()
                │                 ▼
 probe ─────────┤              command layer guard only
                │
                └── ready ── init: 重放 setOwnership（账本 version）── 10s heartbeat
                                 │
                                 ├─ 成功：lastAckAt=now, degraded=false
                                 └─ 失败：lastError；>30s 且仍失败 → degraded
                                             │
                                             └─ withKernelInputScope: AI → 拒绝；ASSIST → 拒绝
                                                 恢复：下次 sync 成功 → degraded=false
```

### 8.3 关键决策

1. **窗口目标是所有权同步的单位**：space = 窗口；`setOwnership({target:{windowId}})`；
   `grantInput`/`begin`/`end` 用 `{tabId}`，因为它们必须绑定 session。
2. **每命令一次 kernel grant**：不在 `grant_input` 发放时镜像整段预算，而是在命令开始时
   `grantInput({actions:1})`。理由：避免第三方消耗大预算、避免预算漂移、TTL 更短。
3. **ASSIST 前先 attach**：`withKernelInputScope` 接收 `attach` 钩子（`commands.ts` 传入既有
   `ensureAttach`），保证 `grantInput` 能解析到 session。
4. **不写 `assist` 租约**：degraded 只是同步视图 + 拒绝输入；恢复后自动回到原模式。
5. **不新增命令**：`input_status` 增加 `kernel` 字段即可；Agent 的调用方式不变。
6. **账本只存 version/mode/时间**：模式永远从 `SpaceState` 派生，不存在第二套 ownership。
7. **所有内核调用带 2s 硬超时**（`KERNEL_API_TIMEOUT_MS`）：宿主挂死按失败处理，
   绝不阻塞 SW 初始化/命令；迟到结果被 `Promise.race` 丢弃。

### 8.4 单测覆盖（原始输出见 §11）

| # | 用例 | 断言 |
|---|---|---|
| 1 | API 探测 | 缺失/半实现 → undefined；完整 → API |
| 2 | generic host | 即使全局有 API 也零调用；命令原样执行 |
| 3 | enhanced + API 缺失 | unsupported(`api-absent`)；命令原样执行 |
| 4 | 三模式同步 | ai/human/assist 各 version=1；同模式只 heartbeat；模式变化 +1 |
| 5 | 版本乱序 | 6 被拒（内核 9）→ 重试 10；账本 10；只重试一次 |
| 6 | 30s 失联 | 30s 后 degraded；AI 命令 `INPUT_KERNEL_SYNC_LOST`；恢复后放行 |
| 7 | 内核调用挂死 | 20ms 测试超时下 init 不阻塞；`lastError` 记录 timeout |
| 8 | 10s 心跳 | 20ms 测试周期内 ≥2 次 heartbeat |
| 9 | SW 重启 | 重新 setOwnership，同 version 幂等；继续心跳 |
| 10 | ASSIST scope | attach → 1 grant → begin → handler → end(ok)；异常 end(failed) |
| 11 | 失败关闭 | begin 拒绝 → handler 不执行；半实现 API → `INPUT_OWNERSHIP_API_INCOMPLETE` |
| 12 | presence 桥 | 40ms 去抖后进入 ASSIST（reason=`kernel:mouse`）；未知 tab 忽略并审计 |
| 13 | 源码守卫 | 不写 ownership、不依赖 cdp/mask/actions；命令层/启动/心跳接线存在 |

---

## 9. 与 J 的内核接口对齐（待实现清单）

> 本轮不改 `D:\c\src`、不构建 Chromium。以下每一项都需要 J 的 patch 028 修订或后续编号 patch。

### 9.1 现有接口（J 已提供，可直接复用）

```cpp
// content/public/browser/input_ownership.h
enum class InputOwnershipMode { kAi, kAssist, kHuman };
struct InputOwnershipSnapshot { InputOwnershipMode mode; uint64_t version; };
class InputOwnershipDecider {
  bool ShouldDeliverDebuggerEvent(const blink::WebInputEvent&, base::TimeTicks now);
  bool ShouldDeliverDebuggerTextInsert(base::TimeTicks now);
  InputOwnershipSnapshot snapshot() const;
};
// controller: ShouldDropAutomationEvent / ShouldDropAutomationTextInsert / snapshot()
```

### 9.2 需要新增/修改的接口（建议）

| # | 层 | 接口 | 说明 |
|---|---|---|---|
| K10 | content | `InputOwnershipSnapshot` 增加 `bool stale`、`base::TimeTicks last_update`；`InputOwnershipDecider` 增加 `last_update_`、`stale_`、`Refresh(now)`；`ShouldDeliver*` 用 `EffectiveMode(now)` | §3.3：stale 不覆写 configured mode |
| K11 | content | `void SetInputOwnership(WebContents*, InputOwnershipMode, uint64_t version)` 允许同 version 同 mode 幂等 + 刷新 last_update；同 version 不同 mode 返回冲突；低 version 拒绝 | §1.2 / §3.1 |
| K12 | content | `GrantDebuggerInput(WebContents*, DevToolsSession*, actions, ttl)`；`ConsumeDebuggerGrant(DevToolsSession*, EventKind, now)`；`BeginInputCommand(WebContents*, DevToolsSession*, command_id, kind, now)` / `EndInputCommand(...)`；grant/scope key 带 session | §1.3-1.5 / §4 |
| K13 | content | `SetHumanPresenceCallback(base::RepeatingCallback<void(WebContents*, EventKind, base::TimeTicks)>)`；仅受信 chrome 层注册 | §1.8 |
| K14 | chrome | `browser_cli_input_ownership_api.{h,cc}` + `browser_cli_extension_identity.{h,cc}` + `browser_cli.json` + `_api_features.json` | §1 / §2 |
| K15 | chrome | window → tabs 绑定（`TabStripModelObserver`）：window 快照在 tab 创建/移动时立即应用；heartbeat 重新展开 | §3.2 / §4.3 |
| K16 | chrome | `ExtensionDevToolsClientHost` 解析（extension id + tab → session）；`grantInput`/`begin` 的 session 校验 | §4 |
| K17 | content | `InputInjector` / `InputHandler` 把来源 session 传给 controller（同一调用栈 token）；无法归因 → 丢弃 | §4.2 |
| K18 | content | 手势绝对截止：鼠标 press 后 1s、键盘 RawKeyDown 后 2s、文本窗口最多 2s | §5.5（当前 patch 无上限） |

### 9.3 与 J 当前实现的差异（必须解决）

| 项 | J 当前（`docs/windows-input-arbitration-kernel-2026-10-29.md` §4） | 本设计 |
|---|---|---|
| 30s stale | 未实现；`setOwnership(kAi)` 后失联会一直保持 AI | `last_update` + `stale` + effective ASSIST + 清 grant |
| grant 桶 | 单个全局桶 | 按 `{WebContents*, DevToolsSession*}` 分桶 |
| 生产写入口 | 只有 `*ForTesting` | 受信 chrome 扩展 API（K14） |
| `human_presence` | 只计数 | 回调 chrome 层 → 受信扩展事件 |
| 命令 scope | 无 | begin/end + 绝对 deadline |
| 手势上限 | 无（down 不 up 会永久开手势） | 1s/2s 绝对截止 |

### 9.4 接好后的真实 E2E（本轮无法跑，不得伪造 PASS）

1. 启动 Browser CLI（`--enable-features=InputOwnershipEnforcement` + managed mode），安装扩展；
2. `input_status` 应返回 `mode:"ai"` 且 `kernel.state:"ready"`、`kernel.version>=1`；
3. AI `click` 生效（DOM 计数 +1）；
4. `handoff_space` → `input_status.mode="human"`；AI `click` → `INPUT_HUMAN_OWNED`；
   第三方 CDP `Input.dispatchMouseEvent` → 页面计数不变；
5. `human_presence` → 500ms 后 ASSIST；无 grant `click` → `INPUT_ASSIST_REQUIRES_GRANT`；
   用户 `grant_input {actions:1}` → 一次 click 生效、第二次失败；
6. 关闭扩展 SW（或停发心跳）30s：内核 ASSIST；AI `click` 被内核丢弃（DOM 不变）；
7. 重启 SW：`kernel.version` 单调、`input_status.kernel.degraded=false`、AI 恢复；
8. Feature 关闭：上述 3-7 行为恢复今天语义（AI 全放行、无 `kernel` 事件）。

---

## 10. 新风险 / 未覆盖项

1. **J 的 session 绑定尚未实现**：当前 patch 的 grant 是全局桶，第三方 CDP 可以消耗扩展预算。
   在 K12/K16/K17 完成前，扩展层不得把内核当作唯一防线。
2. **来源 session 归因**：`Forward*` 不带 session；K17 的「同一调用栈 token」方案需要在 J 的实现里
   验证 OOPIF / 多会话并发 / 同 tab 两个调试器同时注入时不串味。无法归因必须 fail closed。
3. **window 目标与 tab 生命周期**：新 tab 必须由 K15 立即继承窗口快照；否则在下一个 10s 心跳前
   新 tab 处于 ASSIST（安全但 AI 命令会静默无效）。
4. **`selectOption` / `check` / `js` 走 DOM**：不参与内核仲裁（§7.1），第三方 CDP 可绕过；
   这是能力边界，不是本 API 的缺陷。
5. **`tab_cdp_call` 的触摸/手势**：`Input.dispatchTouchEvent` 未接线（J §13.10）；ASSIST 下
   扩展层会拒绝整条命令，但 AI 模式下仍可注入，不受仲裁。
6. **扩展 ID 轮换**：更换 `manifest.key` 等于更换受信主体；必须同步内核 allowlist 发版。
   本轮不处理密钥轮换。
7. **10s 心跳与 MV3 生命周期**：`setInterval` 在 SW 回收后消失；30s alarm 是兜底，但浏览器可能
   进一步节流后台 SW。内核的 30s stale 是最终保障；扩展侧 degraded 只在“最后一次同步确实失败”
   时置位，避免误判。
8. **账本写放大**：每次成功同步都写一次 `storage.session`。目标数（窗口）通常 ≤8，10s 一次，
   可接受；若未来大量窗口，可把 `lastAckAt` 持久化降频（version/mode 仍需每次写）。
9. **`input_status` 新增 `kernel` 字段**：对外协议是增量字段，旧客户端忽略即可；但 CLI/Skill 文档
   需要同步说明（本轮未改 `export_guide` 的字段表，属后续文档工作）。
10. **真实 E2E 未跑**：本轮不构建 Chromium、不改 `D:\c\src`；§9.4 的 8 步必须在 K10-K18 落地后
    由内核/集成 CI 执行，结果贴原始输出。

---

## 11. 复现命令与原始结果（扩展侧）

```bash
cd D:/work/wt/bp-p3-api
npm run typecheck                 # EXIT=0
npm run build                     # dist/ 生成，EXIT=0
npm run test:core                 # EXIT=0，含 test-input-ownership + test-input-ownership-api
npm run test:input-ownership      # EXIT=0
npm run test:input-ownership-api  # EXIT=0
```

`npm run test:input-ownership-api` 原始输出（2026-10-29，Node v24.15.0，Windows）：

```
PASS input-ownership-api: API presence is the only signal (partial APIs are unsupported)
PASS input-ownership-api: generic host is a strict no-op (no calls, no timers)
PASS input-ownership-api: enhanced host without the API falls back to the command-layer guard
PASS input-ownership-api: derived modes sync with monotonic versions; same mode only heartbeats
PASS input-ownership-api: out-of-order versions are adopted and retried exactly once
PASS input-ownership-api: 30s sync loss degrades to ASSIST semantics and recovers explicitly
PASS input-ownership-api: a hung kernel call times out and never blocks SW startup
PASS input-ownership-api: periodic heartbeat runs on the configured interval
PASS input-ownership-api: SW restart re-probes, replays setOwnership idempotently, resumes heartbeat
PASS input-ownership-api: one ASSIST command maps to exactly one kernel grant and begin/end scope
PASS input-ownership-api: ASSIST fails closed on begin/grant failure and on incomplete APIs
PASS input-ownership-api: kernel human_presence enters ASSIST through the internal bridge only
PASS input-ownership-api: source guards keep one ownership source and the kernel bridge isolated
```

> 说明：以上全部是离线 mock（`chrome.browserCli` / `chrome.storage.session` / `chrome.tabs`），
> **没有**启动浏览器、**没有**读取真实 profile/钥匙串。真实内核 E2E 见 §9.4，待 K10-K18 落地。
