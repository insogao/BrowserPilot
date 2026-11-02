---
type: VerificationReport
status: stable
generated: { by: zcode, at: 2026-11-02T10:45:00+08:00 }
stale_after: 2027-02-02
---

# Native Messaging Host 重启 RC 验证（Windows / WinRelease，2026-11-02）

状态：**PASS**（矩阵 196/196；8 窗口 WinRelease 长稳含真实 host restart PASS）
工作区：`D:\work\wt\bp-host-restart`，分支 `agent/rc-host-restart`（BrowserPilot PR #1 base `9761e2e`）。
浏览器：`D:\c\src\out\WinRelease\chrome.exe`（非 component，Chromium 156.0.8067.0）。
Native host：本轮 `native-host/dist/browserpilot-host-*.exe`（Node SEA，真实 `connectNative` 拉起）。

本文回答 RC 审计中此前唯一 **BLOCKED** 的 Host-restart 项：真实 Native Messaging Host
在正常退出、异常终止、与 SW 重启交错、in-flight 请求、重连握手、旧连接/旧授权、
过期输入权等场景下的行为。所有结论来自真实 Chrome + 真实扩展 SW + 真实 host 进程，
没有 mock，也没有把“只测协议”当作 E2E。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 真实 host 正常退出（native port EOF） | PASS：host 自行退出、session 文件清理、in-flight 请求显式 `HOST_DISCONNECTED` |
| 真实 host 异常终止（验证式 `taskkill /PID`） | PASS：旧 PID 退出、旧 TCP 连接失效、Chrome 自动拉起新 host |
| Host/SW 重启交错 | PASS：host 与 SW 同时停止后唤醒，最终恰好 1 个 host，无重复进程/连接 |
| in-flight 请求 | PASS：硬杀/正常退出都在 4.3–4.5s（硬杀）或 0.5s（正常退出）内显式失败，不挂到 2 分钟超时 |
| 重连握手 | PASS：新 `instanceId`、新 port/token/profile；无 token 的私有命令被拒绝；公开 `ping` 仍可用于发现 |
| 旧连接/旧授权 | PASS：旧 TCP socket 关闭；新连接必须重新认证；旧连接上的授权不迁移 |
| 旧实例结果隔离 | PASS：旧 host 的迟到结果（即使 client/seq 与旧实例完全相同）不会误路由到新 host 的新请求 |
| 过期/stale AI 输入所有权 | PASS：HUMAN ownership 不复活；过期 ASSIST grant 重连后仍为 null 且输入 fail closed；旧 agent 活动在连接前保持 false |
| 重复 host / 泄漏 pipe | PASS：每次 restart 后恰好 1 个 host（两种模式共 2 个），旧 PID 全退出；host TCP 连接 1 条；HandleCount 250–254 量级、无增长 |
| Normal + Agent 模式恢复 | PASS：normal 与 agent/managed（`InputOwnershipEnforcement`）都在重连后恢复 `ping`/`js`/`list_tabs`/截图 |
| 8 窗口 WinRelease 长稳（含真实 host restart） | **PASS**：1200s、8/8 窗口持续存活、t=600s 真实重启两种模式的 host，恢复后全部窗口可操作；0 crash/FATAL |

矩阵最终全量命令结果：`PASS 196/196 checks`（normal + agent 在同一次运行中；两种模式
单独复跑亦 PASS）。
长稳结果见 §5。

---

## 2. 代码变更（本地提交）

### 2.1 `native-host/host.js`

1. **Host 实例 ID**：每次启动生成 16 hex `hostInstanceId`，写入：
   - `get_ready_state` / `ready` 事件（新字段，向后兼容）；
   - session 文件 `<port>.json`（`instanceId`）；
   - 转发给扩展的内部请求 ID：`bp:<instanceId>:<clientSeq>:<requestSeq>`。
2. **旧实例结果隔离**：host 重启后，旧 SW 命令返回时携带旧实例 ID，新 host 的 pending 表
   永远不可能命中，即使新连接的 `clientSeq/requestSeq` 与旧请求完全相同。这消除了
   “旧命令结果被当成新请求结果”的跨实例误路由。
3. **正常退出显式失败 in-flight**：`shutdownFromPort()` 在退出前对每个 pending 的 TCP
   请求写一条 `{ok:false, error:"host_disconnected", errorCode:"HOST_DISCONNECTED"}`，
   再 half-close；100ms 刷新窗口后退出。硬杀无法执行此函数，由客户端侧兜底。
4. **关闭竞态**：`shuttingDown` 后不再接受新 TCP 连接、不再向扩展写帧；server close +
   session 文件清理仍在同一路径完成。

### 2.2 `native-host/client.mjs`

1. `sendAtPort` 新增 `end`/`close`/`error` 处理：连接在结果前断开时返回显式
   `{ok:false, error:"host_disconnected", errorCode:"HOST_DISCONNECTED"}`，不再等 2 分钟。
2. 超时也返回显式 `host_request_timeout` / `HOST_TIMEOUT`。
3. host 发现逻辑仍只接受 `ok:true && data.pong:true`，显式错误不会被误判为可用 host。

### 2.3 Native host 注册：Chromium 键（RC 阻塞根因之一）

WinRelease 是非 branding 的 Chromium 构建。Chromium 的
`chrome/browser/extensions/api/messaging/launch_context_win.cc` 在 Windows 上**先读**
`HKCU\Software\Chromium\NativeMessagingHosts`，只有该键不存在时才回退到
`HKCU\Software\Google\Chrome\NativeMessagingHosts`。

本机另一个 Browser CLI 测试在 `HKCU\Software\Chromium\NativeMessagingHosts` 留下了
`com.browserpilot.browseragent` manifest，其 `allowed_origins` 是另一个扩展 ID
（`ljoekiddijnohefaghljlcodgljienoj`）。于是 Chrome 读到该 manifest 后直接返回
`Access to the specified native messaging host is forbidden.`，不会回退到本仓库的
Chrome 键；表现为 host 有时能启动、有时连续 90s 无法启动，且与我们的 host 代码无关。

修复：

- `native-host/register.ps1` / `unregister.ps1` 新增 `-IncludeChromium` 目标；
  backup 的 `targets[]` 同时记录 Chrome/Chromium 原值并逐字恢复。
- `package.json` 的 `register-host` / `unregister-host` 默认带 `-IncludeChromium`。
- `scripts/test-native-host-restart-e2e.mjs` 和 `scripts/test-native-e2e.mjs` 都注册两个键，
  结束核验两个键都恢复测试前值；不写 HKLM，不删除/改写别的 host。
- 这是 Browser CLI（Chromium branding）部署要求：安装/注册脚本必须带
  `-IncludeChromium`，否则可能被 Chromium 键下另一个 manifest 遮蔽。

### 2.4 测试

- `native-host/test-host.mjs` 扩展为协议门禁：
  - auth + 动态端口 + 每客户端结果隔离；
  - 旧实例 ID 结果不会被路由；
  - native-port EOF 时 pending 请求收到显式 `HOST_DISCONNECTED`；
  - 两个 host 启动的 `instanceId` 不同；
  - 官方 `client.mjs` 在 graceful EOF / hard reset 下都快速返回显式 JSON 错误。
- 新增 `scripts/test-native-host-restart-e2e.mjs`：真实 WinRelease + 真实扩展 + 真实 host
  的重启矩阵与 8 窗口长稳（复用 `scripts/lib/test-process.mjs`、`host-manifest.mjs` 和
  现有 native E2E 的注册/发现/CDP 模式）。
- `package.json` 新增 `test:e2e:host-restart[:normal|:agent|:longrun]`。

---

## 3. 测试矩阵（真实链路）

每个模式下顺序执行 5 个场景；两种模式（normal / agent）各跑一遍：

| 场景 | 断言（摘要） |
| --- | --- |
| unexpected-host-kill | 先启动 30s `waitForTimeout`，再 handoff 为 HUMAN，验证式 hard kill；旧 PID 退出、旧 socket 关闭、in-flight 显式 `HOST_DISCONNECTED`；新 host 新实例；无 token 私有命令被拒；HUMAN ownership 不复活；`claim_space` 后 `js` 恢复；另一个 agent 不能继承旧 space |
| stale-result-isolation | 在全新 H1 上只开 1 个客户端，发 6s 命令后杀 H1；H2 上只开 1 个客户端，发 12s 命令；旧结果在新请求 pending 期间返回；新请求仍返回 `waitedMs=12000` 且耗时 ≥10s（旧结果被实例 ID 丢弃） |
| normal-host-exit | 6s in-flight 时停止 SW；host 因 stdin EOF 自行退出；session 文件删除；in-flight 显式 `HOST_DISCONNECTED`；唤醒 SW 后新 host；`ping`/`js` 恢复；无重复 host |
| host-sw-interleave | 同时发起 SW 停止与 host hard kill；两者都消失后唤醒 SW；新 host；等待 3s 后仍恰好 1 个 host、旧 PID 不在存活 session；旧连接失效；命令恢复 |
| expired-grant-not-resurrected | 通过 popup 用户入口 `human_presence` + `grant_input` 进入 ASSIST 并发放 1 次 60s grant；等待过期后 `input_status.grant=null`、`js` 拒绝；hard kill 后重连；仍 `grant=null`、输入仍 `INPUT_ASSIST_REQUIRES_GRANT`；清理后命令恢复 |

所有进程清理都使用 `stopVerifiedPid`（精确 PID + exe 路径 + 创建时间）或
`stopTestProcess`（PID + 创建时间 + marker + exe 路径）；没有镜像名 kill，没有全局 kill，
没有触碰用户 Chrome/ZCode 进程。HKCU 注册表在运行前备份、结束后恢复并逐字核验。

---

## 4. 关键实测数字（矩阵）

以下取自 2026-11-02 最终全量运行 `.e2e-tmp/host-restart-2026-11-02T02-36-52-823Z/artifacts/report.json`：

| 指标 | normal | agent |
| --- | --- | --- |
| hard kill 耗时（验证式 taskkill） | 0.73s | 0.75s |
| hard kill 后 in-flight 显式错误（从命令开始计） | 4.24s | 4.25s |
| hard kill 后新 host 重连 | 3.70s | 3.49s |
| SW 停止后 host 自行退出 + in-flight 错误 | 0.53s | 0.53s |
| SW 唤醒后新 host | 0.53s | 0.51s |
| 交错重启后新 host | 0.53s | 0.51s |
| 每次 restart 后 host 进程数 | 1 | 1 |
| host TCP established（单客户端） | 1 | 1 |
| host HandleCount | 253–254 | 253–254 |
| 旧实例迟到结果误路由 | 0 | 0 |
| 过期 grant 重连后可用 | 0 | 0 |

---

## 5. 8 窗口 WinRelease 长稳（含真实 Host restart）

命令：

```bash
node scripts/test-native-host-restart-e2e.mjs \
  --longrun --no-build --duration=1200 --restart-at=600 --sample-interval=15
```

配置：两个隔离 profile（normal / agent 各 4 个 `open_space` 窗口，共 8 窗口）；
agent 使用 `--browser-cli-background-presentation` + `InputOwnershipEnforcement`；
soak 1200s；每 15s 采样 host/Chrome 进程、handle、TCP、`ping`、每窗口 `list_tabs`，
每 60s 每窗口 `js`；t=600s 对两种模式的 host 执行真实验证式 hard kill 并等待 Chrome
重新拉起，再验证 8 个窗口的 `list_tabs`/`js`。managed-hidden agent 窗口按 C gate 的
同一规则不做周期截图（避免截图掩盖 presentation feedback 问题），通过产品命令验证存活。

结果：**PASS**（`longrun-report.json`；证据目录见 §7）。

- soak 1200s；156 次双模式采样全部 `hostAlive/chromeAlive/allWindowsOk/pingOk=true`。
- t=601s host restart：
  - normal：PID `17292` → `15156`，instance `77af7bc63bb2bc75` → `0f7c8c6c7d9e9ffd`，
    kill 743ms，重连 2583ms；
  - agent：PID `28220` → `36580`，instance `71b9f2a08bb1df8e` → `701d3cdace8d412f`，
    kill 756ms，重连 2591ms；
  - 两个旧 PID 都退出、旧客户端连接都关闭，restart 后每个模式的 4 个窗口
    `list_tabs`/`js` 全部恢复。
- 结束时恰好 2 个 host 进程（两种模式各 1），PID/session/命令行匹配，旧 PID 全退出。
- 结束时 8 个窗口仍可操作；normal 窗口最终截图均为合法 PNG。
- Chrome 日志无 `FATAL` / `DCHECK` / `layer_tree_view.cc:554` / renderer/GPU crash 行
  （`crashes=[]`）。
- 资源有界（两模式合计）：host PrivateBytes 53.10MB → 53.15MB、HandleCount 506 → 500；
  Chrome PrivateBytes 348.9MB → 340.9MB、HandleCount 4238 → 4121；无持续放大。
- 清理后 `remainingHosts=[]`、`remainingSessions=[]`；HKCU 恢复原值。

最终代码（含 `-IncludeChromium` 双键注册）另跑了一次 90s 长稳 smoke：
`.e2e-tmp/host-restart-2026-11-02T02-42-17-481Z/`，`PASS 31/31`，t=45s 两种模式
host restart PASS，8 窗口恢复；证明最终提交的长稳入口本身可用。上面的 1200s 运行是
稳定性证据（host 确实被启动并重启：session/instance/PID 均在证据中）。

### 5.1 C 的 BLOCKED 项转换

C 的 20 分钟 WinRelease 长稳（`D:\work\wt\bc-longrun\docs\windows-longrun-stability-gate-2026-11-01.md`
§8）结论为“唯一 BLOCKED：Native Messaging Host restart 未执行（gate 没有 host 进程）”。
本轮在同样的 WinRelease、8 窗口、1200s 长稳中加入**真实** Native Messaging Host（两个
隔离 profile 各 1 个 host）并在 t=600s 真实重启两者；host restart 项判定为 **PASS**，
不再是 BLOCKED。注意：本轮使用独立的 BrowserPilot host-lifecycle gate，而不是修改
C 的 `bc-longrun` 仓库/工作树；C 文档本身未改写，转换证据在本文件与
`longrun-report.json`。

---

## 6. 剩余边界 / 未覆盖

1. **平台**：仅 Windows 10.0.26200 + WinRelease；macOS/Linux 未跑。
2. **Capability token 语义**：SEA host 的 `authToken` 是编译期 build token，跨 host
   重启保持不变（这是现有的外部 AI 能力凭据设计）。因此本轮验证的是：
   - 旧 **TCP 连接** 在 host 退出后失效；
   - 新连接必须重新做 per-connection 认证（无 token 的私有命令 → `authentication_required`）；
   - 旧连接上的 `bpAuthenticated` 不迁移。
   如果 RC 要求“旧 capability token 本身也必须失效”，需要单独改成每进程随机 token
   （并同步 client 发现/session 消费方）；本轮没有做这个设计变更。
3. **Pipe 计数**：Windows 匿名 native-messaging pipe 没有免安装的逐句柄枚举工具；
   本轮用“host 进程数 + TCP established + HandleCount”作为泄漏代理，并验证旧 PID 全退出、
   新 host HandleCount 稳定在 253–254。没有使用 Sysinternals handle.exe。
4. **managed-hidden 截图**：按 C gate 规则跳过周期截图；agent 窗口的存活通过
   `list_tabs`/`js` 验证。若需要 managed-hidden 截图新鲜度，应回到 C gate 的 CDP probe。
5. **长时间**：20 分钟，不是 24h/小时级 soak；未覆盖 host 进程被系统 OOM/杀软终止等外部原因。
6. **未覆盖**：签名/安装器/更新、macOS keychain、真实用户桌面交互、host 与 Chrome
   同时崩溃、host 升级替换 exe（本测试每次 build 新 exe，但运行中不替换）。
7. **并行 native-host 测试的 HKCU 干扰**：本轮观察到另一个 Browser CLI 测试在
   `HKCU\Software\Chromium\NativeMessagingHosts` 写入不同扩展 ID 的 manifest
   （`D:\work\.tmp-browsercli\e2e-all*`）。这正是 §2.3 的 forbidden 根因。测试已用
   `-IncludeChromium` 覆盖并在结束后恢复原值；但多个 native-host 测试并行时仍可能
   互相改变同一 HKCU 键。CI 应串行化，或为每个测试使用独立 `-RegistryRoot`
   （当前真实 E2E 为验证产品路径必须用真实 HKCU，故只做备份/恢复）。
8. **Browser CLI 部署要求**：安装/注册必须带 `-IncludeChromium`；只注册 Chrome 键时，
   若 Chromium 键下存在另一个 `com.browserpilot.browseragent` manifest，Chromium-branded
   浏览器会直接 forbidden，不会回退。`npm run register-host` 已默认带上。

---

## 7. 复现与证据

```bash
# 协议门禁（无浏览器）
npm run test:host
npm run test:host:exe

# 重启矩阵（真实 WinRelease + 真实 host；默认先 build）
node scripts/test-native-host-restart-e2e.mjs
node scripts/test-native-host-restart-e2e.mjs --mode=normal --no-build
node scripts/test-native-host-restart-e2e.mjs --mode=agent --no-build

# 8 窗口 20 分钟长稳 + t=600s 真实 host restart
node scripts/test-native-host-restart-e2e.mjs \
  --longrun --no-build --duration=1200 --restart-at=600 --sample-interval=15
```

证据位置：

- 矩阵：`.e2e-tmp/host-restart-<timestamp>/artifacts/report.json`、`checks.json`、
  `mode-normal.json`、`mode-agent.json`、`chrome-normal.log`、`chrome-agent.log`；
  本轮最终全量运行：`.e2e-tmp/host-restart-2026-11-02T02-36-52-823Z/`。
- 长稳：同目录 `longrun-report.json`、`longrun-samples.jsonl`、
  `longrun-normal-*-*.png`（normal 截图）、`chrome-normal.log`、`chrome-agent.log`；
  本轮 20 分钟运行：`.e2e-tmp/host-restart-2026-11-02T01-33-32-542Z/`。
- 仓库内精简证据：`docs/evidence/host-restart-rc-2026-11-02.json`。
- 证据副本：`D:\c\logs\browserpilot-host-restart-<timestamp>.json`、
  `D:\c\logs\browserpilot-host-restart-longrun-<timestamp>.json`。
