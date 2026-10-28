# P0 多 Agent 并发与状态管理（2026-10-28）

本轮目标：让不同 Agent 在不同 Task Space 上的完整流程（含 `run_template`、截图、页面操作）真实并行，
同一 Space 内严格互斥；同时修复截图超时后的请求泄漏/污染，以及 Windows CI 上 `registry:check`
的 CRLF 误判。

## 1. 租约模型（keyed foreground lease）

### 1.1 三类命令

| 类别 | 命令 | 租约 key | 并发语义 |
|---|---|---|---|
| 真正全局的窗口呈现 | `ensure_visible`；`open_space`；显式 `focus/visible` 的 `open_tab`、`switch_tab` | `global` | 全进程串行（同一时刻只有一个前台窗口，并行会互相覆盖） |
| 只影响单个 Task Space | `run_template`、`open_tab`（后台）、`switch_tab`（后台）、`close_tab`、`use_space`、`claim_space`、`handoff_space`、`complete_space`、`close_space`、`start_mask`、`stop_mask` | `space:<spaceId>` | 同一 key 互斥（fail fast `FOREGROUND_BUSY`）；不同 key 真实并行 |
| 纯后台 | `snapshot`/`readText`/`screenshot`/`scroll_screenshot`/点击输入/`js`/等待/`tab_cdp_call`/下载/`list_tabs` 等 | 无租约 | 不参与前台租约；不同窗口完全并行 |

判定逻辑集中在 `src/background/foreground-lease.ts` 的 `foregroundLeaseScopeFor()`；`resolveForegroundLeaseTarget()`
把 `spaceId`/`name`/当前 `activeSpaceIds[clientId]` 归一成 `space:<spaceId>`。尚未绑定 Space 时退化为
`space:pending:<clientId>`（该命令内部会绑定当前聚焦窗口；同 client 串行、不同 client 各自绑定）。

### 1.2 `run_template` 不再整段持有全局租约

- 入口 `dispatch()` 先 `ensureCommandSpace()`，随后按 **space key** 取租约并整段持有；
  内部每个步骤继承 `_foregroundLeaseToken`，同 key 重入（只续期，不重复加锁）。
- 不同 Space 的两个 `run_template` 因此可以真实重叠；实测见 §4.2。
- 模板里的 `ensure_visible`（显式前台运行）会额外按 `global` 取一次租约，步骤结束即释放；
  后台运行默认不调用 `ensure_visible`。
- 取消代际改为 **按 Agent 隔离**（`templates.ts` 的 `clientRunGenerations`）：
  一个 Agent 的 `stop` 只会取消自己的模板运行，不会误伤其它 Agent 并行的模板。
  popup/内部 `stop`（无 Agent 身份）仍然全局取消。

### 1.3 状态与所有权

- 复用 `state.ts` 的 `SpaceState.ownerClientId` / `ownership`，没有第二套 ownership 状态机。
- 新增 `GlobalState.foregroundLeases: Record<key, ForegroundLeaseRecord>`；每条记录包含
  `token/key/scope/ownerClientId/spaceId/startedAt/expiresAt`。
- 旧版单条 `foregroundLease`（v1）保留只读兼容：首次加锁时迁移为 `global` key，仍会挡住前台操作直到过期。
- TTL 90s，每 30s 续期；每次加锁先清理过期项。release 只删除 token 匹配的 key。
- `stop`（Agent 作用域）用 `deleteForegroundLeasesFor()` 只删除调用者自己的 key。

## 2. 截图超时与错误传播

### 2.1 超时清理（`cdp.ts`）

- 每次截图尝试登记到 per-tab pending 表（`pendingScreenshotAttempts(tabId)`）。
- `withTimeout()` 超时后：
  1. 立即从 pending 表移除该 attempt（计数 `abandoned`）；
  2. 给底层 `chrome.debugger.sendCommand` promise 挂 `then/catch` 消费器：迟到的帧只记
     `lateSettles` 并丢弃，不会成为 unhandled rejection，也不会串到下一次截图
     （每次 send 都是独立 promise，没有共享响应表）；
  3. 拒绝本次尝试并走 `fromSurface=false` 降级。
- 双层清理：`captureScreenshot()` 的 `finally` 兜底移除所有未 settle 的 flight。
- 注意：扩展侧无法真正取消 Chrome 内部已发出的 CDP 命令；本实现保证的是
  “扩展侧不泄漏、不污染、明确拒绝”，浏览器内部请求会随标签关闭/detach 结束。

### 2.2 错误与新鲜度全链路

- `captureWithFallback()` 两条路径都失败时抛 `ScreenshotCaptureError`
  （`code="SCREENSHOT_FAILED"`），同时保留 `firstReason`、`secondReason`、`timeoutMs`，
  message 里两段原因都在；不再只留最后一次失败。
- 降级成功时 `meta.possiblyStale=true` 且 `meta.reason` 是第一条路径的真实原因（超时/空数据/错误）。
- `commands.ts` 的 `screenshot` 返回：
  `{ tabId, format, base64, screenshot: meta, possiblyStale, reason? }` —— 顶层与嵌套字段一致，
  上层只看顶层也不会把 stale 当 fresh。
- `scroll_screenshot` 新增 `staleTiles`、`freshTiles`、`staleReasons`、`durationMs`，
  `possiblyStale = staleTiles > 0`；任一行降级都会如实透传。
- `native-bridge` 原样把 `error.code` 映射为 host result 的 `errorCode`，链路一致。

## 3. CI registry 修复

### 3.1 根因

1. Windows 的 `core.autocrlf=true` 让检出的生成文件是 CRLF，而生成器输出 LF；
   旧逻辑 `assert.equal(fs.readFileSync(file,"utf8"), expected)` 逐字节比较，34 个文件全部误判过期。
2. 更深一层：详情页读取 `registry/templates/*/README.md` 时，CRLF 空行会让
   `^# .+\r?\n+` 正则残留一个 `\r`，生成结果比 LF 机器多一个空行——即使忽略 EOL 也会产生真实 diff。

### 3.2 修复

- 新增 `scripts/registry-check.mjs`：`normalizeNewlines()`（CRLF/CR → LF）、
  `sameGeneratedContent()`、`describeMismatch()`（第一处差异行号 + 实际/期望值）。
- `build-registry.mjs` 的 `--check` 先规范化换行再比较；真正的字段差异仍然 fail closed 并给出行号。
- `detailMarkdown()` 读取 README 后先 `normalizeNewlines()`，生成结果不再依赖检出 EOL。
- 新增 `.gitattributes`：`registry/catalog.json`、`bundle.json`、`INDEX.md`、`details/**` 固定 `eol=lf`。
- `test-core.mjs` 新增 CRLF/LF 覆盖：CRLF 检出必须通过，真实内容差异必须失败，差异行号必须准确。

修复前后：

```
# 修复前（逐字节比较 + CRLF 检出）
错误：生成文件已过期（34 个生成文件全部失败；另外 README CRLF 会多出一个空行）

# 修复后
npm run registry:check
PASS registry: schema + catalog + details + duplicate fingerprints
```

本次没有重写任何 `registry/` 生成文件（`git status` 中 `registry/` 无改动）。

## 4. 真实并发测试

### 4.1 方法

脚本：`scripts/test-concurrency-live.mjs`（`npm run test:concurrency:live -- --windows=8`）。

- 启动 `D:\work\wt\browser-cli-baseline\chrome.exe`，参数：
  `--headless=new --disable-gpu --in-process-gpu --user-data-dir=<独立临时目录>
   --disable-extensions-except=<dist> --load-extension=<dist>`。
- 不使用 `--no-sandbox`；不读写用户真实 profile/窗口；结束的只是自己启动的 chrome 进程树
  与自己的 native host pid（session 文件里的 pid）。
- 经已注册的 native host（`com.browserpilot.browseragent`，TCP loopback）发真实命令；
  每个 Agent 独立 TCP 连接、独立 `agentId`。
- 每条命令记录 `start/end/duration/ok/errorCode`（`performance.now()`）。
- 截图前使用“同一墙钟时刻”的 JS 屏障对齐两个页面，避免 25–35ms 的截图因调度漂移错过重叠窗口；
  屏障本身也是并发执行的，不是串行化。

### 4.2 两个独立 Space 并发完整流程（2026-10-28 最终运行）

原始时间（ms，相对 t0；`npm run test:concurrency:live -- --windows=8`）：

| Agent | 命令 | start | end | duration |
|---|---|---:|---:|---:|
| conc-a | open_tab | 0.1 | 105.6 | 105.5 |
| conc-b | open_tab | 0.2 | 106.7 | 106.5 |
| conc-a | js (DOM) | 105.7 | 231.1 | 125.5 |
| conc-b | js (DOM) | 106.8 | 351.2 | 244.4 |
| conc-a | js (sleep) | 231.2 | 589.1 | 357.9 |
| conc-b | js (sleep) | 351.2 | 713.5 | 362.2 |
| conc-a | js (barrier) | 589.1 | 1501.8 | 912.6 |
| conc-b | js (barrier) | 713.5 | 1501.6 | 788.1 |
| conc-b | screenshot | 1501.7 | 1532.0 | 30.3 |
| conc-a | screenshot | 1501.8 | 1533.1 | 31.3 |
| conc-b | scroll_screenshot | 1532.0 | 2182.3 | 650.3 |
| conc-a | scroll_screenshot | 1533.1 | 2195.8 | 662.8 |
| conc-b | close_tab | 2196.3 | 2237.4 | 41.2 |
| conc-a | close_tab | 2199.0 | 2274.1 | 75.1 |

- 重叠区间：`screenshot` 30.2ms；`scroll_screenshot` 649.3ms；`open_tab` 124.4ms；
  `js(sleep)` 237.8ms；`close_tab` 38.5ms。
- wall = **2274.2ms**，串行和 = **4511.2ms**（49.6%）。
- 两张视口截图均 `possiblyStale=false`；两张长截图 `possiblyStale=false, staleTiles=0, staleReasons=[]`。

### 4.3 两个 Space 同时 `run_template`（模板内含操作 + 截图）

| Agent | start | end | duration |
|---|---:|---:|---:|
| conc-a | 0.0 | 670.0 | 670.0 |
| conc-b | 0.1 | 909.0 | 908.9 |

重叠 **669.9ms**；wall **909.1ms** vs 串行和 **1578.9ms**（57.6%）。
证明 `run_template` 不再整段持有进程级租约。

### 4.4 同一 Space 互斥 + 不同 Space 不受影响

`concurrency-hold` 模板（JS 持锁 1.2s）在 space A 运行期间：

| 操作 | 结果 | 时间 |
|---|---|---|
| hold 模板（space A） | ok | 0 → 1225.4ms |
| 同 space `open_tab`（agent A） | **FOREGROUND_BUSY** | 256.0 → 259.7ms（与 hold 重叠） |
| 同 space 第二个 `run_template`（agent A） | **FOREGROUND_BUSY** | 259.7 → 264.2ms（与 hold 重叠） |
| 不同 space `open_tab`（agent B） | ok | 264.3 → 367.8ms（103.5ms） |
| hold 结束后同 space `open_tab` | ok | 100.8ms |

第二个命令是明确失败（fail fast），不是交错执行；同一 Agent 的第二个命令会提示
“同一 Agent 有命令正在使用该目标”。

### 4.5 8 窗口压力

8 个独立 Agent / 8 个 Space，同时执行「open_tab → DOM 操作 → sleep → 对齐 → screenshot → 读取 → close_tab」：

- wall = **2254.6ms**，串行和 = **16731.2ms**（7.42×；13.5%）。
- 8 个 screenshot 全部成功，**最大同时并发 = 8**；无 `possiblyStale`。
- 每窗口总耗时（ms）：1965.8 / 1994.6 / 1791.4 / 2033.8 / 2198.7 / 2240.3 / 2252.4 / 2254.2。
- 全部命令 `ok=true`，无失败、无超时；压力后 `version` 仍正常（无崩溃/死锁）。
- 8 个 `complete_space` 并发关闭总耗时 **652ms**（若串行远大于此）。

### 4.6 单元测试（`npm run test:core`，离线、可重复）

新增/更新覆盖：

- 纯后台命令（截图/点击/求值/等待/CDP/下载）不取任何租约。
- 不同 Space 的 `run_template` 同时加锁；同 Space 第二个 Agent / 同 Agent 第二命令失败。
- 模板子步骤继承 token 重入；同 Agent 可同时持有自己的 space + global 租约。
- `open_space`/`ensure_visible` 仍全局串行；后台 `open_tab` 按 space key。
- 释放只清自己的 key；过期自动清理；旧版全局租约迁移；Agent stop 只删自己的 key。
- 截图超时：pending 表归零、迟到帧被丢弃且不污染下一次截图、两段错误原因都保留。
- registry CRLF/LF 规范化与真实差异失败。

## 5. 风险

1. **超时请求无法从扩展侧取消**：`Page.captureScreenshot(fromSurface=true)` 挂住时，Chrome 内部请求
   仍可能存在直到标签关闭/detach。我们只保证扩展侧 pending 表清理、迟到帧丢弃、明确拒绝。
   极端情况下（反复遮挡截图）浏览器侧可能积累未完成请求。
2. **global 呈现操作 fail fast**：显式前台的模板中途可能因其它 Agent 正在 `ensure_visible`
   而收到 `FOREGROUND_BUSY`（随后 failback）。这是有意的“明确失败”，但可见模板的并发成功率
   取决于前台操作的重叠频率。
3. **`open_space` 仍全局串行**：保守处理（创建窗口会改变桌面窗口层级）。多 Agent 同时创建
   Space 时会有短暂串行；实测单次创建约 100ms 量级。
4. **Space 粒度而非 Tab 粒度**：同一 Space 的长模板会挡住同 Space 的 `open_tab`/`close_space`/
   `handoff_space` 等 keyed 命令；不同 Tab 的纯页面动作（click/js/screenshot）不取租约，
   仍可能在同一 Space 内并行。这是“后台动作不需要前台”的刻意取舍。
5. **单 Space 模板仍整段持锁**：即使模板只做截图，也会阻塞同 Space 的 keyed 命令；
   不会影响其它 Space。
6. **截图新鲜度判定**：`possiblyStale` 只标记降级路径（fromSurface=false）。若合成器在超时前
   返回了旧帧，仍会被当作 fresh（Chrome 语义，无法从扩展侧区分）。
7. **SW 被回收**：租约 TTL 90s，内存定时器消失后靠过期清理；正在跑的模板可能失去续期，
   最长 90s 后同 Space 可被他人获取。未做 SW 重启期间的端到端测试。
8. **测试环境**：live 测试依赖已注册的 native host 与 baseline Chromium；headless 下没有真实遮挡，
   截图降级路径只在单元测试中覆盖。`docs/dev/task-spaces.md` 仍描述旧的全局租约模型，需后续文档同步
   （不在本轮文件边界内）。

## 6. 仍未覆盖

- 可见窗口被其它窗口完全遮挡时的真实降级截图（需要可见桌面，headless 无法复现）。
- 同一 Agent 同时拥有两个 Space 并各自跑模板（模型允许，本轮 live 用两个不同 Agent 验证）。
- macOS 的 keychain/signing 门禁与 smoke（本机 Windows）。
- Browser CLI 增强能力（`chrome.browserCli` / managed mode）下的并发差异。
- `tab_cdp_call` 与截图/导航的高频交错、下载/Groq 等无租约命令的业务级串扰。
- 真实用户人工接管（mask takeover）与并发模板的交互（Agent D 范围）。

## 7. 可复现命令

```bash
npm run typecheck
npm run test:core
npm run build
npm run registry:check

# 真实浏览器并发（需要 baseline Chromium + 已注册 native host）
npm run test:concurrency:live -- --windows=8
# 可选：--no-build（复用 dist）、--port=48900、--keep（保留临时 profile 便于排查）
```

## 8. 变更文件

- `src/background/foreground-lease.ts` — keyed 租约、global/space 判定、迁移/清理。
- `src/background/state.ts` — `foregroundLeases` 持久化字段、clearAllSpaces 清理。
- `src/background/commands.ts` — stop 按 Agent 清理租约/取消模板；截图顶层 stale 字段；并发说明。
- `src/background/templates.ts` — 按 Agent 的取消代际。
- `src/background/spaces.ts` — 导出只读 `resolveSpaceSelector` 供 key 归一化。
- `src/background/screenshot-policy.ts` — 超时 hooks、迟到 settle 消费、`ScreenshotCaptureError`、两段原因。
- `src/background/cdp.ts` — per-tab pending 截图表、超时清理、滚动截图 stale 明细。
- `scripts/build-registry.mjs`、`scripts/registry-check.mjs`、`.gitattributes` — CRLF/LF 修复与固定 EOL。
- `scripts/test-core.mjs` — keyed 租约/截图清理/registry CRLF 测试。
- `scripts/test-concurrency-live.mjs` — 真实并发测试。
- `package.json` — 新增 `test:concurrency:live`。
