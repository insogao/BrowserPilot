# ego(lite) 导入机制在 Windows 的适用性（2026-10-31）

## 结论

你的 macOS 逆向在**机制层面**很有价值，但 **Windows 不能直接套用**：

- macOS：钥匙串 `Safe Storage` → PBKDF2-HMAC-SHA1（saltysalt，1003 次，16 字节）
  → AES-128-CBC（IV = 16 个空格）解 `v10`。
- Windows：`Local State` 的 `os_crypt.encrypted_key`（`DPAPI` 前缀 + DPAPI 密文）
  → 32 字节 AES-256-GCM 密钥 → `v10` cookie 用 AES-256-GCM（12 字节 nonce 前置）。
- Windows `v20/v22`：App-Bound Encryption，密钥在 `os_crypt.app_bound_encrypted_key`，
  由 Chrome elevation service 解密；调用者真实进程路径被 `QueryFullProcessImageNameW`
  校验。Browser CLI 的 exe 路径不同，不能合规解密。
- Windows 没有 macOS 钥匙串授权弹窗；DPAPI 同级用户进程可静默解密。因此**不能把
  “钥匙串弹窗=用户同意”的假设搬到 Windows**；产品必须自己提供显式同意 UI。

因此：

1. 你附的 `browser_cookies_macos.py` 的 `derive_key` / `AES-128-CBC` 在 Windows 上
   **不适用**；即使拿到 DPAPI 密钥也会解错。
2. “账号绑定前缀 `SHA256(host_key) || value`”这一层在 Windows 也成立
   （Chromium `sqlite_persistent_cookie_store.cc` 解密后校验 `SHA256(domain)`），
   但它是解密后的格式，不是密钥派生。
3. Windows ego 的原生导入模块确实存在，且静态字符串显示它处理 DPAPI/CNG/
   App-Bound/UAC/来源关闭；这不等于 Browser CLI 可以照搬它的提权路径。

## 源码依据（Chromium 156）

- `components/os_crypt/async/browser/dpapi_key_provider.cc`：
  `os_crypt.encrypted_key`、`kKeyTag = "v10"`、`CryptUnprotectData`、
  `kAES256GCMKeySize`。
- `components/os_crypt/async/browser/os_crypt_win.cc`：
  `DPAPI` 前缀、`CryptProtectData`/`CryptUnprotectData`。
- `components/os_crypt/async/common/encryptor.cc`：
  `kAES256GCM` 使用随机 nonce；`kAES128CBC` 是 POSIX/macOS 路径。
- `chrome/browser/os_crypt/app_bound_encryption_provider_win.h`：
  `kAppBoundDataPrefix = "v20"`、`os_crypt.app_bound_encrypted_key`。
- `chrome/browser/os_crypt/app_bound_encryption_win.cc`：
  `PROTECTION_PATH_VALIDATION_WITH_ISOLATION`（默认开启）。
- `net/extras/sqlite/sqlite_persistent_cookie_store.cc`：
  解密后 `SHA256(domain)` 前缀校验，不匹配则拒绝该 cookie。

## ego(lite) Windows 0.6.2.5 静态证据

安装目录 `%LOCALAPPDATA%\Citro Labs\ego lite\Application\0.6.2.5\chrome.dll`
中命中：

```
os_crypt.encrypted_key
os_crypt.app_bound_encrypted_key
os_crypt.aster_app_bound_encrypted_key
DPAPI
v10 / v20 / v22
CryptProtectData / CryptUnprotectData / NCryptOpenKey
system_dpapi / user_dpapi / system_cng
app_bound_setup_missing / app_bound_uac_denied / app_bound_caller_rejected
success_discarded_v20_values_missing_app_bound_key
success_discarded_v22_values_missing_app_bound_key
source_closed_by_ego / source_close_requests
```

说明：ego Windows 不是“只导入书签/历史”，而是原生读取 Chrome profile +
DPAPI/App-Bound/CNG 处理；但这也意味着：

- 它可能请求 UAC/提升服务来解 v20；
- 没有 App-Bound key 时会丢弃 v20/v22 cookie；
- 它会关闭/要求关闭来源浏览器。

本机实际 Chrome 导入仍 **blocked**：真实 Chrome 在运行、隔离 `LOCALAPPDATA`
没有重定向源 Profile、没有独立 Windows 用户/VM。因此不能把 ego 官方宣传当
Windows 登录态迁移 PASS。

## 对 Browser CLI 的适用性判断

| 部分 | Windows 是否适用 | 说明 |
| --- | --- | --- |
| 原生导入模块/描述符表/复制 DB | **适用** | 架构可复用；不依赖上游 Importer |
| 钥匙串 `SecItemCopyMatching` + 弹窗 | **不适用** | Windows 无此 API/授权模型 |
| PBKDF2 1003 + AES-128-CBC | **不适用** | macOS 专属；Windows v10 是 DPAPI+AES-256-GCM |
| DPAPI 解 v10 | **技术上可能** | 同用户进程可 `CryptUnprotectData`；但静默、需产品/法律批准和显式用户同意 |
| v20/v22 App-Bound | **不可由 Browser CLI 合规解密** | 路径校验/隔离状态；不做提权/伪造路径 |
| 来源扩展读 Cookie + 目标原生写 | **适用** | 来源 Chrome 自己解 v20；目标写自己的 CookieStore |
| 直接复用已有 Chrome 会话 | **最适用** | 不复制账号数据；设备绑定/WebAuthn 也能用 |
| ego 的关闭来源浏览器/UAC 提升 | **不采用** | 破坏用户体验，且可能越过应用身份验证 |

## 产品建议

1. **不要移植 macOS demo 到 Windows 作为实现**；它会在 `v10` 解密处失败。
2. Windows 原生导入可先做 **v10-only** 原型（DPAPI + AES-256-GCM），但必须：
   - 用户显式勾选/确认，不能静默；
   - 不读取真实用户 Profile 做测试；只用隔离测试 Profile；
   - 产品/法律评审后再决定是否默认开启。
3. 现代 Chrome 默认 v20：**不做第三方解密**；使用
   “来源扩展读 + 目标原生 CookieStore 写”，或直接复用已有 Chrome 会话。
4. 书签/历史可原生迁移；密码走官方 CSV；扩展商店重装。
5. 下一步实测必须在**独立 Windows 用户/VM**：
   - 合成 Chrome Profile 已登录本地测试站；
   - 关闭来源 Chrome 后运行 ego，记录是否 UAC/关闭进程/v20 丢弃；
   - 目标 Browser CLI 登录、重启、Agent Space 复用；
   - 全链路不上传/不日志敏感值。

## 记录

- 本分析只读源码/官方安装包字符串，未读取真实 Cookie/密码，未解密任何真实 cookie，
  未修改 `D:\c\src`。
- 证据目录：`D:\c\logs\egolite`（源码）、官方 ego 安装目录；后续实测需独立环境。

## inso 实测（只读元数据 + Profile 副本启动）

### 1. 源 Profile 的 cookie 形态

- Profile：`%LOCALAPPDATA%\Google\Chrome\User Data\Default`，Chrome 显示名 `inso`。
- 源 `Network/Cookies`：**1780 条 cookie，全部是 `v20` 前缀**
  （`hex(substr(encrypted_value,1,3)) = 763230`），没有 v10。
- `Local State` 同时存在 `os_crypt.encrypted_key`（DPAPI v10 key）和
  `os_crypt.app_bound_encrypted_key`（v20 App-Bound key），两者在副本中与源
  逐字节一致（字段 SHA-256 前缀相同）。
- 只查询元数据（名称、域名、过期时间、HttpOnly/Secure），没有解密或输出值：
  - Bilibili 登录相关的 `SESSDATA`、`DedeUserID`、`DedeUserID__ckMd5`、`bili_jct`
    均存在；
  - `SESSDATA` 为 HttpOnly，四个 cookie 的过期时间均为 **2027-02-27**，未过期。
  - 因此源 Profile 的登录态是**有效**的，后面的失败不是 cookie 过期。

### 2. 复制 Profile 后启动的结果（已复现，非猜测）

复制到 `D:\work\wt\inso-copy-20261031`，只复制必需文件：

```
Local State
Default/Preferences
Default/Secure Preferences
Default/Network/Cookies
Default/Network/Cookies-journal (0 字节)
```

源/副本的 `Cookies` 文件大小、SHA-256、行数完全一致（884736 字节，1780 行），
`Local State` 的两个 os_crypt key 字段也完全一致。启动命令（stock Chrome 156）：

```
chrome.exe --user-data-dir=D:\work\wt\inso-copy-20261031
  --no-first-run --no-default-browser-check --disable-sync
  --disable-component-update --disable-background-networking
  --remote-debugging-port=9250 https://www.bilibili.com/
```

结果：

- 页面显示未登录；
- CDP `Storage.getCookies` 只返回 **39** 条 cookie；
- Bilibili 的 `SESSDATA`、`DedeUserID`、`bili_jct` 不在返回结果中；
- 副本 DB 本身仍有 1780 行（Chrome 没有删除它们），说明是**解密失败后不加载**，
  不是复制少文件或 cookie 被清空。

### 3. 根因（Chromium 源码确认）

不是 copy 不完整，也不是 cookie 过期，而是 **App-Bound Encryption 的默认数据目录约束**：

- `chrome/browser/os_crypt/app_bound_encryption_win.cc`
  `GetAppBoundEncryptionSupportLevel()`：
  - `chrome::IsUsingDefaultDataDirectory()` 为 false 时返回
    `SupportLevel::kNotUsingDefaultUserDataDir`；
  - 任何显式 `--user-data-dir=<非默认路径>` 都会命中这一条。
- `chrome/browser/os_crypt/app_bound_encryption_provider_win.cc`
  `GetKey()`：
  - 对 `kNotUsingDefaultUserDataDir` 直接返回
    `KeyError::kTemporarilyUnavailable`；
  - 不会用 DPAPI v10 key 回退解 v20，也不会尝试调用 elevation service。
- `components/os_crypt/async/common/encryptor.cc` / cookie store 没有 v20→v10
  的 fallback；解密失败即记录 `kDecryptFailed` 并跳过该 cookie。

因此：**把现代 Chrome v20 Profile 复制到任意非默认 `--user-data-dir` 启动，
登录 cookie 必然不可用**。这是 Chrome 的设计边界，不是 Browser CLI 能通过
“复制得更完整”绕过的问题。

### 4. 为什么不能用“改成默认目录”解决

默认目录是 `%LOCALAPPDATA%\Google\Chrome\User Data`。要让它指向副本，只能：

- 关闭并移动/替换用户真实 Profile（会触碰真实 Profile，且用户 Chrome 正在运行）；
- 修改 Windows Known Folder / 环境变量（系统级配置变更）；
- 伪造路径/绕 elevation service 的调用者校验（安全边界，明确禁止）。

这三条都不采用。Chrome 156 的 `--remote-debugging-port=9222` 当前处于
`kWithApprovalOnly` 模式（`Local State` 的 `devtools.remote_debugging.user-enabled=true`），
每个连接都要用户在 `DevToolsConnectionDialog` 里点允许；本轮没有把它当作无人值守
验收通道，也没有点这个对话框。

### 5. 对真实 Chrome 内扩展路径的影响

- 真实 inso Chrome 里确实安装了 BrowserPilot 0.1.0（unpacked，ID
  `nnollghpaggbcdkkgoieneffnlijinio`），并且 HKCU native host 指向
  `D:\work\BrowserPilot\native-host\host.manifest.json`。
- 但 Chrome 156 默认启用 `extensions::features::kExtensionDisableUnsupportedDeveloper`
  （`extensions/common/extension_features.cc`，默认 enabled）；该 Profile 的
  `extensions.ui.developer_mode` 未设置（即 false），unpacked 扩展被禁用，
  service worker 没有运行，native host 也没有被拉起（只有我们自己的 Browser CLI
  窗口在 47002 上有一个 host）。
- 因此“让来源 Chrome 自己用扩展读 cookie”是正确方向，而且**不一定需要开发者模式**：
  unpacked BrowserPilot 被禁用，但**已安装的 Web Store 扩展不受这条 unpacked 限制**。
  本轮用已安装的 “Get cookies.txt LOCALLY” 0.7.2（Web Store，`cookies` 权限）
  在真实 inso Chrome 内导出当前标签页 cookie，完成了登录态导入；详见 §8。
- 本轮没有修改用户 Chrome 设置、没有重启/关闭用户 Chrome、没有安装/启用新扩展；
  只操作了已安装扩展的 popup，并把其导出格式恢复为默认 Netscape。

### 6. 产品结论

- 对现代 Chrome v20：**离线复制 Profile / 第三方解密不可行**；唯一合规的迁移
  路径是来源浏览器自己解密：
  1. 来源 Profile 内安装并运行扩展，用 `chrome.cookies` / `chrome.debugger` 读取；
  2. 用户明确授权后复用已有 Chrome 会话（不迁移）；
  3. 在 Browser CLI 内重新登录。
- 书签、历史仍可离线原生导入；密码走官方 CSV；扩展商店重装。
- 真实 Chrome 验收已经通过（§8）：来源端使用 **Web Store 扩展**，目标端原生
  CookieStore 写入，不碰密文/密钥。产品化不能依赖 `--load-extension`（branded
  Chrome 直接忽略），也不应要求普通用户开启开发者模式；应发布一个最小 Web Store
  扩展，或走企业策略/复用已有会话。

### 7. 清理

- 复制的 Chrome 进程（PID 19744，端口 9250）已通过 CDP `Browser.close` 正常关闭；
- 复制目录 `D:\work\wt\inso-copy-20261031` 已删除（含源 cookie/keys，避免长期留存）；
- 用户真实 Chrome（PID 39264）未关闭、未重启、未修改；
- 目标 Browser CLI 测试 Profile `.manual-profile-normal` 保留用于演示，含本次导入的
  WorkBuddy 会话；如不需要可在确认后删除。

### 8. 真实登录态导入 PASS（2026-10-31）

| 项目 | 结果 |
| --- | --- |
| 来源 | 真实 `inso` Chrome 156（PID 39264），当前标签 `www.workbuddy.cn` 登录成功页；未关闭/未重启 |
| 来源扩展 | 已安装 “Get cookies.txt LOCALLY” 0.7.2（ID `cclelndahbckbenkjhflpdbgdldlbecc`） |
| 导出 | popup 选 JSON → Copy；9 条 cookie（`www.workbuddy.cn` / `.workbuddy.cn`）；经剪贴板传入本地脚本，不落盘 |
| 目标 | Browser CLI 156.0.8067.0，Profile `.manual-profile-normal`，CDP 9333；`Storage.setCookies` 后 `verifiedPresent=9` |
| 目标页面 | `https://www.workbuddy.cn/` 显示 `178****1756`、`退出登录`；`loggedIn=true` |
| 重启后 | CDP `Browser.close` → 同一 Profile 重启 → WorkBuddy 仍 `loggedIn=true` |
| Agent 侧 | BrowserPilot host（目标，47001）执行 `js` 返回 `{loggedIn:true,id:true}`；`snapshot` L0 成功 |
| 未做 | 未调用 elevation service、未改默认数据目录、未注入 Chrome、未上传、未把 cookie 值写入项目文件 |

结论：来源 Chrome 自己解 v20 → 扩展 API 导出 → 目标原生写入，是当前 Windows
Chrome 156 上可执行、可重启、可被 Agent 使用的合规路径。剩余产品化工作是把来源
扩展做成 Web Store/策略安装，并补齐配对/用户确认 UI、书签/历史/密码导入和失败三态。

## REA 工具状态

- `npx rea-agents@latest` 已可启动，但当前 Node 24.15.0 低于其 24.22.1 要求；
  `doctor` 显示没有 Ghidra/IDA/Hopper provider，PE `inspect-binary-layout` 也因
  pwntools provider 仅支持 Linux x64 而不可用。
- 因此本轮对 ego Windows 的结论来自 PE 字符串/导入表人工核对
  （`CryptUnprotectData`、`NCryptOpenKey`、`app_bound_*`、`source_closed_by_ego` 等），
  不是 Ghidra 伪代码。要补调用级伪代码，需要安装 Ghidra/IDA 并用 rea 重新分析。
