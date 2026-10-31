# 浏览器数据导入产品化（P1，2026-10-31）

分支：`agent/p1-product`（基于 P1 PR #4 的 `b411f0e`）
Worktree：`D:\work\wt\bp-p1-product`
关联文档：

- 架构与边界：`docs/browser-data-import-architecture-2026-10-30.md`
- 来源扩展 + 本地目标协议：`docs/browser-cli-native-cookie-import-interface.md`
- 真实 Windows 证据（仅证据，不是产品依赖）：`docs/windows-ego-import-applicability-2026-10-31.md`

---

## 1. 本轮结论（先说边界）

**产品化的 BrowserPilot 侧已经可运行并测试；Browser CLI 原生目标尚未实现。
因此不能宣称“完整产品闭环已打通”。**

| 部分 | 状态 | 说明 |
| --- | --- | --- |
| 最小来源扩展（BrowserPilot 自有） | **产品级（unpacked 可用）** | `extensions/import-source/`；`cookies` + `storage` 权限；显式双重授权；仅发送勾选域名；无上传；无日志；无持久化 Cookie |
| Chrome/Edge Profile 发现与选择 | **产品级（CLI）** | `sources` 命令；只读；识别 `Network/Cookies`；运行中状态；Firefox 明确标记 Cookie 不支持 |
| Cookie 导入契约 v1 | **产品级（冻结）** | `scripts/import/contract.mjs`；扩展内副本字节一致；契约测试覆盖 |
| 本地测试目标 | **测试级** | `scripts/import/target/local-target.mjs`；memory 后端不持久化；CDP 后端仅测试 |
| CLI 授权/进度/失败/重试/取消/重新登录引导 | **产品级（CLI）** | `connect` / `report` / `confirm-login`；三态分离 |
| Browser CLI 原生 CookieStore 写入 | **未实现（原型设计）** | 见 `docs/browser-cli-native-cookie-import-interface.md`；未修改 Chromium 源码 |
| 重启后 Cookie 仍存在 | **未在本轮验证** | 原生目标必须持久化；测试目标 memory 后端明确报告 `persistAcrossRestart=false` |
| Web Store / 企业策略分发 | **未实现** | 当前只能开发者模式加载 unpacked；Chrome 156 默认禁用未受支持开发者扩展 |
| 书签/历史/密码/扩展导入 | 维持 PR #4 的 MVP 状态 | 书签可写新/空目标；历史/自动填充 export-only；密码走官方 CSV |

PR #4 中的真实 WorkBuddy 登录导入（来源 Chrome + 已安装第三方扩展 + 目标 CDP）
仍只作为**证据**保留，不作为产品依赖、测试夹具或回归 token。

---

## 2. 端到端产品流程（BrowserPilot 侧）

```text
sources → 选择来源 Profile → 显式确认 → 启动/连接目标（打印地址 + 配对码）
       → 来源扩展：授权 → 扫描域名 → 勾选域名 → 再次授权 → 发送
       → CLI：进度 → 三态结果 → 报告 → 重新登录引导
       → 用户本人 confirm-login（可选）
```

### 2.1 列出并选择来源

```powershell
node scripts/import/browser-data-import.mjs sources
node scripts/import/browser-data-import.mjs sources --json
```

- 只读枚举 Chrome/Edge/Brave/Chromium/Firefox Profile。
- Chrome/Edge 标记为 `supported`；Brave/Chromium 为 `experimental`；Firefox 为
  `unsupported`（Cookie 流程）。
- 读取 `Network/Cookies`（现代 Chromium）或根目录 `Cookies`（旧版/夹具）。
- 不读取 Cookie 值；只读 `Local State`、目录/文件元数据。
- 显示“运行中”状态。对 Cookie 流程，来源浏览器运行中是**正常且必需**的；
  工具不会关闭、重启或结束它。

选择 Profile 只是**引导/确认**：扩展实际扫描的是用户打开扩展时所在的那个
Profile。CLI 无法把扩展绑定到某个路径；真正的授权范围是扩展里的显式勾选。

### 2.2 启动目标并配对

有原生目标时：

```powershell
node scripts/import/browser-data-import.mjs connect `
  --source chrome:Default `
  --endpoint http://127.0.0.1:PORT --pair 123456
```

没有原生目标时（本地测试契约，**不是产品闭环**）：

```powershell
node scripts/import/browser-data-import.mjs connect --source chrome:Default
# 或显式使用测试 CDP 后端（仅隔离测试 Profile）
node scripts/import/browser-data-import.mjs connect --source chrome:Default --cdp-port 9333 --allow-test-cdp
```

`connect` 会：

1. 再次检查来源可用性；
2. 交互式要求确认来源 Profile（`--yes` 可跳过）；
3. 打印 `http://127.0.0.1:<port>` 和 6 位配对码；
4. 轮询 `/v1/import/status`，显示进度（只含计数）；
5. 结束后打印三态结果、失败原因和重新登录引导；
6. 写本地报告（只含计数/错误码，不含 Cookie 值/名称/域名）。

交互模式下结束后可按 `r` 等待扩展重试（重新扫描并发送），按 `q` 退出。
`Ctrl+C` 只取消当前导入任务（调用 target cancel），**不会**关闭任何浏览器。

### 2.3 来源扩展

安装：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 →
选择 `extensions/import-source`。详见 `extensions/import-source/README.md`。

弹窗流程：

1. 明确授权（勾选后才可扫描）。
2. 扫描：只显示域名、数量、HttpOnly/Session/分区计数；不显示 Cookie 值。
3. 勾选域名：默认**全不选**；支持全选/全不选。
4. 填写 CLI 打印的地址 + 配对码（只接受 `http://127.0.0.1:<port>`）。
5. 再次勾选“发送授权”，发送。
6. 显示进度、失败原因、取消/重试、重新登录提示。

隐私实现细节：

- 扫描后只保留域名集合，不保留 Cookie 值/名称；发送时只对勾选域名重新调用
  `chrome.cookies.getAll({domain})`。
- 地址、配对码、任务号只存 `chrome.storage.session`（内存，浏览器重启清空）。
- 发送成功后立即释放扫描缓存。
- 代码中没有 `console.*`；返回给弹窗的目标响应经过字段白名单清洗。
- 目标声称的 `loginVerified` 在扩展侧被强制为 `not_verified`。

### 2.4 三态与用户确认

| 状态 | 含义 | 来源 |
| --- | --- | --- |
| 数据复制 | 书签/历史等文件包复制 | apply/bundle |
| Cookie 写入 | 目标 CookieStore 的 applied/failed | 目标 job |
| 实际登录 | 用户本人打开网站确认 | `confirm-login --confirm-user-action` |

Cookie 写成功 ≠ 登录成功。任何自动化路径都不能写 `user_confirmed`：

```powershell
node scripts/import/browser-data-import.mjs confirm-login `
  --file <report.json> --domain example.com --status user_confirmed --confirm-user-action
```

未带 `--confirm-user-action` 时返回 3（`explicit-user-action-required`）。

---

## 3. 目标契约（摘要）

完整定义见 `docs/browser-cli-native-cookie-import-interface.md`。

端点（仅 `127.0.0.1`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/import/capabilities` | 契约版本与能力（无需配对） |
| POST | `/v1/import/cookies` | 接收来源扩展任务（需配对） |
| GET | `/v1/import/status` | 当前/最近任务（CLI 轮询） |
| GET | `/v1/import/jobs/<id>` | 单任务详情（扩展轮询） |
| POST | `/v1/import/jobs/<id>/cancel` | 取消后续写入（不回滚） |

关键约束：

- `x-bp-pair` 6 位配对码；来源扩展 ID Origin allowlist；16 MiB 上限；
  单活动任务；10 分钟 TTL。
- 请求必须带 `consent.kind = explicit-user-action`。
- Cookie 域必须属于用户勾选域（含子域）。
- 公开任务视图只含计数、状态和固定错误码；`loginVerified` 永远是
  `not_verified`。
- 目标必须报告 `native: true` 和 `persistAcrossRestart: true` 才能称为产品目标。
  本地测试目标如实报告 `native: false`。

---

## 4. 本轮新增/修改的代码

| 文件 | 作用 |
| --- | --- |
| `scripts/import/contract.mjs` | v1 契约、校验、公开视图、脱敏 |
| `scripts/import/sync-extension-contract.mjs` | 契约复制/一致性检查 |
| `extensions/import-source/` | 产品来源扩展（manifest、SW、popup、selection、契约副本） |
| `scripts/import/target/local-target.mjs` | 契约本地测试目标（memory + 可选 CDP） |
| `scripts/import/target/cdp-backend.mjs` | 仅测试 CDP 后端 + 字段映射 |
| `scripts/import/lib/sources.mjs` | 来源 Profile 列表/选择/就绪判断 |
| `scripts/import/lib/target-client.mjs` | 契约 HTTP 客户端 + 响应脱敏 |
| `scripts/import/lib/wizard.mjs` | 进度/三态/等待/重试/引导文案 |
| `scripts/import/lib/report.mjs` | 仅计数报告、显式登录确认 |
| `scripts/import/lib/verify.mjs` | 抽出可复用的 `applyLoginCheck` |
| `scripts/import/browser-data-import.mjs` | 新增 `sources`/`connect`/`report`/`confirm-login` |
| `scripts/import/lib/browsers.mjs` | 修正现代 Chromium `Network/Cookies` 发现 |
| `scripts/test-import-product.mjs` | 33 项产品级测试 |
| `scripts/test-browser-data-import.mjs` | 测试根隔离扩展到 Brave/Chromium |

没有修改 Chromium 源码、没有新增 Chromium patch、没有修改
`D:\work\BrowserPilot` 主 worktree。

---

## 5. 测试运行结果

Node v24.15.0，Windows 10.0.26200，工作目录 `D:\work\wt\bp-p1-product`。

```text
$ node scripts/import/sync-extension-contract.mjs --check
contract copy is in sync

$ node scripts/test-import-product.mjs
33 passed, 0 failed

$ node scripts/test-browser-data-import.mjs
15 passed, 0 failed

$ node scripts/test-cookie-bridge.mjs
14 passed, 0 failed
```

产品测试覆盖（摘录）：

- 契约：合法请求、缺失 consent、未选域名、非法 requestId、超长值、分区/SameSite/
  过期字段、域匹配语义。
- 公开视图：只含计数/错误码；强制 `not_verified`；恶意目标返回 `user_confirmed`
  或额外 Cookie 字段时被清洗。
- 扩展静态检查：权限最小化；无 `console.*`；无 `storage.local`；无 tabs/history/
  bookmarks；无远程 URL；契约副本字节一致；固定扩展 ID。
- 来源发现：合成 Chrome/Edge 的 `Network/Cookies`；Firefox 不支持 Cookie；
  命令前后来源树 SHA-256 不变。
- 本地目标：配对/Origin/预检；任务成功、部分失败、全失败；幂等 requestId；
  target-busy；取消不回滚；413/415/未知路由；日志无值/名称/域名。
- CLI：外部目标端到端（子进程）等待任务、写报告、输出三态；不支持来源退出 3；
  缺配对码退出 2；`confirm-login` 未显式确认退出 3；确认后不改变 Cookie 状态。
- 隐私：报告/日志/终端输出不包含 canary 值、Cookie 名称或域名（确认登录后域名
  只出现在 `loginChecks`）。

所有夹具都是 `%TEMP%` 下的合成 Profile/合成 Cookie；未启动浏览器；未读取真实
Chrome/Edge/Firefox Profile；未使用真实 WorkBuddy token。

---

## 6. 明确未完成（原生 Browser CLI 侧）

1. **原生 CookieStore 写入端点**（必须）：进程内服务/私有 API，使用
   `CookieStore::SetCanonicalCookieAsync`；见接口文档 §5.1。
2. **原生启动开关与 UI 入口**：只有用户显式启动导入时才监听 loopback；配对码
   打印给用户。
3. **重启持久化验收**：写入 → 关闭 Browser CLI → 同 Profile 重启 → Cookie 仍在
   （依赖目标 CookieStore，不是测试报告）。
4. **真实浏览器内扩展行为验收**：在隔离 Windows 测试机/虚拟机上用本地测试账号，
   验证 Chrome/Edge 的 `chrome.cookies` → 目标原生写入；不接触真实用户 Profile。
5. **分发**：Web Store 或企业策略安装来源扩展；Chrome 156 默认禁用未受支持的
   unpacked 扩展。
6. **书签/历史/密码**：书签已有文件级 MVP；历史/自动填充仍 export-only；密码走
   官方 CSV。原生 `HistoryService`/`WebDataService` 导入属于后续。
7. **登录验证的产品 UI**：目前是 CLI `confirm-login`；浏览器内 UI 由用户本人
   确认，Agent 不得代确认。

在这些完成前，文档和 UI 都明确标注“测试目标/非产品闭环”，不把本地 memory
目标或 CDP 测试当成产品通过。

---

## 7. 安全与清理

- 不读取/复制/解密来源 v10/v20 Cookie 密文或源 Profile 密钥。
- 不复制 `Cookies`/`Login Data`/`Local State` 到目标。
- 不上传、不写普通日志、不把 Cookie 值写进报告或 bundle。
- 不启动/关闭/重启来源浏览器；不 `kill` 任何进程。
- 不修改来源浏览器安全配置，不调用 elevation service，不伪造进程路径。
- 不使用 `--no-sandbox`（本流程根本不启动浏览器）。
- 测试只用合成 Profile/合成 Cookie；真实证据（WorkBuddy）不作为夹具。
- 本地测试目标的 memory 后端不落盘；CDP 后端只允许显式 `--allow-test-cdp` 且
  必须指向隔离测试 Profile。

---

## 8. 快速运行

```powershell
# 1. 契约副本一致性
node scripts/import/sync-extension-contract.mjs --check

# 2. 全部导入测试
node scripts/test-import-product.mjs
node scripts/test-browser-data-import.mjs
node scripts/test-cookie-bridge.mjs

# 3. 列出来源（只读）
node scripts/import/browser-data-import.mjs sources

# 4. 产品化引导（原生目标存在时）
node scripts/import/browser-data-import.mjs connect --source chrome:Default `
  --endpoint http://127.0.0.1:PORT --pair 123456

# 5. 本地契约目标（测试）
node scripts/import/browser-data-import.mjs connect --source chrome:Default
# 或单独启动
node scripts/import/target/local-target.mjs --port 47832

# 6. 查看报告 / 用户确认登录
node scripts/import/browser-data-import.mjs report --file <report.json>
node scripts/import/browser-data-import.mjs confirm-login --file <report.json> `
  --domain example.com --status user_confirmed --confirm-user-action

# 7. 扩展安装
# chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> extensions/import-source
```

## 2026-11-01 v2 安全硬化（本轮）

本轮把 cookie-import 契约升级到 **v2**，并修复“6 位配对码 + Origin 即授权”的不足：

- 一次性 160-bit 导入票据（Crockford base32 `BCLI-…`，5 分钟 TTL，首次 hello
  即消费；失败 5 次/60 秒锁定；每进程每小时最多 10 次 hello）。
- 票据绑定目标进程（pipe client PID ↔ hostPid）、目标 Profile（per-process salt
  hash）、jobNonce/jobDigest 和用户勾选域名的 `domainsDigest`。
- 传输改为 **BrowserPilot native messaging host import-only relay →
  Browser CLI Windows named pipe**；产品路径不再有 localhost HTTP API。
- 目标浏览器内必须由用户本人确认来源/域名范围；来源扩展、host、CLI 都不能代替确认。
- 目标端规则：HostOnly/Domain、Public Suffix、`__Host-/__Secure-/__Http-` 前缀、
  SameSite=None 必须 Secure、Partitioned/partition key、过期时间；失败按固定 code 计数。
- Session Cookie 明确标注“不保证跨重启保留”。
- 三态仍严格分离：数据复制 / Cookie 写入 / 实际登录；目标授权是独立字段，不是登录。

代码/文档：

- `scripts/import/contract.mjs`（v2）、`extensions/import-source/`（nativeMessaging，
  无 HTTP）、`native-host/import-relay.mjs`、`native-host/host.js`（lazy normal mode）；
- `scripts/import/target/native-pipe-target.mjs`（测试替身）、
  `scripts/import/target/local-target.mjs`（v2 HTTP 测试替身）；
- `scripts/test-import-product.mjs`（42 项）、`scripts/test-native-import.mjs`（11 项）；
- `docs/browser-cli-native-cookie-import-interface.md`（v2 交接）。

Browser CLI 原生端点：**proposed，未编译、未集成**，见
`D:\work\wt\bc-rc-p1\chromium\patches\proposed\034-browser-cli-cookie-import.patch`
与 `D:\work\wt\bc-rc-p1\docs\p1-cookie-import-native-v2-2026-11-01.md`。
不得据此宣称产品闭环完成。
