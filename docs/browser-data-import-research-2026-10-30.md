---
type: ResearchReport
status: superseded-by-competitive-report-2026-10-30
generated: { by: zcode, at: 2026-10-30T00:00:00+08:00 }
stale_after: 2027-01-30
---

# Browser CLI 首次启动数据导入：技术调查报告

日期：2026-10-30
范围：P1「从其他浏览器导入登录态与用户数据」第一阶段（研究 + MVP）
Chromium 调查对象：`D:\c\src`（只读；156.0.8067.0，与 `D:\work\browsercli\chromium\VERSION` 一致）
实现 worktree：`D:\work\wt\bp-import`（分支 `agent/p1-browser-data-import`）
结论状态：**部分可实现；Cookie/密码/标签页的核心路径仍为 blocked，已给出可执行的替代方案，未做任何越过安全边界的操作。**

---

## 0. 结论摘要

1. **Chromium 自带 Importer 不支持导入 Cookie**。`user_data_importer::ImportItem` 明确写着
   `COOKIES = 1 << 2, // Not supported yet.`
   （`components/user_data_importer/common/importer_data_types.h:27`）。整个 importer 没有 Cookie 读写代码。
2. Chromium 自带 Importer 在 Windows 上只支持 **IE、旧版 Edge（EdgeHTML/ESE）收藏夹、Firefox、bookmarks.html**；
   **不支持 Chrome、Chromium Edge、Brave** 作为来源。
   （`chrome/browser/importer/importer_creator.cc`、`importer_list.cc:56`、`edge_importer_utils_win.cc`）
3. Firefox 是唯一被 Chromium 原生完整支持的现代来源：历史、书签、密码（NSS）、自动填充、搜索引擎；
   **仍不含 Cookie**（`chrome/browser/importer/importer_list.cc:145-153`、`chrome/utility/importer/firefox_importer.cc`）。
4. Chrome 的 Cookie 值在 Windows 上以加密形式存放：`v10`（DPAPI）或 `v20`（App-Bound
   Encryption）。v20 只能由 Chrome 自己的 elevation service 解密，且密文绑定调用进程路径；
   第三方进程、甚至不同安装路径的 Chrome 都无法解密。Edge/Brave 同为 Chromium 系且各有自己的
   密钥/服务实现，本环境未逐一验证；统一按“不可解密、不可复制”处理。
   本工具**不提取、不解密、不复制** Cookie 密钥或密文。
5. 双扩展 + loopback Broker **不是唯一方案**：Edge 有原生 `ImportCookies`/cookie exporter，
   官方 ego(lite) 也带自研原生导入模块；更简方案是“来源端一个扩展读取 + Browser CLI 原生
   Cookie 写入”。双扩展 Broker 仅保留为候选，不作为正式交互。详见
   `browser-import-competitive-report-2026-10-30.md`。
6. 第一阶段 MVP 已实现：Profile 发现、只读盘点、迁移计划、书签/历史/自动填充导出、书签原子写入目标
   Profile、三态结果记录、拒绝/回滚/备份/重试/重新导入。Cookie/密码/历史/标签页按明确状态返回
   `blocked` / `official-flow-required` / `export-only`，不会伪 PASS。

---

## 1. 三个“成功”必须分开定义

| 状态 | 含义 | 本工具如何记录 | 是否可作为“登录成功” |
| --- | --- | --- | --- |
| 数据复制成功 | 文件/记录被写入目标 Profile 或导出包 | `result.json.dataCopied.<item>` | 否 |
| Cookie 导入成功 | `chrome.cookies.set` 成功写入目标 Profile | `result.json.cookieImported.status`（`imported` / `partially_imported`） | 否 |
| 实际页面登录态验证成功 | 用户在目标浏览器实际打开网站并确认仍处于登录状态 | `result.json.loginVerified.status`，只能由用户显式 `--confirm-user-action` 写入 | 是（且仅限被确认的域名） |

任何“有 Cookie 行数”“set 返回非空”“文件存在”都不能推断为登录成功。设备绑定、IP 绑定、WebAuthn/passkey、
TLS 客户端证书、服务端风控都可能让会话失效。

---

## 2. Chromium 原生 Importer 能力（源码依据）

### 2.1 可导入项枚举

`components/user_data_importer/common/importer_data_types.h:23-32`：

```cpp
enum ImportItem {
  NONE = 0,
  HISTORY = 1 << 0,
  FAVORITES = 1 << 1,
  COOKIES = 1 << 2,  // Not supported yet.
  PASSWORDS = 1 << 3,
  SEARCH_ENGINES = 1 << 4,
  HOME_PAGE = 1 << 5,
  AUTOFILL_FORM_DATA = 1 << 6,
  ALL = (1 << 7) - 1
};
```

`chrome/browser/first_run/first_run.cc:483-491` 的自动导入映射同样只有
AUTOFILL/BOOKMARKS/HISTORY/HOMEPAGE/PASSWORDS/SEARCH_ENGINES，没有 Cookie。
`chrome/common/importer/profile_import.mojom` 的 `ProfileImportObserver` 也没有任何 Cookie 消息。

**结论：不是“配置没开”，而是 Chromium 产品内不存在 Cookie 导入实现。**

### 2.2 支持的来源

`chrome/utility/importer/importer_creator.cc` 的 `CreateImporterByType` 只创建：

| ImporterType | 平台 | 说明 |
| --- | --- | --- |
| `TYPE_IE` | Windows | IE 收藏夹/历史/搜索 |
| `TYPE_EDGE` | Windows | 旧版 Edge（UWP `spartan.edb`）收藏夹 |
| `TYPE_FIREFOX` | 非 ChromeOS | 历史/书签/密码/自动填充/搜索 |
| `TYPE_SAFARI` | macOS | Safari 数据 |
| `TYPE_BOOKMARKS_FILE` | 全平台 | 用户选择的 bookmarks.html |

没有 `TYPE_CHROME`、没有 `TYPE_BRAVE`。

Windows 来源检测 `chrome/browser/importer/importer_list.cc:40-70`：

- Edge：`importer::EdgeImporterCanImport()` → 检查
  `%LOCALAPPDATA%\Packages\microsoft.microsoftedge_8wekyb3d8bbwe\AC\MicrosoftEdge\User\Default`
  （`chrome/common/importer/edge_importer_utils_win.cc:42-52`）。
  这是 **EdgeHTML 旧版** 路径，`spartan.edb`；不是 Chromium Edge 的
  `%LOCALAPPDATA%\Microsoft\Edge\User Data`。
- Edge 的 `services_supported` 只有 `FAVORITES`（`importer_list.cc:56`）。
- Firefox：`HISTORY | FAVORITES | AUTOFILL_FORM_DATA`，非 macOS 还加 `PASSWORDS`
  （`importer_list.cc:145-153`）。

### 2.3 Firefox 导入实现细节

`chrome/utility/importer/firefox_importer.cc`：

- 先复制再读取：`GetCopiedSourcePath()` 把 `places.sqlite` 等复制到临时目录
  （`:734-745`），历史查询 `moz_places JOIN moz_historyvisits`（`:187-192`）。
- 书签读取 `moz_bookmarks`、`moz_items_annos`、`moz_places`（`:324-453`）。
- 密码：初始化 NSS，读取 `logins.json`（`:466-468`），用 `nss3.dll` 解密（`nss_decryptor_win.cc`）。
- 自动填充：`formhistory.sqlite` 的 `moz_formhistory`（`:493-503`）。
- **没有 cookies.sqlite 读取代码**。

Chromium 在导入 Firefox 前会尝试获取 Firefox profile 锁
（`chrome/browser/importer/external_process_importer_host.cc:155-176`，`FirefoxProfileLock`）；
拿不到锁时提示用户关闭 Firefox 或中止导入。它**不会**自动结束 Firefox 进程。

### 2.4 设置页与首次运行

- `chrome://settings/importData` 由 `chrome/browser/ui/webui/settings/import_data_handler.cc` 实现
  （`:62-78`、`:120`），只展示 `ImporterList` 检测到的来源与 `services_supported`。
- 首次运行自动导入由 `first_run.cc:467-519` 执行；`--import-passwords=<csv>` 是密码 CSV 导入开关
  （`chrome/common/chrome_switches.h:436-437`，`startup_passwords_importer.cc`）。
- 书签文件导入走 master preferences 的 `import_bookmarks_from_file`
  （`first_run.cc:142-157`、`:282-291`），不是命令行开关。

### 2.5 对 Browser CLI 的直接含义

| 目标 | 原生 Importer 能否完成 |
| --- | --- |
| 从 Chrome/Edge/Brave 导入书签/历史/密码/Cookie | **不能**（这些不是受支持来源） |
| 从 Firefox 导入书签/历史/密码/自动填充 | **能**（Windows 上密码也可，macOS 明确排除密码） |
| 从任何来源导入 Cookie | **不能**（枚举中标注 Not supported yet） |
| 从旧版 Edge 导入收藏夹 | 能（仅收藏夹，且只对 EdgeHTML 有效） |

因此 P1 不能只靠“打开 Browser CLI 的导入设置页”解决；必须自有迁移路径，或新增 Chromium 原生导入器
（见架构文档的 patch 计划）。

---

## 3. Profile 路径与数据格式

### 3.1 Chromium 系（Chrome / Edge / Brave / Chromium / Browser CLI）

用户数据根目录（Windows）：

```
%LOCALAPPDATA%\<install subdir>\User Data\
```

`chrome/common/chrome_paths_win.cc:42-47`：`DIR_LOCAL_APP_DATA` +
`install_static::GetChromeInstallSubDirectory()` + `kUserDataDirname`（`"User Data"`，
`chrome/common/chrome_constants.h:145`）。
`install_static::GetChromeInstallSubDirectory()` 由安装模式决定；Chromium 的
`kProductPathName = L"Chromium"`（`chrome/install_static/chromium_install_modes.h:24`）。

| 浏览器 | 标准 Windows 根目录 | 依据 |
| --- | --- | --- |
| Chrome | `%LOCALAPPDATA%\Google\Chrome\User Data` | 公开产品路径；本次未联网复核 |
| Edge (Chromium) | `%LOCALAPPDATA%\Microsoft\Edge\User Data` | 公开产品路径；本次未联网复核 |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | 公开产品路径；本次未联网复核 |
| Chromium / Browser CLI（当前 GN 配置） | `%LOCALAPPDATA%\Chromium\User Data` | 源码推导（上两行） |

Profile 目录命名：`Default`、`Profile 1`、`Profile 2` …
（`chrome/common/chrome_constants.h:48-49`）。`Local State` 的
`profile.info_cache` 保存目录名与显示名；`chrome/common/chrome_constants.h:81` 定义
`kLocalStateFilename = "Local State"`。

关键文件（Chromium 源码中的文件名常量）：

| 文件 | 内容 | 依据 |
| --- | --- | --- |
| `Cookies` | Cookie SQLite | `chrome/common/chrome_constants.h:60` |
| `Login Data` / `Login Data For Account` | 密码 SQLite | `components/password_manager/core/browser/password_manager_constants.cc:13-15` |
| `History` | 历史 SQLite | `components/history/core/browser/history_constants.cc:14-15` |
| `Bookmarks` | 书签 JSON | `components/bookmarks/common/bookmark_constants.cc:13-14` |
| `Web Data` | 自动填充/地址 | `components/webdata/common/webdata_constants.cc:9-10` |
| `Preferences` | 设置 JSON | 行业标准路径，Chromium 代码广泛引用 |
| `Extensions/<id>/<version>/manifest.json` | 扩展 | Chromium 扩展加载目录 |
| `Sessions/` | SNSS 会话/标签页 | Chromium session service |
| `EncryptedBookmarks2` / `EncryptedAccountBookmarks2` | 加密书签 | `bookmark_constants.cc:17-20` |

### 3.2 Firefox

`profiles.ini` 位于 `%APPDATA%\Mozilla\Firefox\profiles.ini`
（`chrome/common/importer/firefox_importer_utils_win.cc:80-92`）。
Chromium 的解析规则：`[ProfileN]`、`Path`、`IsRelative=1` 相对于 `profiles.ini` 所在目录
（`chrome/common/importer/firefox_importer_utils.cc:35-50`）。

| 文件 | 内容 | 依据 |
| --- | --- | --- |
| `places.sqlite` | 历史 + 书签（`moz_places`、`moz_historyvisits`、`moz_bookmarks`） | `firefox_importer.cc:174-453` |
| `logins.json` + `key4.db` | 密码（NSS） | `firefox_importer.cc:466-468` |
| `formhistory.sqlite` | 自动填充（`moz_formhistory`） | `firefox_importer.cc:493-503` |
| `cookies.sqlite` | Cookie（`moz_cookies`，值不加密） | 公开格式；本 MVP 只读盘点 |
| `prefs.js` | 设置 | 公开格式；本 MVP 只读取白名单摘要 |
| `sessionstore.jsonlz4` / `sessionstore-backups/` | 会话/标签页（mozlz4） | 公开格式；本 MVP 只报告存在 |
| `extensions/` | 扩展（XPI/目录） | 公开格式；本 MVP 只报告 |

Firefox 的 Cookie 值在 `cookies.sqlite` 中通常不加密，但：
- 读取它仍然需要目标侧“写入 Cookie Store”的合规通道；
- 直接写目标 Chromium 的 `Cookies` SQLite 需要目标浏览器的 OSCrypt 加密（见 §4），属于禁止路径；
- 设备绑定/服务端风控导致的会话失效与加密无关。

---

## 4. Cookie 存储格式、DPAPI 与 App-Bound Encryption

### 4.1 Cookie 表结构（Chromium 156，schema v24）

`net/extras/sqlite/sqlite_persistent_cookie_store.cc:662-690`：

```sql
CREATE TABLE cookies(
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL,
  is_persistent INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  samesite INTEGER NOT NULL,
  source_scheme INTEGER NOT NULL,
  source_port INTEGER NOT NULL,
  last_update_utc INTEGER NOT NULL,
  source_type INTEGER NOT NULL,
  has_cross_site_ancestor INTEGER NOT NULL
);
```

版本：`kCurrentVersionNumber = 24`、`kCompatibleVersionNumber = 24`
（`sqlite_persistent_cookie_store.cc:316-317`）。

字段语义要点：

- `host_key`：域（域 Cookie 带前导点，host-only 不带）。
- `top_frame_site_key` + `has_cross_site_ancestor`：Partitioned (CHIPS) 分区键。
- `samesite`：0=unspecified、1=no_restriction、2=lax、3=strict（数据库整型，读取时映射）。
- `is_persistent`/`has_expires`：Session Cookie 标记；Session Cookie 通常不跨浏览器会话持久化。
- `value` 与 `encrypted_value` 只能有一个非空（`:1025-1030` 检测同时存在会拒绝加载）。

### 4.2 加密方式

写入时（`sqlite_persistent_cookie_store.cc:1356-1372`）：

```cpp
if (crypto_) {
  EncryptString(SHA256(domain) + value, &encrypted_value);
  value = "";
} else {
  value = plaintext;
}
```

即密文 = `Encrypt( SHA256(host_key) || value )`。读取时先解密，再校验 SHA-256 前缀
（`:1040-1055`）。因此即使拿到明文，也需要重新按目标域计算哈希并用目标浏览器的密钥重新加密。

### 4.3 v10：DPAPI

- Key provider 标签 `v10`（`components/os_crypt/async/browser/dpapi_key_provider.cc:32`）。
- 密钥保存在 `Local State` 的 `os_crypt.encrypted_key`，形如 `DPAPI` + base64(DPAPI 密文)
  （`:28`、`:67-96`；`os_crypt_win.cc` 的 `kDPAPIKeyPrefix`）。
- DPAPI 默认 `CryptProtectData` 作用域是当前 Windows 用户；同一用户的其他进程理论上可以解出密钥。
  **这正是不能把“同用户可解密”当作产品权限的原因。**

### 4.4 v20：App-Bound Encryption（Chrome）

- 数据前缀 `v20`：`chrome/browser/os_crypt/app_bound_encryption_provider_win.h:50`。
- 密钥保存在 `Local State` 的 `os_crypt.app_bound_encrypted_key`（`:41`）。
- 密钥解密通过 Chrome 的 elevation service（COM，`IElevator`）完成
  （`chrome/browser/os_crypt/app_bound_encryption_win.cc:EncryptAppBoundString/DecryptAppBoundString`）。
- elevation service 在加解密时把**调用进程的可执行文件路径**作为验证数据绑定进 DPAPI
  （`chrome/elevation_service/caller_validation.cc:60-160`；`elevator.cc:100-160`）。
  路径不同即验证失败。
- 启用条件（同一文件 `:64-150`）：必须是 system install、默认 user-data-dir、本地磁盘、非漫游
  Windows profile/FSLogix、未被策略关闭。不满足时可能只读旧密文、不再新增加密。
- Provider 优先级：App-Bound 15 > DPAPI 10
  （`chrome/browser/browser_process_impl.cc:1606-1620`）。
- 注意：该源码快照把 ABE 支持级限定为 system install 等条件。即使某台机器只用 v10/DPAPI，
  也**不**意味着可以复制/解密：DPAPI 密钥对同一 Windows 用户可见，正是必须拒绝的越界路径。

**结论（fail closed）：**

- Browser CLI 作为另一个可执行文件，即使以同一 Windows 用户运行，也**不应/不能**通过 App-Bound
  校验；尝试通过复制 `Local State`、伪造路径、调用 elevation service 等方式解密都属于
  “提取/解密密钥、破坏安全边界”，本任务明确禁止。
- 我们**不实现** v10/v20 解密，不读取 `os_crypt.*` 密钥，不复制 `Cookies` 密文到目标。
- Edge/Brave 的加密实现不在本 Chromium checkout 内，无法用源码证明；按最坏情况处理
  （可能同样有 App-Bound 或厂商密钥服务），统一不解密。

### 4.5 这些限制对导入的实际影响

| 数据 | 能否仅靠文件复制迁移 | 原因 |
| --- | --- | --- |
| Chromium Cookie（v10/v20，Chrome 已由源码确认；Edge/Brave 未验证） | 否 | 需要来源浏览器密钥/elevation service；禁止解密 |
| Firefox Cookie（明文） | 否（目标写入） | 需要目标 Cookie Store 的加密写入；直接写 SQLite 被禁止 |
| Chromium 密码 | 否 | `password_value` 同样 v10/v20 加密（`login_database.cc:1096-1107`） |
| Firefox 密码 | 理论上可用 NSS 解密 | 但本工具不加载 NSS、不读取主密码；走官方导出/导入 |
| 书签/历史（明文） | 是（书签） | 书签 JSON 可安全生成；历史 DB 版本敏感，只导出 |

---

## 5. 官方扩展 `chrome.cookies` API 路径（唯一合规 Cookie 方案）

### 5.1 API 能力

`chrome/common/extensions/api/cookies.json`：

- 读取结果包含 `httpOnly`（`:36`）、`session`（`:38`）、`expirationDate`（`:39`）、
  `partitionKey`（`:41`）、`storeId`（`:40`）。
- `cookies.getAll` 支持按 `domain/name/path/secure/session/storeId/partitionKey` 过滤
  （`:110-125`）。
- `cookies.set` 支持 `httpOnly`（`:147`）、`sameSite`（`:148`）、`expirationDate`
  （省略即 Session Cookie，`:149`）、`storeId`（`:150`）、`partitionKey`（`:151`）。
- 实现侧：`cookies_helpers.cc:139` 设置 `session = !IsPersistent()`；`:151-161`
  序列化分区键。

### 5.2 能力与限制

| 能力 | 结论 | 说明 |
| --- | --- | --- |
| 读取 HttpOnly Cookie | 可以 | 扩展有 `cookies` 权限 + 对应 host 权限 |
| 读取 Session Cookie | 可以 | 返回 `session=true`，无 `expirationDate` |
| 读取 Partitioned Cookie | 可以 | 返回 `partitionKey` |
| 写入 HttpOnly / SameSite / Session | 可以 | `cookies.set` 支持 |
| 写入 Partitioned | 可以 | 必须带 `partitionKey`；API 版本需支持 |
| 跨 Profile 读取 | **不可以** | API 只作用于扩展所在 Profile 的 Cookie Store |
| 跨浏览器/跨进程 | **不可以** | 必须分别在来源/目标浏览器安装扩展 |
| 读取 incognito | 取决于用户授权 | `storeId` 区分；默认只操作普通 store |
| 绕过设备绑定 | 不可以 | 写入 Cookie 不代表服务端接受会话 |
| 静默运行 | 不可以 | 需要用户安装扩展并点击授权/发送 |

### 5.3 本仓库的桥接设计（已实现协议与 Broker，浏览器内未实测）

```
来源浏览器 (Chrome/Edge/Brave)                目标浏览器 (Browser CLI/Chromium)
┌──────────────────────────┐                 ┌──────────────────────────┐
│ source-extension (MV3)   │                 │ target-extension (MV3)   │
│  chrome.cookies.getAll   │                 │  chrome.cookies.set      │
└────────────┬─────────────┘                 └────────────▲─────────────┘
             │ POST /v1/jobs (pair + Origin)              │ GET /v1/jobs/next
             ▼                                            │ POST result
        ┌─────────────────────────────────────────────────────────┐
        │ broker.mjs  127.0.0.1 only, memory only, 10 min TTL     │
        │ 6 位配对码 + Origin allowlist + 16MB 上限 + 仅计数日志   │
        └─────────────────────────────────────────────────────────┘
```

安全约束：

- 只绑定 `127.0.0.1`；不写入磁盘；不记录 Cookie 名/值/域名，只记录 jobId 与数量。
- 每次导入需要终端打印的 6 位配对码；扩展 Origin 必须命中固定扩展 ID allowlist。
- 来源扩展只在用户点击“发送勾选域名”后发送；目标扩展只在用户点击“应用”后写入。
- 结果只上报 `applied/failed/failuresByReason`，且 `loginVerified` 强制为 `not_verified`。

**未验证项**：本环境没有启动真实浏览器，也没有在 Chrome/Edge/Brave/Browser CLI 中实际安装这两枚扩展。
已通过的是协议/Broker/字段映射/日志脱敏测试（14 项），不能宣称端到端 Cookie 迁移 PASS。

---

## 6. 密码与自动填充

### 6.1 密码

- Chromium `Login Data` 的 `password_value` 是 BLOB，写入前经 `os_crypt` 加密
  （`components/password_manager/core/browser/password_store/login_database.cc:1096-1107`、
  `:1384`）。Edge/Brave 的密码按同样的最坏情况处理（各自密钥实现未在本环境验证）。
- Chromium 原生导入密码只对 Firefox（NSS）和旧 IE 有效；Chrome/Edge/Brave 不是来源。
- 官方迁移路径：来源浏览器设置页“导出密码”生成 CSV（用户显式操作），目标浏览器设置页导入；
  Chromium 还有启动开关 `--import-passwords=<csv>`
  （`chrome/common/chrome_switches.h:437`，`startup_passwords_importer.cc`）。
  CSV 导入上限 1000 KiB（`password_importer.cc:66-70`）。
- 本工具**不读取、不解密、不导出密码值**；只统计行数与加密前缀，状态为
  `official-flow-required`。
- 设备绑定/Passkey：不可能通过 CSV/文件迁移。Passkey 属于 WebAuthn 凭据，依赖平台认证器；
  设备绑定 session（DPoP、mTLS、IP 绑定）也可能在目标端失效，必须在目标站点重新认证。

### 6.2 自动填充

- Chromium `Web Data` 的 `autofill` 表保存字段名/值（地址在 `addresses` 等表）
  （schema 见 `components/test/data/web_database/version_103.sql:10-25`；
  当前实现见 `components/autofill/core/browser/webdata/addresses/address_autofill_table.cc`）。
- 没有官方“导入自动填充”的浏览器 API；Chromium Importer 只从 Firefox
  `moz_formhistory` 读取并写入（`firefox_importer.cc:493-503`、`profile_writer.cc:332`）。
- 本 MVP 只在用户显式选择 `autofill` 时导出 JSONL；目标写入标记 `export-only`。

---

## 7. 书签、历史、标签页、扩展、设置

### 7.1 书签（本 MVP 唯一直接写入目标的数据）

- 格式：`Bookmarks` JSON，`version=1`，根 `roots.bookmark_bar/other/synced`
  （`components/bookmarks/browser/bookmark_codec.cc:36-57`）。
- 解码要求：每个节点必须有 `id`、`name`、`type`；URL 节点需要合法 `url`；文件夹需要
  `children`（`:330-390`）。缺失日期会退化为 `Time::Now()`/epoch（`:378-386`）。
- GUID：无效或重复会被重新分配并标记 `required_recovery`（`:153-180`、`:310-330`），
  因此本工具为每个导入节点生成合法 UUID v4。
- checksum：编码时写 `checksum`（`:498-501`），但当前解码路径不校验它（全仓库只有编码侧引用
  `kChecksumKey`）。本工具不写 checksum，并已用 Chrome 156 的解码约束做结构校验。
- 书签加密：`kEncryptBookmarks` 默认启用，默认 stage 是 `write_both_read_only_clear`
  （`components/bookmarks/common/bookmark_features.cc:33-53`）：同时写明文与
  `EncryptedBookmarks2`，读取仍以明文为准。因此：
  - 新 Profile 首次启动前写入明文 `Bookmarks` 可被读取；
  - 若目标已有非空 `EncryptedBookmarks2`，本工具拒绝写入（避免明文不是权威源）。
- 合并：目标已有书签时，`--allow-existing` 先做时间戳备份，再把导入内容放进唯一命名的
  “Imported from …” 文件夹（与 Chromium `ProfileWriter::AddBookmarks` 的冲突处理思路一致，
  `chrome/browser/importer/profile_writer.h:60-76`）。

### 7.2 历史

- Chromium `History` 是 SQLite，当前 schema 版本 70
  （`components/history/core/browser/history_database.cc:41`）。表多、迁移复杂、外键/索引/visits
  关联，外部直接写入风险高且版本敏感。
- Chromium 原生导入历史只对 Firefox/IE 生效，且通过 `HistoryService::AddPagesWithDetails`
  写入（`profile_writer.cc:103-110`），不是直接写 DB。
- 本 MVP：**只导出 JSONL**（URL、标题、访问次数、最后访问时间），目标写入状态
  `export-only`，不写目标 History DB。

### 7.3 打开的标签页

- Chromium：`Sessions/` 下 SNSS 文件（内部命令存储格式，版本化、可加密），没有公开解析/导入 API。
- Firefox：`sessionstore.jsonlz4`（mozlz4 压缩），同样是内部格式。
- 可行替代：用户授权的来源扩展用 `chrome.tabs.query` 导出 URL/标题（不含表单状态），
  由 Browser CLI/BrowserPilot 逐一打开；或用户手动重开。
- 本 MVP：状态 `blocked`，不解析、不复制会话文件。

### 7.4 扩展

- 扩展目录 + `Preferences`/`Secure Preferences` 中的安装状态/权限不是可移植数据；
  直接复制会绕过安装验证、策略与签名检查，且扩展本地数据（IndexedDB/localStorage）另有密钥/路径绑定。
- 合规路径：从官方商店重新安装；扩展数据不迁移。
- 本 MVP：只读清点（ID/名称/版本），状态 `report-only`。

### 7.5 设置

- 全量复制 `Preferences` 会带入窗口状态、实验 flag、策略缓存等，极易破坏目标 Profile。
- 本 MVP 只读取白名单摘要（主页是否配置、启动恢复模式、启动 URL 数量），状态 `report-only`。

---

## 8. 支持矩阵（截至本报告）

图例：✅ 本 MVP 已实现并测试；◐ 只导出/只报告；⛔ 明确 blocked；— 不适用。

| 数据 | Chrome → Browser CLI | Edge → Browser CLI | Brave → Browser CLI | Firefox → Browser CLI | Chromium 原生 Importer |
| --- | --- | --- | --- | --- | --- |
| 书签 | ✅ 直接写 `Bookmarks`（目标未运行/备份/合并） | ✅ 同左（格式同 Chromium） | ✅ 同左 | ✅ 解析 `places.sqlite` 后写 `Bookmarks` | 仅 Firefox / 旧 Edge / bookmarks.html |
| 历史 | ◐ 导出 JSONL | ◐ | ◐ | ◐ | Firefox/IE 可 |
| Cookie | ⛔ 需扩展桥（协议已测，浏览器内未测） | ⛔ 同左 | ⛔ 同左 | ⛔ 需目标 Cookie 写入通道 | **任何来源都不支持** |
| 密码 | ⛔ 官方 CSV 导出/导入 | ⛔ 同左 | ⛔ 同左 | ⛔ 官方导出；设备绑定不可迁移 | Firefox/旧 IE 可（NSS） |
| 自动填充 | ◐ 导出 JSONL | ◐ | ◐ | ◐ | Firefox 可 |
| 打开的标签页 | ⛔ 需扩展 `chrome.tabs.query` 或手动 | ⛔ | ⛔ | ⛔ | 不支持 |
| 扩展 | ◐ 只报告，建议商店重装 | ◐ | ◐ | ◐ | 不支持 |
| 设置 | ◐ 只读摘要 | ◐ | ◐ | ◐ | 有限（首页/搜索） |

注意：Edge/Brave 的路径与格式未在本环境的真实安装上复核（网络不可达，且规则禁止使用真实用户 Profile）。
发现逻辑通过 `--root` 注入并用合成 Profile 验证；上线前必须在隔离测试机用真实安装路径做一次发现测试。

---

## 9. 风险清单

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 目标 Profile 正在运行 | 并发写 SQLite/JSON，数据损坏 | 默认只允许新建/空目录；已有目录要求 `--allow-existing`；检查 `SingletonLock`/`SingletonCookie`/`parent.lock`；Windows 进程探测失败时 fail closed |
| Windows 无锁文件 | 可能漏检运行中的 Browser CLI | 进程命令行探测（`--user-data-dir`/默认根）；探测失败且目标非空 → 拒绝；残余竞态在文档中明示 |
| Chrome v20 解密诱惑 | 破坏安全边界、违反任务约束 | 不实现解密；只统计 `v20` 数量；桥接走官方 API |
| Cookie 含 Session Token | 泄露/上传 | 不写日志、不写 bundle、不上传；Broker 仅内存；扩展只在用户点击后发送 |
| 扩展读取范围过大 | 用户隐私 | 按域名勾选；来源扩展显示数量与属性；不默认全选发送 |
| 合并书签破坏现有数据 | 用户数据丢失 | 原子写 + 时间戳备份 + 唯一文件夹 + 结构校验 |
| 历史 DB 版本漂移 | 目标历史损坏 | 不直接写；只导出 |
| 设备绑定会话 | 迁移后仍登录失败 | 三态结果；明确提示；用户实际验证 |
| Edge/Brave 路径/加密差异 | 发现失败或误判 | fail closed；启动前隔离环境验证；不使用真实用户 Profile 测试 |
| 本地 Broker 被本机恶意页面探测 | 配对码爆破 | 6 位码 + 每分钟限速（待补）+ Origin allowlist + 仅 loopback + 10 分钟 TTL |

---

## 10. 本环境未能验证 / blocked 项（不得写成 PASS）

1. **真实 Chrome/Edge/Brave 的 Cookie 读取与写入**：未启动真实浏览器；两端扩展未在浏览器中加载。
   仅协议、Broker、字段映射、日志脱敏测试通过。
2. **App-Bound / DPAPI 解密**：明确不做；没有验证“能否解密”，因为这是禁止路径，不是能力缺口。
3. **Edge/Brave 的真实 profile 路径与 Cookie 前缀分布**：未使用真实安装验证。
4. **Firefox 密码 NSS 解密**：未实现、未验证；只统计 `logins.json` 条数。
5. **目标 Browser CLI 首次启动后读取导入的 `Bookmarks`**：未启动 Browser CLI；只做了
   与 Chrome 156 `BookmarkCodec::Decode` 约束一致的结构校验。
6. **打开的标签页**：未实现；SNSS/mozlz4 无公开 API。
7. **扩展迁移**：未实现；仅报告。
8. **Windows 进程探测在真实环境的行为**：代码路径存在，测试中用 `BP_IMPORT_TEST_MODE=1` 跳过；
   真实环境仍需在隔离机器验证。

---

## 11. 参考（源码位置均为 `D:\c\src`，只读）

- `components/user_data_importer/common/importer_data_types.h:23-32` — ImportItem；Cookie 未支持
- `chrome/utility/importer/importer_creator.cc` — 支持的 Importer 类型
- `chrome/browser/importer/importer_list.cc:40-70,145-153` — Edge/Firefox 来源与能力位
- `chrome/utility/importer/edge_importer_win.cc`、`chrome/common/importer/edge_importer_utils_win.cc:42-52`
- `chrome/utility/importer/firefox_importer.cc:174-503,734-745` — Firefox 复制/查询/密码/自动填充
- `chrome/browser/importer/external_process_importer_host.cc:155-176` — Firefox profile 锁
- `chrome/common/importer/profile_import.mojom` — 导入观察者消息（无 Cookie）
- `chrome/browser/first_run/first_run.cc:467-519` — 首次运行导入项
- `chrome/browser/ui/webui/settings/import_data_handler.cc:62-120` — `chrome://settings/importData`
- `chrome/common/chrome_switches.h:436-437` — `--import-passwords`
- `components/password_manager/core/browser/import/password_importer.cc:66-70` — CSV 1000 KiB 上限
- `net/extras/sqlite/sqlite_persistent_cookie_store.cc:316-317,662-690,1025-1055,1356-1372`
- `components/os_crypt/async/browser/dpapi_key_provider.cc:28-96` — v10 / DPAPI key
- `chrome/browser/os_crypt/app_bound_encryption_provider_win.h:41-50` — v20 / app-bound key
- `chrome/browser/os_crypt/app_bound_encryption_win.cc:64-150` — 支持条件
- `chrome/elevation_service/caller_validation.cc:60-160`、`elevator.cc:100-160` — 调用路径绑定
- `chrome/browser/browser_process_impl.cc:1606-1620` — provider 优先级
- `chrome/common/extensions/api/cookies.json:36-41,110-151` — cookies API 能力
- `chrome/browser/extensions/api/cookies/cookies_helpers.cc:139,151-161` — session/partition 映射
- `components/bookmarks/browser/bookmark_codec.cc:36-57,153-180,330-390,498-501`
- `components/bookmarks/common/bookmark_features.cc:33-53` — 书签加密 stage
- `components/bookmarks/common/bookmark_constants.cc:13-20`
- `components/history/core/browser/history_database.cc:41` — History schema v70
- `chrome/common/chrome_constants.h:48-49,60,81,145`
- `chrome/common/chrome_paths_win.cc:42-47`、`chrome/install_static/chromium_install_modes.h:24`
- `components/webdata/common/webdata_constants.cc:9-10`
- `components/test/data/web_database/version_103.sql:10-25` — autofill schema 参考
- `components/password_manager/core/browser/password_store/login_database.cc:1096-1107,1384`

外部产品文档（Chrome 帮助、Chrome for Developers、App-Bound 公告）本次因网络超时无法访问；
上表中标注“公开产品路径/公开格式”的内容未在本次环境中二次核对，已在正文标明。
