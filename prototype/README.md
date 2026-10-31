# One-source-extension + native target prototype

状态：**目标侧链路已在 Chrome 156 替身和 Browser CLI 156.0.8067.0 上验证（写入/登录/重启）；来源扩展代码已完成但未能在 branded Chrome 156 中执行（安装限制）。**
这是设计/prototype，不是已交付产品功能；没有修改现有 Broker，也没有修改 Browser CLI/BrowserPilot 产品代码。

## 1. 目标

在不扩大现有双扩展 + Broker 的前提下，验证一条更简单的 Cookie 迁移链路：

```
来源 Chrome/Edge/Brave（已登录）
  source-extension（仅来源端一个扩展）
    chrome.cookies.getAll({domain})
        │  POST /import  (127.0.0.1, 一次性 pairing token)
        ▼
Browser CLI native import command（目标端，新增）
    校验 token/domain/大小 → 通过浏览器自身 CookieStore 写入
        │
        ▼
目标 Profile 已登录（不需要目标扩展）
```

为什么不是 Broker：

- Broker 适合“来源扩展 ↔ 目标扩展”的中转；如果目标端有原生 Cookie 写入接口，就不需要第二个扩展，也不需要 Broker。
- 单来源扩展把信任面减半：用户只安装一个扩展；目标端不暴露 `chrome.cookies` 给任何扩展。
- 目标写入由浏览器自身完成，Cookie 由目标 OSCrypt 加密，避免直接写 SQLite。

## 2. 组件

### 2.1 `one-source-extension/`

MV3 扩展：

- `permissions`: `cookies`, `tabs`, `storage`
- `host_permissions`: 仅本地测试站与 loopback（生产按用户选择域名动态授权/按域名过滤）
- `background.js`: `exportCookies({domain, token, endpoint})`
- `popup.html/js`: 用户点击“Import current site”，读取当前标签页域名，调用上述函数
- 读取字段：`name/value/domain/path/secure/httpOnly/sameSite/session/expirationDate/partitionKey`
  - HttpOnly：`chrome.cookies` 可直接读取
  - Session：`session=true`，无 `expirationDate`
  - Partitioned：`partitionKey.topLevelSite` / `hasCrossSiteAncestor`

用户流程：

1. 用户在来源浏览器安装扩展（商店/策略/手工加载）。
2. 打开要迁移登录态的站点，点击工具栏按钮。
3. 输入 Browser CLI 终端打印的 pairing code（或由原生接口一次性注入）。
4. 扩展把当前域名的 Cookie POST 给 loopback；目标写入后显示 applied/failed 计数。
5. 用户在目标浏览器打开站点确认登录；结果三态记录，不把“写入数”当“登录成功”。

### 2.2 `native-target.mjs`（替身）

仅用于验证目标侧契约：

- `--port 18082 --cdp http://127.0.0.1:9234 --token <pairing-code>`
- 只监听 `127.0.0.1`；Bearer 式 `x-bp-token`；body 上限 8 MiB；Cookie 条数上限 2000。
- 通过 CDP `Storage.setCookies` 写入目标 Chromium Profile（真实 Browser CLI 应改为 browser-native CookieStore/mojo 接口，而不是调试端口）。
- 只输出 applied 计数；不输出域名、Cookie 名/值。

生产化时应替换为 Browser CLI 内部命令，例如：

```text
browser-cli import-cookies --from-extension
  - 生成随机 pairing code，打印到终端（仅本次进程）
  - 监听 127.0.0.1 的随机端口（或从已有本地 socket 读取）
  - 只接受 extension origin + pairing code
  - 校验 domain 与用户选择一致；限制大小/条数/过期时间
  - 通过 Profile 的 CookieStore 写入（native/mojo），保留
    HttpOnly / SameSite / Secure / Session / partitionKey
  - 结果：cookiesWritten / failed / failuresByReason；loginVerified 由用户确认
```

## 3. 安全要求（必须保持）

1. 目标接口只绑定 loopback；不得监听 0.0.0.0。
2. pairing code 每次随机、短 TTL、一次性；不得硬编码。
3. Cookie 只在“来源扩展内存 → 本机 loopback → 目标 CookieStore 内存”之间流动；不落盘、不写普通日志、不上传。
4. 不记录 Cookie 名/值/域名（计数和失败原因可以记录）。
5. 来源扩展必须由用户点击触发；默认不导出全部域名；按当前站点/用户勾选域名。
6. 目标写入走浏览器自身 CookieStore；不写 `Cookies` SQLite，不复制 `Local State`/密钥。
7. 不承诺“写入成功=登录成功”；设备绑定/WebAuthn/风控可能导致失效，必须用户实际验证。
8. 不通过注入 Chrome、提取密钥、调用 Chrome elevation service 或伪造路径来读取 v20。

## 4. 已得到的验证结果

| 项 | 结果 |
| --- | --- |
| 来源读取（CDP `Storage.getCookies`，与扩展 `chrome.cookies.getAll` 同语义） | 3/3：`sid`（HttpOnly/Lax/持久）、`sessonly`（HttpOnly/Strict/Session）、`part`（HttpOnly/Secure/SameSite=None/Partitioned） |
| 目标 loopback `POST /import` → `Storage.setCookies` | `applied=3, failed=0` |
| 目标站点登录 | `LOGGED IN`，cookies seen `sid,sessonly,part` |
| 目标重启后 | `LOGGED IN`，cookies seen `sid,part`；Session Cookie 按预期丢失 |
| 来源扩展在 branded Chrome 156 执行 | **BLOCKED**：`--load-extension` 被忽略；CDP `Extensions.loadUnpacked` 返回 id，但 `chrome-extension://.../popup.html` 为 `ERR_BLOCKED_BY_CLIENT`；拖放 zip 也未获得 dragged path |
| Browser CLI 156.0.8067.0 目标 | **测试配置下 PASS**：`--in-process-gpu --disable-gpu-compositing`（无 `--no-sandbox`）启动；来源 3/3 写入 Browser CLI CookieStore；写后可见 `sid`/`sessonly`/`part`；重启后 `LOGGED IN`（`sid`+`part`） |

证据：`D:\work\wt\egolite-evidence\logs\chrome-native-path-results.json`、`D:\work\wt\egolite-evidence\logsrowser-cli-cookie-acceptance.json`

限制：

- 测试 Chrome 使用自定义 `--user-data-dir`，ABE 未启用，Cookie 前缀为 **v10**；v20 未测试。
- 来源扩展未在真实 Chrome 中执行；生产前需在允许加载扩展的 Chrome（商店安装/企业策略/Chrome for Testing）中补一次 e2e。
- Browser CLI 原生命令尚未实现；Browser CLI 上的验证使用 CDP `Storage.setCookies` 作为原生命令的替身，证明写入/持久化可行，但不等于产品命令已交付；配对码/用户授权流程与 Agent Space 未验证。
- Browser CLI 在本环境需要 `--in-process-gpu --disable-gpu-compositing` 才能稳定运行（与正在运行的 BrowserPilot 实例一致）；未使用 `--no-sandbox`。

## 5. 为什么这是当前最简合规路径

- 对 v20：来源 Chrome 自己通过 `chrome.cookies` 解密，不需要任何密钥提取/提升服务。
- 对 HttpOnly/Session/Partitioned：官方 API 完整保留语义。
- 目标端只需要一个原生写入接口，不需要目标扩展、Broker、双端配对。
- 开发量可控：扩展 ~200 行；原生命令预计数百到一千行（含 pairing、校验、CookieStore 写入、三态结果、测试）。

## 6. 运行 prototype

```text
# 1. 启动目标 Chromium（测试用；生产由 Browser CLI 自己提供）
chrome.exe --user-data-dir=<target> --remote-debugging-port=9234 ...

# 2. 启动 loopback target
node prototype/native-target.mjs --port 18082 --cdp http://127.0.0.1:9234 --token test-token

# 3. 在允许加载扩展的 Chromium 中加载 one-source-extension/
#    打开测试站点，点击扩展按钮，输入 pairing code

# 4. 验证
#    - 目标浏览器打开测试站点应为 LOGGED IN
#    - 关闭/重启目标浏览器，持久 Cookie 仍应登录
```

注意：不要在真实用户 Chrome Profile 上运行本原型；测试必须使用隔离 Profile/测试账号，且不要用 `--no-sandbox`。
