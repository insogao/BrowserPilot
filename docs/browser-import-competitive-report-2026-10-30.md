# 浏览器数据导入竞品反证与方案对比（2026-10-30）

状态：**竞品反证 + 原生方案再调查 + 最小原型验证 + 真实 inso 登录态导入 PASS**；Browser CLI 目标侧 Cookie 写入/登录/重启已验证（测试配置），来源 Web Store 扩展 → 目标原生 CookieStore 已在真实 Chrome 156 v20 环境通过；Agent Space 未单独开窗，Agent `js`/`snapshot` 已在登录标签验证。
关联实测：`docs/ego-lite-windows-import-test-2026-10-30.md`、`docs/windows-ego-import-applicability-2026-10-31.md`
关联原型：`prototype/one-source-extension/`、`prototype/native-target.mjs`
安全边界：经用户明确授权后，复制过 inso Profile 做只读启动验证（副本已删除），并用其已安装 Web Store 扩展读取当前标签 cookie；未解密/提取 DPAPI/App-Bound 密钥；未注入 Chrome；未使用 `--no-sandbox`；未关闭/重启真实 Chrome；未把 cookie 值写入项目文件或上传。

---

## 0. 直接回答五个问题

### (a) ego(lite) Windows 导入实际做到了什么？

**官方 ego(lite) 0.6.2.5（citrolabs）确实不是“只导入书签/历史”的简单工具。** 安装包内 `chrome.dll` 带有自研模块：

```
ego/browser/data_import/browser_data_importer.cc
ego/browser/data_import/import_source_user_data.cc
ego/browser/data_import/chromium/chromium_profile_cookies.cc
ego/browser/data_import/chromium/chromium_profile_recovery.cc
...
```

字符串与资源显示它覆盖：Cookies（含 Partitioned）、Login Data、History、Bookmarks、Extensions、Sessions/Tabs、Profile 整包；CLI 支持 Chrome/Edge/Brave/Comet/Opera/Vivaldi/Yandex/Firefox/Zen/Arc/Dia。

但本轮**没有完成**真实 Chrome → ego(lite) 的登录态实测：

- 真实 Chrome 正在运行，而 Ego 含 `source_closed_by_ego`/`source_close_requests`，会关闭/要求关闭来源浏览器；
- 在本机测试中，隔离 `LOCALAPPDATA` 或任意 `browserSource` 路径都没有把源根重定向到测试 Profile；
- App-Bound 相关字符串显示 v20/v22 可能请求 UAC/提升服务，失败时 `success_discarded_v20_values_*` 直接丢弃；
- 本机没有独立 Windows 用户/VM/Windows Sandbox（Home 版）。

因此 (a) 的准确表述是：**官方宣称并具备原生多浏览器导入代码，但 Windows Chrome 登录态迁移在本轮是“未验证/blocked”，不是 PASS；其实际成功率未知，v20 存在明确的丢弃路径。**
另：GitHub `sj18259360196-source/EgoLite` 0.2.14 是**另一个产品**，只导入书签/历史和复制扩展，不能拿来证明官方 ego(lite)。

### (b) 是否真的需要在来源和目标分别安装扩展？

**不需要。** 上一轮“唯一合规方案 = 来源+目标双扩展+Broker”的排他性结论不成立：

- **Chromium 上游**确实不支持 Cookie，也不支持 Chrome 作为来源；但“上游没实现”≠“不能新增模块”。
- **Microsoft Edge** 有 `ImportCookies` 策略，明确“从另一个浏览器导入 Cookies”，且当前管理 **Google Chrome** 导入；二进制里有 `edge_cookie_importer.cc`、`edge_cookie_importer_export_process_host.cc`、`cookie_exporter.exe`、`cookies.json`、`msEdgeImportCookiesFromChrome` 等。它走的是原生导入/导出进程，不需要来源扩展。
- **ego(lite)** 走的是复制来源 Profile + 本地解密/重写，也不需要来源扩展。
- 我们自己的最小验证也证明：**只要来源端能通过官方 `chrome.cookies` 读出 Cookie，目标端有原生 Cookie 写入接口，就不需要目标扩展**。

所以：双扩展不是必要条件；它只是一个合规候选，而且维护成本最高。

### (c) Browser CLI 能否无需两个扩展一键导入？

分三种“无需两个扩展”的路径：

| 路径 | 是否需要来源扩展 | 是否能处理 v20 | 是否合规/可推荐 |
| --- | --- | --- | --- |
| 原生复制来源 Profile + v10 DPAPI 解密 | 否 | **否**（v20 需要 App-Bound key/提升服务） | v10 技术可行；需产品/法律决策；本轮不实现 |
| 原生提升服务/专用 helper 解密 v20（Edge/Ego 风格） | 否 | 可能可以 | **不采用**：越过 Chrome 调用者路径校验，属于绕过应用身份验证 |
| 只装来源端一个扩展 + 目标原生 Cookie 写入 | 是（仅来源端） | **是**（来源 Chrome 自己通过 `chrome.cookies` 解密） | **推荐**：不碰密文/密钥，官方 API |
| 复用用户已有 Chrome 会话（不迁移） | 否 | 不适用 | **推荐用于 Agent 场景**：设备绑定/WebAuthn 也能用 |

结论：

- **在本轮调查范围内，完全零扩展、零提升、且能覆盖现代 Chrome v20 的一键导入：不存在合规实现。**
- **一个来源扩展 + 目标原生写入**可以覆盖 v20，是 Browser CLI 最现实的一键导入方案。
- 若用户只是想让 Agent 使用现有登录态，**直接复用已有 Chrome 会话**比迁移更安全、覆盖更广。

### (d) 各方案操作步骤、安全边界、成功率、开发成本

见 §4 对比表。核心结论：

- 上游 Chromium Importer：Cookie 成功率 0%，不推荐扩展。
- Edge 原生导入：有官方策略与实现，v10 成功率高，v20 未知/可能依赖其提升导入器；不在我们的可控范围。
- ego(lite) 原生导入：功能面最广，但会关闭来源浏览器、可能 UAC、v20 可能丢弃；不能作为 Browser CLI 的合规范本。
- 单来源扩展 + 原生目标：本地测试来源 API 读取 3/3（HttpOnly/Session/Partitioned），目标写入 3/3、登录/重启通过；**真实 inso Chrome 156 v20 也 PASS**：已安装 Web Store 扩展 “Get cookies.txt LOCALLY” 0.7.2 导出当前标签 9 条 cookie，目标 Browser CLI 写入 9/9，WorkBuddy 登录 + 重启 + Agent `js`/`snapshot` 均通过。生产需 Web Store/企业策略安装；BrowserPilot 的 unpacked 开发版仍受开发者模式限制。
- 双扩展 + Broker：协议级通过，浏览器内未实测；维护成本最高，仅保留候选。
- 复用已有会话：未实测；从安全和覆盖率看应作为默认产品方向。

### (e) 哪些场景应直接复用已有 Chrome 会话，而不是迁移？

- 站点使用 **WebAuthn/Passkey、设备绑定、mTLS、DPoP、IP/风控绑定**：Cookie 迁移后仍可能失效，复用会话最稳。
- **银行、支付、企业 SSO、Google/Microsoft 账号、内部 admin 后台**：不建议复制 Cookie/密码；应让 Agent 在用户授权的同一 Profile/Space 内操作。
- 用户只是“让 Agent 用我已有的登录”而非“我要换浏览器”：迁移是多余的数据复制。
- 来源浏览器仍会长期使用、Cookie 频繁轮换：一次性迁移很快过期，复用会话更合理。
- 需要强隔离的高风险 Agent：反过来，应该用**独立 Profile**，不要复用主会话；这类场景才需要迁移或重新登录。

---

## 1. 证据基础

### 1.1 Chromium 上游（`D:\c\src`，156.0.8067.0）

独立复核（与上一轮一致）：

- `components/user_data_importer/common/importer_data_types.h:27`
  ```cpp
  COOKIES = 1 << 2,  // Not supported yet.
  ```
- `chrome/utility/importer/importer_creator.cc` 只创建 `TYPE_IE`、`TYPE_EDGE`、`TYPE_FIREFOX`、`TYPE_SAFARI`、`TYPE_BOOKMARKS_FILE`；没有 `TYPE_CHROME`/`TYPE_BRAVE`。
- `chrome/browser/importer/importer_list.cc:56`：`edge.services_supported = FAVORITES;`（仅旧 EdgeHTML 收藏夹）。
- Firefox：`HISTORY | FAVORITES | AUTOFILL_FORM_DATA`，Windows 加 `PASSWORDS`；**仍无 Cookie**。
- `chrome/browser/importer/firefox_importer.cc` 没有 `cookies.sqlite` 读取代码。

因此：**上游 Importer 对 Chrome/Edge/Brave 的 Cookie 迁移为 0；这不是配置问题。**

### 1.2 Microsoft Edge 156.0.4314.50（Windows）

官方策略文档 `ImportCookies`：

> Allows users to import Cookies from another browser into Microsoft Edge.
> This policy currently manages Google Chrome import (on Windows 7, 8, and 10 and on macOS).

`msedge.dll` 静态字符串：

```
..\..\chrome\utility\importer\edge_cookie_importer.cc
..\..\chrome\utility\importer\edge_cookie_importer_export_process_host.cc
LaunchExportProcessAndWaitForResult
cookie_exporter.exe
cookies.json
Microsoft.ImportProfile.Cookies.ExportProcessLaunchError
Microsoft.ImportProfile.Cookies.ExportProcessReturnError
Microsoft.ImportProfile.Cookies.JSONFileDeserializationError
msEdgeImportCookiesFromChrome
Microsoft.OSCrypt.AsterImportAppBoundProvider.*
Microsoft.OSCrypt.Async.DataEncryptionWithEdgeImportKey.Result.Cookies
```

`cookie_exporter.exe` 是 Microsoft 签名的 .NET helper（122,184 字节，`ExportSpartanCookies`），由 Edge 的 export process host 启动并产出 `cookies.json`。这表明 Edge 的原生导入使用**独立导出进程 + `cookies.json`**，而不是来源扩展；`DataEncryptionWithEdgeImportKey` 还提示导入数据会用 Edge 的 import key 重新加密。

本机 Edge 安装带有 OEM/预装扩展，打开 `edge://settings/importData` 时被重定向到第三方页面；因此本轮没有做 Edge UI e2e，只用 Microsoft 策略文档 + `msedge.dll` 字符串。

**未验证**：Edge 对 Chrome v20 App-Bound Cookie 的实际成功率。`AsterImportAppBoundProvider` 的存在提示 Edge 有专门的“导入其它浏览器 App-Bound 数据”的提供器；这很可能依赖 Microsoft 自己的提升服务/导入密钥。我们**不准备复制**这条路径，因为它需要越过 Chrome 的调用者校验。

### 1.3 官方 ego(lite) 0.6.2.5

详见 `docs/ego-lite-windows-import-test-2026-10-30.md`。要点：

- 自研 `ego/browser/data_import/*`，覆盖 Cookies/Login Data/History/Bookmarks/Extensions/Sessions/Profile。
- 无来源扩展需求；但 `source_closed_by_ego` / `source_close_requests` 表明会关闭来源浏览器。
- `app_bound_uac_denied` / `app_bound_setup_missing` / `app_bound_caller_rejected` / `success_discarded_v20_values_*`：v20 可能请求 UAC，失败则丢弃。
- 本轮未完成 Chrome 登录态 e2e；不能把官方宣传或静态字符串当 PASS。

### 1.4 我们自己的最小链路

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 本地 HTTPS 测试站登录（隔离 Chrome Profile，v10） | 成功；3 个 Cookie：`sid`（HttpOnly/Lax/持久）、`sessonly`（HttpOnly/Strict/Session）、`part`（HttpOnly/Secure/SameSite=None/Partitioned） | `D:\work\wt\egolite-evidence\logs\chrome-native-path-results.json` |
| 来源侧读取 | `Storage.getCookies`/`chrome.cookies.getAll` 语义读取 3/3，含 HttpOnly/Session/Partitioned | 同上 |
| 目标原生写入 | 原型 `POST http://127.0.0.1:18082/import` → `Storage.setCookies`，`applied=3, failed=0` | 同上 |
| 目标站点登录 | `LOGGED IN`，cookies seen `sid,sessonly,part` | 同上 |
| 目标重启后 | `LOGGED IN`，cookies seen `sid,part`；Session Cookie 按预期丢失 | 同上 |
| 来源扩展在 branded Chrome 中执行 | **unpacked BrowserPilot BLOCKED**：Chrome 156 忽略 `--load-extension`；CDP `Extensions.loadUnpacked` 返回 id，但扩展页被 `ERR_BLOCKED_BY_CLIENT`。**已安装的 Web Store 扩展可以执行**，见 1.6。 | 同上 + 1.6 |
| Browser CLI 目标 | **测试配置下 PASS**：`out/WinDev` 的 `chrome.exe` 以 `--in-process-gpu --disable-gpu-compositing`（**未用** `--no-sandbox`）启动；来源 3/3 Cookie 写入 Browser CLI CookieStore，重启后 `LOGGED IN`（`sid`+`part`，Session Cookie 按预期丢失）；**配对码/用户授权流程、Agent Space 未验证** | `browser-cli-cookie-acceptance.json`、`browser-cli-status.txt` |

注意：测试 Chrome 使用自定义 `--user-data-dir`，App-Bound Encryption 不启用，因此 Cookie 前缀为 **v10**；本轮**没有测试 v20**。

### 1.5 真实 Chrome v20 Profile 复制实测（2026-10-31，新增）

对 `inso` Profile 做只读复制并用 stock Chrome 156 启动，得到决定性反证：

| 检查 | 结果 |
| --- | --- |
| 源 Cookie DB | 1780 行，**全部 v20**；`SESSDATA` 等 Bilibili 登录 cookie 存在且未过期（2027-02-27） |
| 副本 Cookie DB | 与源**逐字节一致**（884736 字节，SHA-256 相同，1780 行） |
| 副本 `Local State` os_crypt | `encrypted_key` / `app_bound_encrypted_key` 与源字段哈希一致 |
| 副本启动（`--user-data-dir=D:\work\wt\inso-copy-20261031`） | 页面未登录；CDP 仅返回 39 条 cookie |
| Bilibili 登录 cookie | `SESSDATA`、`DedeUserID`、`bili_jct` **不在** CDP 返回结果中 |
| 根因 | `GetAppBoundEncryptionSupportLevel()` 对非默认数据目录返回 `kNotUsingDefaultUserDataDir`；provider 返回 `kTemporarilyUnavailable`，v20 无 DPAPI fallback |

结论：**现代 Chrome v20 Profile 不能用“复制 Profile 到任意目录再启动”保留登录态**；
这不是复制遗漏或 cookie 过期。该结论把“原生复制 + 第三方解密”从可行方案中排除，
只剩来源浏览器自身解密（扩展/官方 API）、复用现有会话、或目标内重新登录。

另一个实测边界：真实 Chrome 156 中 BrowserPilot 是 unpacked 扩展，而
`extensions::features::kExtensionDisableUnsupportedDeveloper` 默认启用且该 Profile
未开启开发者模式，BrowserPilot 的 SW 未运行、native host 未启动。Branded Chrome
还会直接忽略 `--load-extension`（`extension_service.cc` 对
`GOOGLE_CHROME_BRANDING` 提前 return）。但**已安装的 Web Store 扩展不受这条
unpacked 限制**；1.6 用已安装的 “Get cookies.txt LOCALLY” 完成了真实登录态导入。

### 1.6 真实 inso 登录态导入 PASS（2026-10-31，新增）

在**不复制、不解密、不关闭真实 Chrome**的前提下，用来源 Chrome 自己运行的
Web Store 扩展导出当前标签页的 cookie，再写入 Browser CLI 目标 Profile：

| 步骤 | 实测结果 |
| --- | --- |
| 来源 Chrome | 真实 `inso` Profile，PID 39264，未重启、未关闭；当前标签为 `www.workbuddy.cn` 登录成功页 |
| 来源扩展 | 已安装的 “Get cookies.txt LOCALLY” 0.7.2（ID `cclelndahbckbenkjhflpdbgdldlbecc`，Web Store，`cookies` 权限） |
| 导出 | 扩展 popup 选择 JSON → Copy，9 条 cookie（`www.workbuddy.cn` / `.workbuddy.cn`），经剪贴板交给本地导入脚本；未写文件 |
| 目标 | Browser CLI 156.0.8067.0，`.manual-profile-normal`，CDP 9333；`Storage.setCookies` 后 `verifiedPresent=9` |
| 目标页面 | `https://www.workbuddy.cn/` 显示 `178****1756`、`退出登录`；`loggedIn=true` |
| 重启后 | 通过 CDP `Browser.close` 关闭目标并用同一 Profile 重启；再次打开 WorkBuddy 仍为 `loggedIn=true` |
| Agent 侧 | BrowserPilot host（target，47001）`js` 返回 `{loggedIn:true,id:true}`；`snapshot` L0 成功返回 WorkBuddy 标题 |
| 安全边界 | 未读取/输出 cookie 值到项目文件；未调用 elevation service；未改 Chrome 默认目录；未上传；来源 Chrome 未关闭 |

结论：**“一个来源扩展 + 目标原生 CookieStore”在 Windows Chrome 156 真实 v20
Profile 上成立**。限制是来源扩展必须是 **Web Store/企业策略安装**（或用户手动
开启开发者模式加载 unpacked）；BrowserPilot 的 unpacked 开发版在 developer mode
关闭时仍不可用。产品化应发布/签名一个最小 Web Store 扩展，或复用用户已有会话，
不能依赖 `--load-extension`。

---

## 2. DPAPI / App-Bound 再调查（关键结论）

### 2.1 v10（DPAPI）

- Cookie 密文 = `Encrypt(SHA256(host_key) || value)`，密钥在来源 `Local State` 的 `os_crypt.encrypted_key`（`DPAPI` + base64）。
- DPAPI 的作用域是**当前 Windows 用户**；同用户的另一个进程理论上可以 `CryptUnprotectData` 解出密钥。
- 技术可行性：**可行**（v10-only）。
- 合规性：**不能由我们单方面判定为“允许”**。它读取的是另一个应用的用户级加密数据；即使 Chrome 的 v10 从未打算阻止同用户进程，产品仍需用户明确授权、隐私说明和法律/安全评审。本任务红线明确禁止本轮实现/测试解密，因此**本轮不实现、不验证**。
- 结论：Browser CLI 可以新增“v10-only 原生迁移模块”，但它是**产品/法律决策**，不是纯技术问题；不建议在 P1 默认开启。

### 2.2 v20/v22（App-Bound Encryption）

Chromium 源码确认：

- `chrome/browser/os_crypt/app_bound_encryption_provider_win.h:50`：`kAppBoundDataPrefix[] = "v20"`。
- 默认保护级别是 `PROTECTION_PATH_VALIDATION_WITH_ISOLATION`（`kEncryptWithIsolatedState` 默认开启）。
- 解密时 `DecryptData` 从密文前缀取出 validation data，并调用 `ValidateData(process, data)`；`caller_validation.cc` 用 `QueryFullProcessImageNameW` 取得**真实调用进程路径**，经 `MaybeTrimProcessPath` 后与来源路径比较。
- 来源路径是 Chrome 安装目录（`C:\Program Files\Google\Chrome\...`）。Browser CLI 的 exe 路径不同 → **校验失败**。
- `PROTECTION_PATH_VALIDATION_WITH_ISOLATION` 还要求调用进程带 Installer isolation 安全属性，普通第三方进程不满足。
- 更早的一层约束：`GetAppBoundEncryptionSupportLevel()` 要求 `IsUsingDefaultDataDirectory()` 为真；显式 `--user-data-dir=<副本>` 会返回 `kNotUsingDefaultUserDataDir`，provider 直接 `kTemporarilyUnavailable`，v20 连调用 elevation service 都不会尝试。这就是“复制 Profile 后启动也读不到登录 cookie”的直接原因。

因此：

- **Browser CLI 不能解密 v20**；复制 `Local State`、伪造路径、调用 Chrome 的 elevation service 都会失败（或被我们禁止）。
- Edge/Ego 若真能迁移 v20，必然使用了**提升服务/专用导入 provider/受信任路径 helper** 等越过调用者校验的机制；这属于“绕过应用身份验证”，本任务明确禁止，不能作为 Browser CLI 的实现依据。
- 唯一合规的 v20 路径是：**让来源 Chrome 自己解密**——即来源端扩展用 `chrome.cookies` API 读出明文，或用户手动导出；或直接复用来源会话。

### 2.3 密码

- Chromium `Login Data.password_value` 同样受 v10/v20 保护；上游 Importer 只对 Firefox/IE 有效。
- 合规路径：来源浏览器设置页“导出密码”CSV → 目标导入；或复用会话/重新登录。
- 不建议做任何自动解密；Passkey/WebAuthn 无法通过文件迁移。

### 2.4 书签/历史/扩展/Profile

| 数据 | 原生迁移可行性 | 建议 |
| --- | --- | --- |
| 书签 | 高（JSON，明文） | 可做原生导入；合并/备份/原子写 |
| 历史 | 中（SQLite，schema 敏感） | 只读快照 + 导出；不建议直接写目标 DB |
| 扩展 | 低/不安全（复制目录绕过安装验证） | 商店重装；不迁移扩展数据 |
| Profile 整包 | 中/高风险（单写者、设备绑定、v20） | 仅作为 Ego 式“克隆”候选，不推荐默认 |
| Tabs/会话 | 低（SNSS 内部格式） | 扩展 `chrome.tabs.query` 或复用会话 |

### 2.5 数据类别与限制（直接回答“哪些能直接迁移/哪些需要来源协助/哪些受限制”）

| 数据 | 能否直接迁移 | 是否需要来源浏览器协助 | 主要限制 |
| --- | --- | --- | --- |
| 书签 | 可以（`Bookmarks` JSON） | 否 | 合并/备份/冲突；加密书签需目标未运行 |
| 历史 | 部分（SQLite 只读快照） | 否 | schema 版本敏感；不建议直接写目标 DB |
| Cookie（v10） | 技术上可能（复制 + DPAPI；未实现/未验证） | 否（同用户 DPAPI） | 产品/法律授权；不是“零风险” |
| Cookie（v20/v22） | 不可由第三方直接解密 | **是**（来源扩展/API，或来源浏览器自身） | App-Bound 调用者路径 + isolation 校验；设备绑定仍可能失效 |
| 密码 | 不可自动解密 | **是**（官方 CSV 导出/导入） | v10/v20 加密；Passkey 不可迁移 |
| 自动填充 | 只能导出/报告 | 否（读取 `Web Data`） | 无官方导入 API；直接写目标 DB 风险高 |
| Tabs/会话 | 不能可靠迁移 | **是**（`chrome.tabs.query` 或手动） | SNSS 内部格式；表单状态不可恢复 |
| 扩展 | 不建议文件迁移 | **是**（商店重装/官方导入） | 复制目录绕过安装验证、签名/策略检查 |
| Profile 整包 | 可复制（Ego 式） | 否 | 单写者、设备绑定、v20、扩展/缓存污染；不推荐默认 |

结论：**能“零来源协助”直接迁移的只有书签/历史（以及被明确授权的 v10 Cookie）；v20 Cookie、密码、Tabs、扩展都需要来源浏览器/用户协助，或干脆复用会话。**

---

## 3. 推荐的简化 Cookie 方案（不扩 Broker）

### 3.1 首选：用户在浏览器内选择来源 Profile，一键导入

分两层：

1. **书签/历史**：Browser CLI 原生读取（书签 JSON、History 只读快照），用户选择 Profile 后导入；不涉及密钥。
2. **Cookie/登录态**：
   - 若来源是 **v10**，可选“原生 v10-only 迁移”（需产品/法律批准）；
   - 若来源是 **v20**，不提供原生解密；改为“来源扩展读取 + 目标原生写入”或“复用会话”。

### 3.2 推荐的一键 Cookie 方案：只装来源端一个扩展

```
来源 Chrome/Edge/Brave（用户已登录）
┌──────────────────────────────┐
│ source-extension (MV3)       │  用户点击“导入当前站点”
│ chrome.cookies.getAll(domain)│  （HttpOnly/Session/Partitioned 均可读）
└──────────────┬───────────────┘
               │ POST 127.0.0.1:<one-shot-port>
               │ x-bp-token: 用户从 Browser CLI 终端读取的配对码
               ▼
┌──────────────────────────────────────────────┐
│ Browser CLI 原生导入命令（新增，非 Broker）  │
│ - 仅监听 127.0.0.1，随机端口，一次性 token    │
│ - 内存中转，不落盘、不写日志                   │
│ - 校验 domain/来源，限制条数与大小             │
│ - 通过浏览器自身 CookieStore 写入             │
│   （native/mojo 或私有 CDP pipe，不写 SQLite）│
└──────────────────────────────────────────────┘
               │
               ▼
        目标 Profile 已登录（无需目标扩展）
```

安全边界：

- 来源扩展只读，不上传、不落盘；用户必须点击；按域名选择。
- 目标原生接口只绑定 loopback；token 一次性/短 TTL；内存 only；不记录 Cookie 名/值/域名。
- 目标写入走浏览器自身 CookieStore，由目标 OSCrypt 加密；不直接改 `Cookies` SQLite。
- 不解除 HttpOnly/SameSite/Partitioned 语义；保留 `partitionKey`。
- 不承诺“写入=Cookie 成功=登录成功”；仍要三态结果（写入数、页面验证、用户确认）。

原型状态：

- 扩展代码：`prototype/one-source-extension/`（manifest/background/popup）。
- 目标原型：`prototype/native-target.mjs`（loopback + `Storage.setCookies`，仅作 Browser CLI 原生接口的替身）。
- 已验证：来源读取 3/3、目标写入 3/3、登录成功、重启后持久 Cookie 仍有效；**来源扩展本身未在 branded Chrome 中执行**（安装限制），需手工“加载已解压”/商店/策略安装后再补一次 e2e。

### 3.3 替代：BrowserPilot 在用户授权后直接使用已有 Chrome 会话

适用：用户不想复制账号数据，或站点设备绑定/风控严格。

- 不迁移 Cookie；Agent Space 在用户授权的 Chrome Profile 内运行。
- 安全关键是“**同一 Profile、不同 Space**”：用 Space/窗口/前台 lease 隔离控制权，而不是靠复制 Profile。
- 技术约束：
  - Chrome 136+ 不允许对默认 Profile 开 `--remote-debugging-port`；不能靠调试端口接管用户真实 Chrome。
  - 应通过用户安装的 BrowserPilot/Chrome 扩展 + 官方 API 控制标签页；或由用户显式选择一个专用 Chrome 实例/Profile。
  - 不得两个进程并发直接读写同一 Profile；同一 Chrome 进程内多窗口是允许的。
- 产品建议：默认“同一授权 Profile”，高风险 Agent 才用独立 Profile；不要固化为“Normal 与 Agent 永远不同 Profile”。

### 3.4 双扩展 + Broker 的定位

- 只作为候选/回退：当目标端暂时没有原生 Cookie 写入接口时，目标扩展 `chrome.cookies.set` 是可行替代。
- 不继续扩大 Broker；不把它作为正式交互。
- 维护成本：两端扩展 + 配对码 + Origin allowlist + 版本兼容 + 浏览器商店审核；长期不如“单来源扩展 + 原生目标”。

---

## 4. 方案对比表

| 方案 | 操作步骤 | 安全边界 | 成功率/证据 | 开发成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Chromium 上游 Importer | 设置页选 Firefox/IE/旧 Edge | 官方；不碰密钥 | Cookie 0%（源码明确 Not supported）；Chrome 不是来源 | 低（已有） | 不能解决 P1 Cookie |
| Edge 原生 ImportCookies | Edge 设置 → 导入 → 选 Chrome | 原生；可能使用 Edge 提升导入器；v20 机制未公开 | 策略存在；e2e 未在本轮验证；v10 预计高，v20 未知 | 不可复用（闭源） | 竞品证据；不能直接用于 Browser CLI |
| ego(lite) 原生导入 | onboarding/CLI 选 browser+profile | 会关闭来源浏览器；可能 UAC；v20 可能丢弃；不看扩展 | 功能面最广；**本轮 Chrome e2e blocked**；不能宣称成功 | 不可复用（闭源） | 反证“双扩展必要论”；但不合规/不适合照搬 |
| 原生复制 Profile + v10 DPAPI | 选 Profile → 复制 → 解密 v10 → 写目标 | 需用户授权；不碰 v20；不注入 | v10 技术可行；v20 0%；未实现 | 中高（复制/解密/回滚/安全评审） | 可选 v10-only；不建议 P1 默认 |
| 原生 v20 提升服务/helper | 提升服务/受信任路径 helper 解密 | **越过 Chrome 调用者校验** | Edge/Ego 可能这么做；我们不验证 | 高 + 合规风险 | **禁止** |
| 单来源扩展 + 原生目标 | 装一个来源扩展 → 点击 → 配对 → 目标原生写入 | 官方 `chrome.cookies`；loopback；内存 only；无目标扩展 | 来源 API 读 3/3（扩展未执行）、目标写 3/3（Chrome/Browser CLI）、登录/重启通过；扩展安装未在 branded Chrome 执行 | 中（扩展 + 原生命令 + 安全 + 测试） | **推荐** |
| 双扩展 + Broker | 两端装扩展 + 配对码 + Broker | 官方 API；但两端安装/维护 | 协议级通过；浏览器内未实测 | 高（已有 Broker + 两端扩展） | 仅候选/回退 |
| 复用已有 Chrome 会话 | 用户授权 → Agent 在现有 Profile/Space 操作 | 不复制数据；靠 Space/lease 隔离 | 未实测；覆盖设备绑定/Passkey 最好 | 中高（BrowserPilot 集成/权限） | **Agent 场景首选** |

成功率说明：

- “3/3”只代表本地测试站点的三个 Cookie；**不代表真实站点登录成功率**。
- 设备绑定、WebAuthn、IP 风控、服务端 session 轮换都可能导致迁移后仍登录失败；必须保留三态结果和用户实际验证。

---

## 5. 建议的下一阶段

1. **产品默认**：Agent 场景优先“复用用户授权的已有 Chrome 会话”，不做 Cookie 复制；用 Space/前台 lease 隔离控制权。
2. **需要独立 Profile 时**：实现“单来源扩展 + Browser CLI 原生 Cookie 写入”：
   - 新增原生命令（例如 `browser-cli import-cookies --from-extension`），只监听 loopback、一次性配对码、内存 only；
   - 目标写入走浏览器自身 CookieStore（native/mojo），不写 SQLite、不扩展 Broker；
   - 来源扩展支持 Chrome/Edge/Brave（Chromium `chrome.cookies`）与 Firefox（`browser.cookies`，需另做 manifest）；
   - 结果三态：`cookiesWritten` / `siteLoginVerified` / `userConfirmed`，禁止用写入数推断登录成功。
3. **书签/历史**：原生读取 + 备份/合并；历史只导出，不直接写目标 DB。
4. **密码**：只走官方 CSV 导出/导入；不做自动解密；Passkey/设备绑定明确提示不可迁移。
5. **扩展**：商店重装；不复制扩展目录。
6. **ego(lite)/Edge 对比**：在独立 Windows 用户/VM 中补做 e2e，重点记录：
   - 是否自动关闭 Chrome；
   - 是否 UAC；
   - v20 Cookie 是否被 `success_discarded_*` 丢弃；
   - 重启后登录是否仍有效。
7. **Browser CLI 构建**：默认启动在本环境 exit 3；使用 `--in-process-gpu --disable-gpu-compositing`（与正在运行的 BrowserPilot 实例一致，未用 `--no-sandbox`）可以运行，并已用 CDP 替身完成 Cookie 写入/登录/重启验证。仍需实现正式原生命令并补 Agent Space 验收；不得把 CDP 替身写成产品命令已交付。

---

## 6. 未验证/blocked 清单（不得写成 PASS）

1. ego(lite) 真实 Chrome Cookie/登录态迁移（本机 blocked；需独立 Windows 用户/VM）。
2. ego(lite) 重启后会话仍有效（未执行导入）。
3. Edge `ImportCookies` 对 Chrome v20 的真实成功率（未 e2e）。
4. v20 App-Bound Cookie 的任何解密/迁移（明确不做；不是能力缺口）。
5. 来源扩展执行：**BrowserPilot unpacked 在 branded Chrome 156 中 blocked**（`--load-extension` 被忽略；CDP `loadUnpacked` 页面被 `ERR_BLOCKED_BY_CLIENT`）；但**已安装 Web Store 扩展执行已 PASS**（Get cookies.txt LOCALLY，见 1.6）。产品需 Web Store/策略安装。
6. Browser CLI 正式原生命令未实现；Browser CLI 目标侧验证使用 CDP `Storage.setCookies` 作为原生命令的替身（CookieStore 写入/持久化可行，但命令本身未交付）。
7. BrowserPilot **Agent Space 新窗口**未单独开窗验收；但同一目标 Profile 的登录标签已由 Agent `js`（`loggedIn:true`）与 `snapshot` L0 验证，Cookie 是 profile 级共享。Browser CLI 重启后登录已在测试配置下验证。
8. 真实站点/账号：在用户明确授权后用 WorkBuddy 真实登录态完成单站点 PASS；未做多站点/多账号矩阵。
9. Firefox 源扩展（未实现/未测）。
10. 密码/Passkey/设备绑定会话迁移（未实现；预期不可行）。

---

## 7. 证据路径

- Ego 实测：`docs/ego-lite-windows-import-test-2026-10-30.md`
- Ego 运行时 JSON：`D:\work\wt\egolite-evidence\logs\ego-runtime-results.json`
- Chrome 原生链路：`D:\work\wt\egolite-evidence\logs\chrome-native-path-results.json`
- Browser CLI 状态：`D:\work\wt\egolite-evidence\logs\browser-cli-status.txt`
- Edge 静态证据：`D:\work\wt\egolite-evidence\logs\edge-static-evidence.txt`
- 测试站点：`D:\work\wt\egolite-evidence\testsite\server.mjs`
- 原型：`prototype/one-source-extension/`、`prototype/native-target.mjs`
- Chromium 源码（只读）：`D:\c\src`
  - `components/user_data_importer/common/importer_data_types.h:27`
  - `chrome/utility/importer/importer_creator.cc`
  - `chrome/browser/importer/importer_list.cc:56,146-153`
  - `net/extras/sqlite/sqlite_persistent_cookie_store.cc:316,666-690`
  - `chrome/browser/os_crypt/app_bound_encryption_provider_win.h:50`
  - `chrome/browser/os_crypt/app_bound_encryption_provider_win.cc:GetCurrentProtectionLevel`
  - `chrome/elevation_service/caller_validation.cc:ValidatePath/GeneratePathValidationData`
  - `chrome/elevation_service/elevator.cc:DecryptData`
