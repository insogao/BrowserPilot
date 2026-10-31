# ego(lite) Windows 导入实测与反证（2026-10-30）

状态：**部分实测 + 静态证据；完整 Chrome 登录态迁移被安全边界阻塞，未获得可宣称 PASS 的结果。**
测试人：独立子 Agent E（worktree `D:\work\wt\bp-import-ego`，分支 `agent/p1-import-competitive`）
证据目录：`D:\work\wt\egolite-evidence`（不入库）

---

## 0. 先纠正对象：两个不同的 “EgoLite”

本轮必须区分两个同名/近名产品，否则会把一个产品的源码当成另一个产品的证据：

| 对象 | 身份 | 导入能力（证据） |
| --- | --- | --- |
| **官方 ego(lite)**（citrolabs，`https://lite.ego.app`） | Chromium 156 内核的 Windows/macOS 浏览器，Windows 为 beta；下载按钮指向 `https://cdn.ego.app/setup/windows/x64/egoliteSetup.exe` | 官方页面宣称 onboarding 一键从 Chrome 迁移 Tabs/书签/密码/扩展/Cookies/登录会话/Profile；安装包内含自研 `ego/browser/data_import/*` 导入器 |
| `sj18259360196-source/EgoLite` v0.2.14 | 另一个 Windows 桌面浏览器（Electron shell + managed Edge），README 自述 “Windows desktop browser with task workspaces, MCP automation…” | 源码 `apps/desktop-shell/browser-data-import.mjs` 只读取 `Bookmarks` 与 `History`；另有“复制扩展目录”功能；**没有 Cookie/密码/Profile 迁移代码**，UI 只有“书签/历史记录”两个勾选项 |

本报告**没有运行** `sj18259360196-source/EgoLite` 0.2.14 安装包（仅下载并核对其公开源码/UI）；因为它是另一个产品，运行它不能回答官方 ego(lite) 的导入能力。

因此：

- 本轮实测对象是**官方 citrolabs ego(lite) 0.6.2.5**（Windows beta）。
- `sj18259360196-source/EgoLite` 0.2.14 不能用来证明或否证官方 ego(lite) 的 Cookie/登录态能力；它只证明“另一个同名项目不做 Cookie 导入”。

---

## 1. 实测环境

| 项 | 值 |
| --- | --- |
| OS | Windows 11 25H2，Build 26200.9711，x64 |
| 权限 | 普通用户（非管理员；安装过程未触发 UAC） |
| 系统 Chrome | 156.0.8078.48（`C:\Program Files\Google\Chrome\Application`） |
| 系统 Edge | 156.0.4314.50（`C:\Program Files (x86)\Microsoft\Edge\Application`） |
| 官方 ego(lite) | 0.6.2.5（Omaha updater 版本），应用内 Chromium 156.0.8078.74 |
| 安装位置 | `%LOCALAPPDATA%\Citro Labs\ego lite\Application\0.6.2.5` |
| 测试站点 | 本地 `http://127.0.0.1:18080` / `https://127.0.0.1:18443`（自签证书，仅测试 Profile 信任） |
| 测试账号 | `bp-test-user` / `<local-test-password>`（仅本地测试站，非真实账号） |
| 真实 Chrome | **测试期间用户真实 Chrome 一直在运行**（PID 39264 及其子进程）；未关闭、未读取、未修改 |

安全控制：

- 所有 Chrome/Ego 启动都使用独立 `--user-data-dir`；Ego 另外尝试了隔离 `LOCALAPPDATA`/`USERPROFILE`/`APPDATA`。
- 未使用 `--no-sandbox` 做任何验收；未注入 Chrome；未读取/解密任何真实 Cookie/密码；未操作钥匙串。
- 所有 GUI 交互通过应用自身 DevTools 协议（`chrome://onboarding/` 的 `window.ego.controller`）完成；未使用 Computer Use，未点击系统对话框。

---

## 2. 安装包与完整性

### 2.1 官方下载链路

1. `https://lite.ego.app/download` → 页面按钮 → `https://cdn.ego.app/setup/windows/x64/egoliteSetup.exe`。
2. `egoliteSetup.exe` 是 Omaha updater stub，不是完整浏览器：

| 文件 | 大小 | SHA-256 | 签名 |
| --- | --- | --- | --- |
| `egoliteSetup-0.6.2.5.exe` | 19,148,888 | `053d03739c51a23ae695fa87bfb0941cd77320335b8fb3b5ccef3ca2f5b4b58a` | Valid，`CN=CITRO LABS PTE. LIMITED`（DigiCert） |

3. 运行 stub `/silent /install` 时，Omaha 从 `update.citrolabs.ai` 取得 286,062,716 字节的完整包：
   - 包名 `ego-0.6.2.5-x64.crx3`
   - SHA-256 `d2f8fb22cb18da3cb787575fa513fcebee6d6e585ef44e207a301fc5cac93a34`
   - 内部 `mini_installer_uncompressed.exe` 644,261,016 字节
4. 本机第一次自动下载失败：Omaha 报 `error=200`、`extra_code1=-2147012894`（`0x80072ee2`，下载超时），stub 随即自清理。改为从 Omaha 响应中的签名 URL 直接下载 crx3，校验哈希后解包 `mini_installer_uncompressed.exe`，以 `--do-not-launch-chrome --ego-lite` 安装成功（exit 0）。
5. 安装为 **per-user**，未出现 UAC；安装目录与 `User Data` 均在 `%LOCALAPPDATA%\Citro Labs\ego lite` 下。
   说明：这是 per-user 应用目录，不是临时目录；安装前该机器没有 Ego 安装，因此没有覆盖任何既有用户应用。测试用的 Ego 目标 Profile 全部在 `D:\work\wt\egolite-evidence\profiles` 下（`--user-data-dir`），默认 `User Data` 基本为空。测试结束后应用仍保留，便于复核；卸载可用安装目录内的 `Installer\setup.exe --uninstall`（未执行）。

### 2.2 版本与签名证据

- 安装器与 `ego.exe` 的 Authenticode 签名有效（`CN=CITRO LABS PTE. LIMITED`）；应用版本 0.6.2.5；DevTools `/json/version` 报告 `Chrome/156.0.8078.74`。
- `ego-browser.exe` 提供用户可调用的导入 CLI：
  ```
  ego-browser import list
  ego-browser import --browser <chrome|edge|brave|comet|opera|vivaldi|yandex|firefox|zen|arc|dia>
                      [--profile <dir-name> ...]
                      [--clear-existing-profiles] [--no-default]
  ```

---

## 3. 实际运行结果

### 3.0 官方宣称（原文，供对照）

官方页面 `https://lite.ego.app/` 的 onboarding 宣称（2026-10-30 抓取）：

> ego(lite) is the agent browser that imports your entire Chrome setup in one click.
> ... migrates the following from Chrome in one click:
> • Tabs and tab groups you're using
> • Bookmarks and saved passwords
> • Browser extensions
> • Cookies and login sessions
> • Browser profiles
> Every site you've already signed into stays signed in, and the agent inherits the same logged-in state.

这些是**厂商宣称**，不是本轮实测结果；下面的运行记录用于验证/反证。

### 3.1 首次启动/Onboarding

- 直接运行 `ego-browser import list` 被拒绝：
  > `Please complete the onboarding process first. A setup window has opened; follow the on-screen instructions to continue.`
- 该命令启动了 `chrome://onboarding/` 设置窗口；用 CDP 连接后确认 `window.ego.controller` 暴露：
  - `getBrowserImportSources`
  - `browserDataImport(selections, clearExistingProfiles)`
  - `completeOnboarding(hasSkipDataImport, crashReportingEnabled)`
  - `checkBrowserAppDataAccess`
  - `onDataImportProgress`
  - `completeBrowserDataImport` / `cancelBrowserDataImport`
- Onboarding 资源中的导入选择结构（从 `resources.pak` 解出）：
  ```js
  [{ browserSource: "chrome", selectedProfileDirNames: ["Default"] }]
  ```
  即只有“浏览器 ID + 源 Profile 目录名”，**没有任意源根路径参数**。

### 3.2 源发现（在真实 Chrome 运行、且用隔离 LOCALAPPDATA 启动 Ego 时）

- 启动 Ego 时设置了：
  - `LOCALAPPDATA=D:\work\wt\egolite-evidence\profiles\fake-localappdata2`
  - `USERPROFILE=...\fake-userprofile2`
  - `APPDATA=...\fake-appdata2`
  - `--user-data-dir=D:\work\wt\egolite-evidence\profiles\ego-target2`
- 在该 fake `LOCALAPPDATA` 下放置了：
  - 合成 Chrome Profile：`Google\Chrome\User Data\Default`，`Local State` 中 Profile 名 `ISOLATED-CHROME-SOURCE`
  - 合成 Brave Profile：`BraveSoftware\Brave-Browser\User Data\Default`，Profile 名 `ISOLATED-BRAVE-SOURCE`
- 调用 `getBrowserImportSources()` 返回 **`[]`**。
- 同时 `checkBrowserAppDataAccess()` 返回 `[]`，`getDataImportType()` 返回 `browser-data-onboarding`。

结论（谨慎表述）：在这台机器上，**隔离 `LOCALAPPDATA` 没有让 Ego 发现合成 Chrome/Brave Profile**；由于真实 Chrome 正在运行，Ego 也没有把真实 Chrome 列为可导入源。无法据此单独证明 Ego 的源根一定来自 `SHGetKnownFolderPath(LOCALAPPDATA)`，但可以确定：**在本机测试中，环境变量或任意路径都没有把导入源重定向到测试 Profile**；由于没有源码级确认，保守地按“不支持重定向”处理。这也是完整导入测试被阻塞的直接原因之一。

### 3.3 安全负例：Brave 源

调用：

```js
window.ego.controller.browserDataImport(
  [{ browserSource: "brave", selectedProfileDirNames: ["Default"] }],
  false
)
```

返回：

```json
{
  "success": false,
  "resultCode": 4,
  "failureDetails": [{
    "failureCode": 4,
    "failureDetail": "source_no_importable_profiles",
    "browser": "brave",
    "rowsNotImported": 0,
    "unexpiredCookiesDiscarded": 0,
    "sourceLockOwners": []
  }],
  "lockOwnerAppsNotRestarted": [],
  "systemVersion": "Windows 11 Version 25H2 (Build 26200.9711)"
}
```

本机没有真实 Brave，因此这条路径既没有真实来源可读，也不会碰 Chrome；它只证明“不存在的浏览器源会明确失败”，不能证明 Cookie 导入成功。

**来源只读性负例**：在该负例运行前后，对隔离测试 Chrome Profile 的 `Local State`、`Preferences`、`Network/Cookies`、`History`、`Login Data`、`Web Data` 做了 SHA-256 对比，6 个文件全部未变化（`unchanged: true`）。这只证明“Brave 负例没有修改测试 Profile”，不能证明 Chrome 导入路径只读；Chrome 导入仍未执行。证据：`D:\work\wt\egolite-evidence\logs\ego-source-hash-check.json`。

把 `browserSource` 换成绝对路径（`D:/.../Brave-Browser/User Data`）后，同样返回 `source_no_importable_profiles`；`browserSource` 字段被原样回显为字符串，但没有被当作源根使用。**导入 API 不接受任意路径。**

### 3.4 Chrome 导入：BLOCKED

没有执行 `browserSource: "chrome"` 的导入。原因不是“懒得测”，而是当前环境无法安全执行：

1. **真实 Chrome 正在运行**，且是用户真实 Profile。
2. Ego 二进制中存在以下字符串，表明它会主动结束/关闭来源浏览器：
   - `source_close_requests`
   - `source_closed_by_ego`
   - `source_close_result`
   - `import_source_browser_close_failed`
   - `import_source_locked_after_browser_closed`
   - `import_source_lock_owner_close_failed`
   以及一条启动器错误文案：
   > `chrome is already running; you must close all running ... instances before running with the --... flag`
3. 在本机测试中源根无法重定向到隔离 Profile（见 3.2），因此“只导入测试 Profile”不可行。
4. App-Bound 相关字符串（`app_bound_uac_denied`、`app_bound_setup_missing`、`app_bound_registration_failed`、`app_bound_caller_rejected`、`success_discarded_v20_values_missing_app_bound_key`）表明：Chrome v20 Cookie 可能需要 UAC/提升服务或专用 helper；这可能触发系统对话框，且属于我们禁止的“绕过应用身份验证/提取密钥”方向。
5. 可用隔离环境只有当前 Windows 用户；Windows Sandbox 在该 Home 版不可用；创建第二个 Windows 用户/VM 需要管理员或用户决定。

**因此，本轮没有获得任何“ego(lite) 成功迁移 Chrome Cookie/登录态”的实测证据；不把官方宣传当 PASS。**

---

## 4. 静态证据：ego(lite) 导入器实际能做什么

从安装目录 `chrome.dll`（`Application\0.6.2.5\chrome.dll`）和 `resources.pak` 解出的字符串/资源：

### 4.1 自研导入器源码路径

```
..\..\ego\browser\data_import\browser_data_importer.cc
..\..\ego\browser\data_import\browser_import_for_cli.cc
..\..\ego\browser\data_import\data_import.cc
..\..\ego\browser\data_import\data_import_ui.cc
..\..\ego\browser\data_import\import_source_user_data.cc
..\..\ego\browser\data_import\chromium\chromium_profile_cookies.cc
..\..\ego\browser\data_import\chromium\chromium_profile_display.cc
..\..\ego\browser\data_import\chromium\chromium_profile_recovery.cc
..\..\ego\browser\data_import\chromium\chromium_source_recovery.cc
..\..\ego\browser\data_import\chromium\chromium_file_util.cc
..\..\ego\browser\data_import\chromium\chromium_target_commit.cc
```

这不是 Chromium 上游 Importer 的配置开关，而是 Ego 自带的**独立导入模块**。这直接反驳“上游没实现 Cookie，所以第三方不能新增模块”的推论。

### 4.2 涉及的数据

`chrome.dll` 中与导入相关的文件名/表名：

```
Local State
Network\Cookies
Cookies
Login Data
Login Data For Account
Web Data
History
Bookmarks
Extensions
Sessions（import_sessions_copy_failed / import_sessions_target_write_failed）
```

导入统计/错误字符串：

```
import_bookmarks_merge_failed
import_sessions_copy_failed
import_extensions_failed
import_partitioned_cookies_enumerate_failed
import_profile_files_copy_failed
import_profile_files_database_snapshot_failed
import_profile_registration_failed
import_local_state_stage_write_failed
```

### 4.3 Cookie 解密相关

```
safe_storage_dpapi_key_missing / invalid / decrypt_failed
safe_storage_app_bound_key_unavailable
safe_storage_app_bound_decrypt_failed
app_bound_setup_missing
app_bound_uac_denied
app_bound_registration_failed
app_bound_activation_failed
app_bound_caller_rejected
success_discarded_v20_values_missing_app_bound_key
success_discarded_v20_values_corrupt_app_bound_key
success_discarded_v22_values_missing_app_bound_key
preflight_cookies_read_back_incomplete
source_database_cookies_too_old / too_new
```

解读（基于字符串，不是源码级确认）：

- Ego 会尝试解密 `v10`（DPAPI）与 `v20`/`v22`（App-Bound）来源 Cookie。
- 如果拿不到 App-Bound key（未提升/UAC 被拒/调用者被拒），它会把 v20/v22 Cookie **丢弃**并继续（`success_discarded_*`），即可能出现“书签/历史成功、Cookie 只部分成功”的情况。
- `app_bound_caller_rejected` 与 `app_bound_uac_denied` 说明它可能尝试用提升服务/专用注册方式获取 App-Bound key；这与我们“不绕过应用身份验证”的红线冲突，不能照搬。

### 4.4 是否需要来源扩展？

- 没有任何 `chrome.cookies` 扩展桥、扩展 ID 或“安装来源扩展”的字符串。
- 代码路径是**复制来源 Profile 文件 + 本地解密/重写**（`import_profile_files_*`、`chromium_profile_cookies.cc`）。
- 因此从静态证据看：**ego(lite) 不要求来源 Chrome 安装扩展**；它要求来源浏览器关闭，并可能要求 UAC/提升服务。

### 4.5 是否关闭来源浏览器？

- `source_closed_by_ego` 是明确的“由 Ego 关闭来源”统计；
- `source_close_requests`、`post_close_waits`、`processes_captured`、`processes_remaining` 说明它会枚举/关闭来源进程并等待文件锁释放；
- 失败时返回 `import_source_browser_close_failed` / `import_source_locked_after_browser_closed`。

这与任务红线“**不得自动关闭/全局 kill 来源浏览器**”直接冲突。我们没有在真实 Chrome 上验证该行为，也不会在自己的产品里采用。

---

## 5. 成功/部分成功/失败矩阵（截至本报告）

| 数据/行为 | 官方 ego(lite) 静态证据 | 本轮实测 | 结论级别 |
| --- | --- | --- | --- |
| 来源 Chrome 安装扩展 | 未发现需要扩展的代码/文案 | 未测 | 静态：不需要 |
| 关闭来源 Chrome | `source_closed_by_ego`、`source_close_requests`、`import_source_browser_close_failed` | 未测（真实 Chrome 在运行，拒绝触发） | 静态：会关闭/要求关闭；高风险 |
| 管理员/UAC | `app_bound_uac_denied`、`app_bound_setup_missing`、`app_bound_registration_failed` | 未测 | 静态：v20 路径可能请求 UAC；未确认是否总是需要 |
| 书签 | `import_bookmarks_merge_failed`；CLI/onboarding 支持 | 未完成 onboarding 导入 | 静态：支持；未 e2e |
| 历史 | `import_history_sync_state_clear_failed`；来源文件 `History` | 未 e2e | 静态：支持；未 e2e |
| Cookie（HttpOnly/SameSite/Session/Partitioned） | `chromium_profile_cookies.cc`、`import_partitioned_cookies_enumerate_failed`、`safe_storage_*` | **未执行** | 静态：支持/尝试；v20 可能丢弃；**未验证登录** |
| 密码 | `Login Data`、`Login Data For Account`、`safe_storage_*` | 未执行 | 静态：支持/尝试；v20 同上；未验证 |
| 扩展 | `import_extensions_failed` | 未执行 | 静态：复制扩展目录；未验证 |
| Profile（整包克隆） | `import_profile_registration_failed`、`chromium_target_commit.cc` | 未执行 | 静态：支持；未验证 |
| Tabs/会话 | `import_sessions_copy_failed`、`import_sessions_target_write_failed` | 未执行 | 静态：支持；未验证 |
| 关闭并重启 ego 后会话仍有效 | 官方宣称；CLI 有 `--clear-existing-profiles` 重启说明 | 未执行 | **未验证** |
| 多浏览器来源 | CLI 列出 chrome/edge/brave/comet/opera/vivaldi/yandex/firefox/zen/arc/dia | 仅 Brave 负例 | 静态：多来源；未 e2e |

**不得**把“代码里有 Cookie 导入”写成“Windows 登录态迁移 PASS”。本报告没有任何一条真实登录态迁移的成功证据。

---

## 6. 为什么完整实测被阻塞（需要用户/环境决策）

要在不接触真实用户 Profile 的前提下完成 Ego 的 Chrome 导入实测，至少需要满足其一：

1. **独立 Windows 用户或独立 Windows VM / Windows Sandbox**，其中没有真实 Chrome Profile；在该环境中把隔离测试 Chrome Profile 放到标准 `%LOCALAPPDATA%\Google\Chrome\User Data\Default`，登录本地测试站，再运行 Ego 导入。
   - 本机是 Windows 11 Home（CoreCountrySpecific），Windows Sandbox 不可用；创建本地用户/VM 需要管理员权限。
2. 或者用户明确授权：关闭所有真实 Chrome 窗口，并接受 Ego 可能自动关闭/重启 Chrome、可能弹出 UAC 的风险；同时在导入前后对真实 Profile 做完整哈希并接受“Ego 读取真实 Profile”的事实。
   - 这违反本任务“绝不接触真实用户 Profile”的红线，**本轮不做**。

可复现步骤（留给下一阶段在干净环境执行）：

```text
1. 在干净 Windows 用户/VM 中安装官方 ego(lite) 0.6.2.5。
2. 用隔离 Chrome（--user-data-dir=<clean>\ChromeTest）打开本地测试站并登录；
   记录 Cookies/Login Data/History/Bookmarks 的 SHA-256 与文件清单。
3. 启动 ego(lite)，完成 onboarding（不要选真实 Chrome）。
4. ego-browser import list                  # 记录发现的 browser/profile
5. ego-browser import --browser chrome --profile Default --no-default
6. 记录：是否要求关闭 Chrome、是否出现 UAC、是否自动关闭 Chrome、
   导入结果 JSON、目标 Ego Profile 的 Cookies 前缀/行数、哪些 Cookie 被丢弃。
7. 用本地测试站验证 Ego 内是否 LOGGED IN；关闭并重启 ego(lite) 再验证。
8. 重新对来源 Profile 做 SHA-256/文件清单，确认只读。
9. 对 v20：确认测试 Chrome 是否为默认 user-data-dir + system install；
   如果不是，测试只覆盖 v10，不能宣称覆盖 App-Bound。
```

---

## 7. 原始证据路径

| 内容 | 路径 |
| --- | --- |
| 官方安装 stub | `D:\work\wt\egolite-evidence\download\egoliteSetup-0.6.2.5.exe` |
| 完整 crx3 | `D:\work\wt\egolite-evidence\download\ego-0.6.2.5-x64.crx3` |
| 解包后的 mini installer | 校验/安装后已删除，可由 `ego-0.6.2.5-x64.crx3` 重新解出（内层文件 644,261,016 字节） |
| Omaha 日志（含下载失败/签名 URL） | `D:\work\wt\egolite-evidence\logs\updater-copy.log`（原始位置 `C:\Users\65487\AppData\Local\Temp\updater.log`） |
| Ego 静态证据 JSON | `D:\work\wt\egolite-evidence\logs\ego-static-evidence.json` |
| Ego 运行时结果 JSON | `D:\work\wt\egolite-evidence\logs\ego-runtime-results.json` |
| Ego `resources.pak` 解包资源 | `D:\work\wt\egolite-evidence\logs\pak\`（60000+ 资源 ID） |
| 安全负例原始返回 | `ego-runtime-results.json` 的 `brave_negative` / `absolute_path_as_browser_source` |
| 测试站点 | `D:\work\wt\egolite-evidence\testsite\server.mjs` |
| 测试 Chrome Profile | `D:\work\wt\egolite-evidence\profiles\chrome-source`（仅测试数据） |

未提供截图：所有交互均通过 CDP/应用自身 API 完成，没有可见窗口验收；因此不以截图作为成功证据。

---

## 8. 结论（本报告可负责的部分）

1. 官方 ego(lite) Windows 0.6.2.5 **确实内置了自研的多浏览器导入模块**，代码路径覆盖 Cookies、Login Data、History、Bookmarks、Extensions、Sessions、Profile，而不是只做书签/历史。
2. 它**不要求来源 Chrome 安装扩展**（静态证据）；但会**关闭/要求关闭来源浏览器**，并可能为 App-Bound 数据请求 UAC/提升服务。
3. 在本机（真实 Chrome 运行、无隔离 Windows 用户/VM、源根不可重定向）**无法安全完成** Chrome Cookie/登录态导入实测；因此：
   - “ego(lite) Windows 能迁移 Chrome 登录态”仍是**官方宣称 + 静态证据**，不是本轮实测 PASS；
   - “ego(lite) 一定成功”不成立，尤其 v20/v22 存在明确的 `success_discarded_*` 丢弃路径；
   - “必须来源+目标双扩展”也不成立：ego(lite) 和 Edge 都走了原生导入路线（但它们的 v20 路线可能越过我们的安全边界）。
4. 任何后续实测必须在**独立 Windows 用户/VM**中进行；在此之前，不应基于 ego(lite) 的宣传修改 Browser CLI 的产品结论。
