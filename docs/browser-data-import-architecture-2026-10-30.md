---
type: ArchitectureDesign
status: draft
generated: { by: zcode, at: 2026-10-30T00:00:00+08:00 }
stale_after: 2027-01-30
---

# Browser CLI 数据导入架构：会话共享、隔离与一次性迁移

日期：2026-10-30
关联研究：`docs/browser-data-import-research-2026-10-30.md`
实现 worktree：`D:\work\wt\bp-import`（分支 `agent/p1-browser-data-import`）
状态：MVP 已实现并测试；Cookie 端到端桥接仅协议级验证，浏览器内未实测。

---

## 1. 范围与不变量

本架构只解决“用户明确触发的一次性数据迁移”，不改变 Browser CLI 的窗口/焦点/呈现策略。

强制不变量：

1. **来源 Profile 只读**。不写、不删、不重命名来源浏览器的任何文件；不结束、不重启来源浏览器。
2. **目标 Profile 单写者**。两个独立 Chromium 进程不得并发直接读写同一 Profile 数据库；导入工具在目标
   浏览器未运行时才写目标文件（默认只写全新/空 Profile）。
3. **不解密、不提取密钥**。Chrome 已由源码确认的 v10/v20 Cookie、密码密文一律不碰；Edge/Brave
   按同样的最坏情况处理；
   不使用 `os_crypt.*` 密钥、不调用 elevation service、不修改来源安全配置。
4. **不上传、不记录敏感值**。Cookie 值、密码、session token 不上传、不写普通日志、不写导入包；
   导入包只包含用户明确选择的书签/历史/自动填充。
5. **不抢焦点**。导入工具本身是 CLI，不创建窗口；若未来进入 BrowserPilot UI，必须是用户拥有的 Space，
   遵守 `foreground-lease.ts`/Space 所有权，不得由 Agent 自动打开或抢占。
6. **三态结果**。数据复制、Cookie 写入、实际登录验证分别记录，任何一项不得推断另一项。

---

## 2. Normal/Agent 会话共享 vs 隔离

### 2.1 现状（代码事实）

- BrowserPilot 的 Task Space 是**逻辑隔离**：一个 Space 对应一个普通 Chrome 窗口，
  **同一 Profile 的 Space 共享 Cookie 与登录态**
  （`docs/dev/task-spaces.md` “Spaces in the same Chrome profile share cookies and login state”）。
- 控制权隔离由扩展层强制：Space 所有权、tab 归属、`FOREGROUND_BUSY` 前台 lease
  （`src/background/spaces.ts`、`foreground-lease.ts`）。
- Browser CLI 的 managed presentation 当前有进程级限制；同一 Profile 的窗口共享 Cookie Store，
  跨进程共享同一 Profile 是被禁止的。

### 2.2 产品原则

> 隔离的是**操作空间、焦点、控制权**，不是默认强迫用户重复登录。

| 模式 | 登录态 | 隔离强度 | 适用 |
| --- | --- | --- | --- |
| A. 同一授权 Profile（推荐默认） | Normal/Agent 共享 | Space/焦点/控制权逻辑隔离 | 日常使用；用户已登录的站点对 Agent 可用 |
| B. 同一 Profile，不同 Task Space | 共享 | 逻辑隔离 + 前台 lease | Agent 并行任务，但同一浏览器进程 |
| C. 独立 Profile（可选，用户为特定 Agent 选择） | 不共享 | 进程/Profile 级 | 高风险任务、需要独立账号/干净环境 |
| D. 独立 Profile + 一次性迁移 | 迁移后可复用 | 进程/Profile 级 | 用户希望隔离但不想重新登录 |

**不得**把“Normal 与 Agent 永远使用不同且无法共享会话的 Profile”固化为设计。模式 C/D 是选项，
不是默认。

### 2.3 模式 C/D 的迁移边界

- 迁移只在用户明确操作时执行（首次引导或设置中的“重新导入”）。
- 迁移完成后的 Cookie 写入目标 Profile；来源 Profile 保持不变。
- 目标 Profile 首次启动前完成写入，避免浏览器运行中写 Cookie/书签。
- 如果目标 Profile 已在使用，**拒绝写入**，提示用户关闭目标浏览器后重试；不自动关闭、不 kill。
- 迁移不是持续同步：来源浏览器后续新增的 Cookie/密码不会自动进入目标；需要重新导入。
- 长期若要做“同 Profile 共享 Cookie Store、分离 Task Space”，属于 Chromium 进程内多 Profile/Context
  设计，不在本轮；本轮不引入第二个 Chromium 进程共享同一 `user-data-dir`。

---

## 3. 一次性迁移流程（状态机）

```
discover → select_source → select_items → plan → export → apply → cookie_bridge → verify
             │                 │            │        │        │          │
             └── cancel ───────┴── skip ───┴─ fail ┴─ retry ┴─ reimport ┴─ mark_verified/failed
```

### 3.1 步骤

1. **discover**
   - 只读枚举 Chrome/Edge/Brave/Chromium/Firefox 的 Profile。
   - Chromium：`Local State` 的 `profile.info_cache` + `Default`/`Profile N` 目录；
     Firefox：`profiles.ini`。
   - 输出：Profile 路径、显示名、最近修改时间、是否看起来在运行（锁文件）、有哪些数据文件。
   - 不读取 Cookie/密码值。
2. **select_source / select_items**
   - 用户选择来源 Profile 与数据类别（cookies/bookmarks/history/passwords/autofill/tabs/extensions/preferences）。
   - 默认类别：cookies、bookmarks、history、passwords、autofill、tabs。
3. **plan**
   - 生成逐项状态：`ready` / `export-only` / `official-flow-required` / `blocked` / `unavailable` / `failed`。
   - 校验目标：绝对路径、不是来源、不在真实 Chrome/Edge/Brave/Firefox 根目录内、默认新建/空、
     `--allow-existing` 时的加密书签/运行中检查。
4. **export**
   - 只读导出到本地 bundle：`bookmarks.json`、`history.jsonl`（可选）、`autofill.jsonl`（可选）。
   - `blocked.json` 记录 Cookie/密码/标签页/扩展的原因；`result.json` 初始化三态。
   - **bundle 永不包含 Cookie/密码/session token**。
5. **apply**
   - 默认只写**新/空**目标 Profile 的 `Bookmarks`。
   - 目标已有书签且 `--allow-existing`：先 `Bookmarks.bak.<timestamp>`，再合并到唯一命名的
     “Imported from …” 文件夹；原子写（temp + fsync + rename）。
   - 目标发现 `EncryptedBookmarks2`/`EncryptedAccountBookmarks2` 非空 → 拒绝。
   - 目标在运行/无法确认 → 拒绝。
   - 历史/自动填充/Cookie/密码不写入目标，记录对应状态。
6. **cookie_bridge**（可选，需用户显式安装扩展）
   - 来源扩展用 `chrome.cookies.getAll` 读取用户勾选域名；本地 Broker 内存中转；
   - 目标扩展用 `chrome.cookies.set` 写入当前 Profile；
   - 结果只记录 `applied/failed/failuresByReason`，`loginVerified` 强制 `not_verified`。
7. **verify**
   - 用户实际打开网站确认；`verify --status user_confirmed --domain <d> --confirm-user-action`
     才写入 `user_confirmed`。
   - 失败可记录 `failed`；未确认保持 `not_verified`。

### 3.2 取消、跳过、重试、重新导入

| 操作 | 语义 |
| --- | --- |
| 取消 | 关闭 UI/终止 CLI；已写入的目标文件不会被回滚，但已有备份可恢复；不自动删除 bundle |
| 跳过某项 | 该项不进入 bundle/不写入；`result.json` 记录 `skipped` |
| 重试 | 重新执行同一阶段；`export --overwrite` 需要显式；`apply` 失败不修改目标（原子写） |
| 重新导入 | 新建 bundle 再 apply；目标已有数据时使用 `--allow-existing`，产生新备份与唯一文件夹 |
| 部分失败 | 逐项记录；不把整次迁移标记成功；Cookie 部分成功 → `partially_imported` |

### 3.3 失败与回滚

- `export` 失败：不写 `manifest.json` 以外的半成品？实际实现先写数据文件再写 manifest；
  重新导出用新目录或 `--overwrite`，避免误用半成品。
- `apply` 书签：写入前完成所有校验；写入使用临时文件 + rename；失败时临时文件清理，原文件不变。
- 已有 `Bookmarks`：先备份，再原子替换；若替换失败，备份仍在，可人工恢复。
- 目标数据库/文件在写入期间被其他进程占用：rename 失败 → 返回错误，不重试覆盖。
- 来源文件永不被修改，因此无需回滚来源。

---

## 4. 并发 Profile 访问禁令

### 4.1 规则

1. **来源**：可以只读快照。实现上复制 DB（含 `-wal`/`-shm`/`-journal`）到临时目录再打开，
   `PRAGMA query_only=ON`；来源浏览器运行中也不写来源。
2. **目标**：
   - 默认目标必须是**不存在或空目录**，从根上排除“另一个进程正在使用”的情况。
   - 已有目标必须 `--allow-existing`，并满足：
     - 无 `SingletonLock` / `SingletonCookie` / `parent.lock`；
     - Windows 进程探测未发现占用（`--user-data-dir` 指向目标，或目标位于该进程的默认 user-data 根）；
     - 探测失败且目标非空 → fail closed。
   - 只写 `Bookmarks` 一个文件；不打开/不写目标 `Cookies`、`History`、`Login Data`、`Web Data`。
3. **禁止**：两个独立 Chromium 进程（Normal/Agent、Browser CLI/Chrome、两个 Agent Profile 实例）
   并发直接读写同一 `user-data-dir`。需要隔离时使用独立 `--user-data-dir`。
4. **禁止**：通过复制整个 Profile 目录给另一个进程“共享登录态”。这既违反单写者，也会带入
   v20 密文（目标无法解密）和单例/缓存冲突。

### 4.2 Windows 检测的已知缺口

- Windows Chromium 不像 POSIX 那样留下 `SingletonLock` 文件；当前实现用 PowerShell
  `Get-CimInstance Win32_Process` 读取命令行做**只读**探测（不结束进程）。
- 探测失败/权限不足时，对非空目标 fail closed。
- 新/空目标不依赖进程探测（没有浏览器会使用一个空目录）。
- 残余竞态：探测与写入之间目标可能被启动。MVP 通过“默认空目标 + 短窗口 + rename 失败即报错”
  降低风险；正式版建议在 Browser CLI 内提供原生导入命令，由浏览器自身在启动早期持有 Profile 锁。

---

## 5. 焦点、Space 与控制权

- 导入 CLI **不创建窗口、不聚焦、不截图、不调用扩展命令**。
- 若未来在 BrowserPilot 中提供导入向导：
  - 必须由用户显式打开（设置页/首次引导），不能由 Agent 模板自动触发；
  - 向导窗口归用户所有（`user` ownership），Agent 不得 `claim_space`；
  - 任何可见操作仍需前台 lease；不同 Space 不得因导入而互抢焦点/tab/控制权；
  - 导入结果页只读展示，不自动打开来源/目标网站，不自动验证登录。
- 来源浏览器与目标浏览器可能同时运行：Broker 只做本机内存中转，不聚焦任何窗口；
  扩展写入目标时可能触发目标浏览器的正常 Cookie 通知，但不应主动 `windows.update({focused:true})`。

---

## 6. 安全与隐私设计

| 资产 | 处置 |
| --- | --- |
| Cookie 值 / session token | 只在来源扩展内存 → loopback Broker 内存 → 目标扩展内存；不落盘、不日志、不上传 |
| 密码 | 不读取；只统计行数；官方 CSV 流程由用户自行操作 |
| 书签/历史/自动填充 | 写入本地 bundle（0600）；提示包含个人数据；不上传 |
| 来源加密密钥 | 不读取、不复制、不解密 |
| 目标 Profile | 只写 Bookmarks；写入前备份；不碰 DB |
| Broker | 127.0.0.1、6 位配对码、Origin allowlist、16MB 上限、10 分钟 TTL、仅计数日志 |
| 日志 | 只输出计数/状态/路径；不输出 Cookie 名/值/域名、密码、URL（历史导出文件除外） |

补充：

- Broker 的配对码在终端打印，属于“用户在场授权”；不使用固定默认码。
- 扩展 ID 通过 manifest `key` 固定，Broker 校验 `Origin`。
- 目标扩展强制 `loginVerified: "not_verified"`；Broker 拒绝 `user_confirmed`（必须由 CLI 的用户显式确认）。
- 不在 bundle 中写 `Cookies`/`Login Data`/`Local State`/`key4.db`；apply 前再次检查。

---

## 7. 结果模型（三态）

`result.json`（bundle 内，apply/verify 更新）：

```json
{
  "format": 1,
  "targetProfile": "C:\\...\\User Data\\Default",
  "dataCopied": { "bookmarks": true, "history": false, "cookies": false, "passwords": false },
  "cookieImported": { "status": "blocked", "reason": "..." },
  "loginVerified": { "status": "not_verified", "confirmedDomains": 0, "failedDomains": 0 },
  "loginChecks": [
    { "domain": "example.com", "status": "user_confirmed", "at": "...", "by": "user" }
  ]
}
```

规则：

- `dataCopied` 只表示文件/记录复制。
- `cookieImported` 只表示 `chrome.cookies.set` 结果；`partially_imported` 必须显式。
- `loginVerified` 只能是 `not_verified` / `user_confirmed` / `partially_verified` / `failed`；
  只有 `--confirm-user-action` 才能写入 `user_confirmed`。
- 任何自动化/模板不得调用 `verify` 的用户确认路径。

---

## 8. MVP 实现映射

| 能力 | 文件 |
| --- | --- |
| CLI 入口 / 帮助 / 参数 | `scripts/import/browser-data-import.mjs` |
| Profile 发现、锁/进程探测 | `scripts/import/lib/browsers.mjs` |
| 只读 SQLite 快照 | `scripts/import/lib/sqlite.mjs` |
| 只读盘点 | `scripts/import/lib/inventory.mjs` |
| 迁移计划 | `scripts/import/lib/plan.mjs` |
| 导出 bundle | `scripts/import/lib/export.mjs` |
| 书签解析/生成/校验 | `scripts/import/lib/bookmarks.mjs` |
| 目标写入（原子/备份/合并） | `scripts/import/lib/apply.mjs` |
| 三态结果 | `scripts/import/lib/verify.mjs` |
| 原子文件/哈希工具 | `scripts/import/lib/fs-safe.mjs` |
| Cookie Broker | `scripts/import/cookie-bridge/broker.mjs` |
| Cookie 协议/校验 | `scripts/import/cookie-bridge/protocol.mjs` |
| 来源扩展原型 | `scripts/import/cookie-bridge/source-extension/` |
| 目标扩展原型 | `scripts/import/cookie-bridge/target-extension/` |
| 测试 | `scripts/test-browser-data-import.mjs`、`scripts/test-cookie-bridge.mjs` |

运行方式（Windows，worktree 根目录）：

```powershell
node scripts/import/browser-data-import.mjs discover --inspect
node scripts/import/browser-data-import.mjs plan --source chrome:Default `
  --target-profile "D:\tmp\browser-cli-profile\Default" `
  --items cookies,bookmarks,history,passwords,autofill,tabs
node scripts/import/browser-data-import.mjs export --source chrome:Default --out D:\tmp\bp-bundle `
  --items cookies,bookmarks,history,passwords,autofill,tabs
node scripts/import/browser-data-import.mjs apply --bundle D:\tmp\bp-bundle `
  --target-profile "D:\tmp\browser-cli-profile\Default"
node scripts/import/browser-data-import.mjs verify --bundle D:\tmp\bp-bundle `
  --status user_confirmed --domain example.com --confirm-user-action
```

Cookie 桥：

```powershell
node scripts/import/cookie-bridge/broker.mjs --port 47831
# 来源浏览器：加载 scripts/import/cookie-bridge/source-extension（chrome://extensions -> Load unpacked）
# 目标浏览器：加载 scripts/import/cookie-bridge/target-extension
# 输入 broker 打印的配对码；来源扩展扫描并勾选域名 -> 发送；目标扩展获取任务 -> 应用
```

测试：

```powershell
node scripts/test-browser-data-import.mjs   # 15 passed
node scripts/test-cookie-bridge.mjs         # 14 passed
```

测试使用纯合成 Profile（临时目录），不启动浏览器、不读取真实用户 Profile；
测试断言来源文件在所有命令后 SHA-256 完全不变，且输出/导入包不包含 Cookie/密码 canary 值。

实测输出（2026-10-30，Node v24.15.0，Windows 10.0.26200）：

```text
$ node scripts/test-browser-data-import.mjs
PASS discover lists synthetic Chrome/Edge/Firefox profiles
PASS plan reports cookies/passwords as blocked/official-flow
PASS export writes no cookie/password values and no forbidden DBs
PASS export autofill only when explicitly requested (values are personal data)
PASS apply writes a valid Bookmarks file and never claims cookie/login success
PASS re-apply refuses a non-empty target without --allow-existing
PASS re-apply with --allow-existing creates a backup and a unique folder
PASS apply refuses a target inside a real source-browser user data root
PASS apply refuses the source profile itself
PASS apply refuses an existing target with encrypted bookmarks
PASS verify refuses to claim a login without explicit user action
PASS verify records an explicit user-confirmed login and never upgrades cookie/data states
PASS Firefox source exports bookmarks/history and applies bookmarks to a new target
PASS source profiles are byte-identical after all commands (read-only proof)
PASS migrate runs plan+export+apply end to end

15 passed, 0 failed

$ node scripts/test-cookie-bridge.mjs
PASS extension manifest keys produce stable IDs matching the broker allowlist
PASS payload validation accepts the normal case and normalizes counts
PASS payload validation rejects malformed fields without echoing values
PASS cookieToSetDetails maps host-only, domain, session and partition fields
PASS error classification does not include cookie values
PASS health works without pairing and never exposes job data
PASS pairing and origin checks are enforced
PASS source can post a job; duplicate pending job is rejected
PASS target fetches once (204 afterwards) and status reports delivered
PASS target cannot claim a verified login
PASS result is recorded as counts only; status distinguishes cookie import from login
PASS oversized bodies are rejected
PASS broker logs contain counts/IDs only, never cookie values or domains
PASS result validation rejects impossible counts

14 passed, 0 failed
```

这些通过项**只覆盖** CLI/文件/SQLite/协议/Broker 层；不覆盖真实浏览器扩展行为。

---

## 9. 若必须新增 Chromium 能力（patch 计划，仅设计）

本轮**不修改** `D:\c\src`，也不提交 patch。若后续需要在 Browser CLI 内原生完成导入：

### 9.1 可做的

1. **原生 `browser-cli import` 命令**（浏览器进程内，持有 Profile 锁）：
   - 读取来源 Chrome/Edge/Brave 的 `Bookmarks` JSON、`History` SQLite（只读快照）；
   - 通过现有 `ProfileWriter::AddBookmarks` / `HistoryService::AddPagesWithDetails` 写入，
     **不直接写目标 SQLite**（`profile_writer.cc:103-110`、`profile_writer.h:60-76`）。
2. **Cookie 接收 API**：接受来源扩展导出的 Cookie JSON，通过
   `CookieStore::SetCanonicalCookieAsync` 写入目标 Cookie Store（目标自己加密）。
   - 仍要求用户显式安装来源扩展；不读取来源密钥。
3. **首次引导集成**：在 Chromium 设置/首次运行中加入“从其他浏览器导入”入口，
   但必须由用户触发；不得自动导入。

### 9.2 不做的

- 不新增 Chrome/Edge/Brave 的 v10/v20 解密器。
- 不修改 source browser 的安全配置、不降低 App-Bound 保护、不伪造调用路径。
- 不把 Cookie 数据库复制进目标 Profile（目标无法解密，且违反单写者）。
- 不复制 `Sessions`/`Extensions`/`Preferences` 全量文件。

### 9.3 为什么历史/自动填充不直接写 DB

- History schema 当前版本 70（`history_database.cc:41`），迁移链复杂；外部写入需要精确维护
  `urls`/`visits`/`visit_source`/索引/meta，且浏览器运行时会持有连接。
- 原生 `HistoryService` 写入是唯一有维护保证的路径。
- 自动填充同理，`Web Data` 由 WebDataService 独占。

---

## 10. 验收清单

- [x] 来源 Profile 在 discover/plan/export/apply 后 SHA-256 不变（合成 Profile 测试）。
- [x] 不启动、不结束任何浏览器进程。
- [x] 目标默认新建/空；非空需 `--allow-existing`；写入前备份；原子写。
- [x] 目标内存在 `EncryptedBookmarks2` 时拒绝。
- [x] 目标在运行（锁文件/进程探测）时拒绝。
- [x] Cookie/密码值不进入日志、bundle 或 Broker 日志（canary 测试）。
- [x] Cookie 导入状态与登录验证状态分离；目标扩展/Broker 不能声明 `user_confirmed`。
- [x] `verify` 未带 `--confirm-user-action` 时拒绝确认登录。
- [x] Firefox 书签/历史导出并可写入新目标 Profile。
- [x] Cookie Bridge 协议/Broker/字段映射/配对/Origin/大小限制测试通过。
- [ ] 在真实 Chrome/Edge/Brave + Browser CLI 中加载扩展并完成一次 Cookie 迁移（未验证）。
- [ ] 在真实 Browser CLI 首次启动后确认导入的 Bookmarks 可读（未验证）。
- [ ] Edge/Brave 真实安装路径发现（未验证）。
- [ ] Windows 进程探测在真实环境的行为（测试中跳过）。

---

## 11. 下一步建议

1. **优先验证扩展桥**：在隔离 Windows 测试机（专用 Chrome/Edge + 临时 `--user-data-dir`）安装两端
   扩展，用本地测试账号完成一次 Cookie 迁移；记录 `applied/failed`、失败原因分布与实际页面登录结果。
2. **Browser CLI 原生导入命令**：按 §9.1 实现 `bookmarks/history` 的进程内导入（复用 `ProfileWriter`
   /`HistoryService`），消除直接写 `Bookmarks` 的版本风险。
3. **密码官方流程产品化**：在首次引导中提供“导出 CSV → 目标导入”的分步 UI，明确设备绑定/passkey
   不可迁移。
4. **历史/自动填充**：先保持 export-only；评估原生 `HistoryService`/WebDataService 导入。
5. **Edge/Brave**：在隔离环境验证路径、Profile 结构、Cookie 前缀；将结果补入研究矩阵。
6. **Broker 加固**：配对码尝试限速、一次性 job 绑定来源扩展 ID、目标扩展写入速率限制与总量上限。
7. **英文/中文 UI 文案**：明确“Cookie 等同登录凭证”“设备绑定会话可能失效”“不会上传”。

> 2026-10-30 修订：双扩展 + loopback Broker 不再作为正式方案推荐；仅保留为候选。
> 官方 ego(lite) 0.6.2.5 实测未完成 Chrome 登录态迁移（Chrome 运行中/源根不可重定向/v20 可能 UAC），
> Edge 原生 ImportCookies 不需要来源扩展，单来源扩展 + 目标原生写入已验证目标侧。详见
> `docs/browser-import-competitive-report-2026-10-30.md` 与 `docs/ego-lite-windows-import-test-2026-10-30.md`。
