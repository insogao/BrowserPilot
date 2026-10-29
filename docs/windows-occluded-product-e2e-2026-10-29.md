# 产品级遮挡截图 E2E 验收（真实 BrowserPilot 链路，Windows，2026-10-29）

范围：用**真实 BrowserPilot 产品链路**（可见打补丁 Chrome → 扩展 SW → connectNative → 本次构建的
native host → host TCP 命令 → `chrome.debugger` → `Page.captureScreenshot`）验证 patch 027
在“窗口可见但被完全遮挡”时仍能取到**最新帧**，而不是只用独立 CDP harness。

结论：**PASS**。52/52 项检查通过；单窗口遮挡连续 60 次截图全部
`fromSurface=true`、`possiblyStale=false`、PNG marker 帧号与 DOM 帧号完全一致（delta 全为 0）；
3 窗口并发截图全部 fresh；前台窗口与每个目标的 `GW_HWNDPREV` 在全部截图前后完全不变；
浏览器无 FATAL / 0xC0000005 / Crashpad dump；测试 Chrome/host 全部清理，HKCU 注册表恢复原值。

证据 JSON：`D:\c\logs\product-occluded-2026-10-29T01-36-29-073Z.json`
（本地时间 09:36；`startedAt=2026-10-29T01:35:44.150Z`，`finishedAt=01:36:29.073Z`）。

---

## 1. 新增文件与复现命令

| 文件 | 作用 |
| --- | --- |
| `scripts/test-occluded-product-e2e.mjs` | 主测试（真实产品链路 + Win32 遮挡 + 像素断言 + 报告） |
| `tests/fixtures/occluded-product-probe.html` | 24×24 marker（帧号颜色）、Canvas2D、WebGL、同源 iframe、`__probe` / `__bump` |
| `docs/windows-occluded-product-e2e-2026-10-29.md` | 本文档 |

```sh
# 全量（默认先 npm run build + npm run build:host，再注册、启动、60 次、3 窗口并发、清理）
node scripts/test-occluded-product-e2e.mjs

# 复用现有 dist / host exe
node scripts/test-occluded-product-e2e.mjs --no-build

# 分阶段调试
node scripts/test-occluded-product-e2e.mjs --stage=smoke --no-build    # 链路 + 遮挡 + 2 张
node scripts/test-occluded-product-e2e.mjs --stage=single --no-build   # 单窗口连续截图
node scripts/test-occluded-product-e2e.mjs --stage=multi --no-build    # 3 窗口并发
node scripts/test-occluded-product-e2e.mjs --repeat=10 --no-build      # 调整连续次数
```

退出码：`PASS → 0`；`PARTIAL / BLOCKED → 1`。前置条件（构建、host exe、注册、启动）失败为
`BLOCKED`；进入真实链路后任一断言失败为 `PARTIAL`。

---

## 2. 被测对象与真实链路

- 浏览器：`D:\c\src\out\WinDev\chrome.exe`（`chrome.dll` mtime `2026-10-28T11:02:11.541Z`，
  含 patch 027 的 4 文件 viz 改动；构建时间 19:02）。
- 扩展：`npm run build` → `D:\work\BrowserPilot\dist`（含 P3 信任边界），扩展 ID
  `nnollghpaggbcdkkgoieneffnlijinio`。
- native host：`npm run build:host` → 本次运行生成的
  `native-host\dist\browserpilot-host-1793237744901.exe`（`npm run build:host` 版本化输出）。
- 注册：`native-host/register.ps1 -HostPath <新 exe> -BackupDir <runDir>/registry-backup`；
  Chrome 通过 `connectNative` 拉起该 exe（`processExecutablePath` 核验一致）。
- 产品命令（host TCP 明文 JSON，`agentId=occl-e2e-agent`）：
  `ping` / `version` / `get_ready_state` / `open_space` / `list_tabs` / `js` / `screenshot`。
  `list_tabs` 按 fixture URL 找到 tab，再对该 `tabId` 发 `screenshot {format:"png"}`。
- 启动参数（可见、非 headless、无 `--no-sandbox`）：
  `--remote-debugging-port=0 --user-data-dir=<临时 profile> --load-extension=<dist>
  --disable-extensions-except=<dist> --in-process-gpu --no-first-run --no-default-browser-check
  --disable-background-networking --disable-sync --disable-component-update <fixture-url>`。
  测试额外加 `--enable-logging=stderr --v=0`（仅测试，用于让 FATAL/CHECK/crash 进入 stderr），
  不影响渲染/合成路径。
- 隔离：独立临时 `--user-data-dir`，`LOCALAPPDATA` 指向运行目录；不读写用户真实 profile。

### 2.1 注册表与 host 证据

| 项 | 值 |
| --- | --- |
| 测试前 HKCU 默认值 | `D:\work\chrome\plugin-v1\native-host\host.manifest.json` |
| 注册后 | `D:\work\BrowserPilot\native-host\host.manifest.json` |
| 本次 host exe（备份中记录） | `D:\work\BrowserPilot\native-host\dist\browserpilot-host-1793237744901.exe` |
| host session | `port=48693, pid=40068`，session 文件在隔离 `localappdata\BrowserPilot\sessions\48693.json` |
| `processExecutablePath` | 与上述新 exe 完全一致 |
| 结束后 `unregister.ps1 -BackupFile` | `action=restored-default`，值回到 `D:\work\chrome\plugin-v1\native-host\host.manifest.json` |
| 恢复核验 | `restored=true`（逐字比较） |

---

## 3. 遮挡与窗口状态

Win32 辅助进程（PowerShell + Add-Type/WinForms，持久 stdin/stdout JSON）负责：

- 枚举顶层窗口（`EnumWindows`，含 z-order 顺序）、`GetWindowRect`、`IsWindowVisible`、`IsIconic`、
  `GetForegroundWindow`、`GetWindow(hwnd, GW_HWNDPREV/GW_HWNDNEXT)`；
- 创建**独立遮挡窗口**：`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` + `ShowWithoutActivation`，
  与目标窗口同 rect，`SetWindowPos(HWND_TOP, SWP_NOACTIVATE | SWP_SHOWWINDOW)` 置顶；
  **从不调用 `SetForegroundWindow`**；
- 移动目标窗口同样使用 `SWP_NOACTIVATE`（setup 阶段允许调整 z-order；截图阶段不再改变）。

本次遮挡目标 w0：

```
target hwnd=4721648  rect=[40,40,1100,800]  visible=true  iconic=false
occluder hwnd=29757166（WindowsForms 窗口，独立进程）rect=[40,40,1100,800] visible=true
z-order（EnumWindows 自上而下）：occluderIndex=5 < targetIndex=6 → occluderAbove=true
rect 覆盖：covers=true
遮挡后 document.visibilityState="hidden"，document.hasFocus()=false
```

说明：本机是非前台测试会话，Chrome 窗口在创建后即被桌面上的其它顶层窗口覆盖，
**遮挡前**探测到的 `visibilityState` 已经是 `hidden`（报告里原样记录，不作为 PASS 条件）。
因此本测试证明的是：在“可见但被完全遮挡”的窗口上，真实产品 `screenshot` 仍返回
`fromSurface=true` 的新帧；遮挡窗口在 z-order 上位于目标之上且 rect 完全覆盖，目标窗口
`visible=true`、未最小化。

### 3.1 前台 / z-order 不变量（全部 60 张 + 并发）

| 指标 | 单窗口 60 张 | 3 窗口并发 |
| --- | --- | --- |
| `GetForegroundWindow()` | 全部为 `590308`（截图前后逐张相同） | 全部为 `590308`（前后相同） |
| 目标 `GW_HWNDPREV` | 全部为 `12978820`（逐张相同） | w0 `1904076`、w1 `17632918`、w2 `12978820`，各自前后相同 |
| 目标 `visible` / `iconic` | `true` / `false`（60/60） | `true` / `false`（3/3） |
| 遮挡窗口创建后前台 | 未变化（`590308 → 590308`） | 未变化 |

---

## 4. 新鲜度：PNG marker vs DOM 帧号

fixture 的 24×24 marker 用 `rgb(n & 0xff, (n >> 8) & 0xff, 255)` 编码帧号；
每次截图前通过产品 `js` 命令执行 `__bump(5)`（显式 DOM repaint，不依赖 rAF），
截图后解码 PNG 读 marker 像素，再读 `__probe().rafCount` 比较。

- marker 定位：在 PNG 左上 400×140 区域扫描唯一 `B=255` 非白实心块，实测
  `markerBox={x:8,y:8,w:24,h:24,count:576}` → CSS→PNG 比例 = 1.0。
- 单窗口 60 张：`frameDeltas` **全部为 0**（PNG marker == 截图后 DOM 帧号）；
  `bumpValue` 从 5 增长到 300，`pngFrame` 同步从 5 到 300。
- 每张断言：`fromSurface=true`、`possiblyStale=false`、`screenshot.meta.possiblyStale=false`、
  marker 匹配（±4）、iframe/canvas/WebGL 采样命中、`visibilityState=hidden`、`hasFocus=false`、
  前台与 `GW_HWNDPREV` 不变、目标 visible 且非最小化。

### 4.1 单张原始返回（shot 0）

```json
{
  "ms": 407,
  "bytes": 6737,
  "pngWidth": 1084, "pngHeight": 649,
  "pngScale": [1, 1], "pngScaleSource": "marker-box",
  "fromSurface": true,
  "possiblyStale": false,
  "reason": null,
  "meta": { "fromSurface": true, "durationMs": 400, "possiblyStale": false, "reason": null },
  "bumpValue": 5, "domFrame": 5, "pngFrame": 5, "frameDelta": 0,
  "markerRgb": [5, 0, 255],
  "probeVisibilityState": "hidden", "probeHasFocus": false,
  "foregroundBefore": 590308, "foregroundAfter": 590308,
  "aboveBefore": 12978820, "aboveAfter": 12978820
}
```

（`screenshot` 产品返回为 `{tabId, format, base64, screenshot:{fromSurface,durationMs,possiblyStale,reason},
possiblyStale, cursorIncluded:false}`；上面是解码/断言后的记录。）

---

## 5. iframe / Canvas2D / WebGL 像素采样

fixture 固定布局（CSS px）：marker (8,8,24,24)、Canvas2D (8,48,160,64)、
WebGL (8,128,160,64)、同源 iframe (8,208,240,120)。截图按 marker 实测比例（1.0）采样每块中心
5×5 区域均值（容差 ±12）：

| 区域 | 期望 RGB | 60 张实测（全部相同） | 结果 |
| --- | --- | --- | --- |
| Canvas2D | `[255,0,170]` (`#ff00aa`) | `[255,0,170]` | PASS ×60 |
| WebGL | `[0,255,102]` (`clearColor(0,1,0.4)`) | `[0,255,102]` | PASS ×60 |
| 同源 iframe | `[255,238,0]` (`#ffee00`) | `[255,238,0]` | PASS ×60 |

WebGL 环境：`WebGL 2.0 (OpenGL ES 3.0 Chromium)`，`gl.getError()=0`；
`--in-process-gpu` 下走真实 GPU 合成路径。

---

## 6. 连续 60 次截图与多窗口并发

### 6.1 单窗口连续 60 次（同一遮挡窗口、同一 tab）

| 指标 | 值 |
| --- | --- |
| 完成 / 请求 | 60 / 60 |
| `fromSurface=true` | 60 / 60 |
| `possiblyStale=false` | 60 / 60（`staleCount=0`） |
| marker 与 DOM 帧号 | 60 / 60 完全一致（delta 0） |
| 单次耗时 | min 48 ms / max 432 ms / avg 277 ms（总 16.6 s） |
| 截图尺寸 | 1084×649 PNG（每张约 6.7 KB base64 解码后） |
| 浏览器存活 | `isAlive`（PID+创建时间+marker+exe 路径核验）= true |
| 60 次后 host/extension | `ping → pong`，`list_tabs` 仍返回 w0 tab |
| stderr | 822,766 字节；`layer_tree_view.cc:554`=0、`FATAL`=0、`0xC0000005`=0、`Check failed`=0、`DCHECK`=0、renderer/GPU crash 信号=0 |
| Crashpad | `Crashpad\reports` 无 `.dmp` |

说明：本次 fixture 在被遮挡/隐藏时主动停止 rAF（与浏览器自身节流方向一致），
帧号只由 `__bump(5)` 驱动，因此 marker 与 DOM 严格相等；代价是每次截图都要等一个真实的
forced-redraw 合成帧，耗时才从“rAF 仍在跑”时的 45–126 ms 上升到 48–432 ms。
仍远低于产品 `screenshot` 的 8 s 超时，且证明补丁不依赖 rAF 持续产帧。

### 6.2 3 个可见窗口全部遮挡 + 并发 3 个 screenshot

三个 `open_space` 窗口（`focused:false`）各自加载 fixture，移到同一 rect `[40,40,1100,800]`，
每个目标一个同 rect 遮挡窗口（`SWP_NOACTIVATE`），全部 `visibilityState=hidden`、`hasFocus=false`。

| 窗口 | tabId | 单张 ms | fromSurface | possiblyStale | DOM / PNG 帧号 | 前台 before→after | `GW_HWNDPREV` before→after | 采样 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| w0 | 1285428709 | 219 | true | false | 305 / 305 | 590308 → 590308 | 1904076 → 1904076 | canvas/webgl/iframe 全命中 |
| w1 | 1285428711 | 219 | true | false | 5 / 5 | 590308 → 590308 | 17632918 → 17632918 | 全命中 |
| w2 | 1285428713 | 984 | true | false | 5 / 5 | 590308 → 590308 | 12978820 → 12978820 | 全命中 |

并发批次墙钟 1006 ms（三个请求并行；w2 较慢拉长批次），全部 fresh；
`foregroundStable=true`、`zOrderStable=true`、`allFresh=true`、浏览器存活。

---

## 7. 安全清理与残留检查

- Chrome：`stopTestProcess` 按 PID+创建时间+marker+exe 路径核验后
  `taskkill /PID 996 /T /F`（只按核验过的 PID，不按镜像名）；`chromeAliveAfterStop=false`。
- host：Chrome 退出后 stdin EOF 自行退出（`hostExitedOnItsOwn=true`），`hostAliveAfterStop=false`。
- 遮挡窗口：全部 `closeAll` 后关闭 Win32 辅助进程（`WindowsForms` 窗口随进程销毁）。
- 注册表：`unregister.ps1 -BackupFile` 恢复旧值，`restored=true`。
- 隔离 `LOCALAPPDATA\BrowserPilot\sessions` 无存活 session（`liveSessions=[]`）。
- 复跑后独立核验：`Get-Process chrome` 计数 0；HKCU 默认值仍为
  `D:\work\chrome\plugin-v1\native-host\host.manifest.json`。
- 另发现 8 个 **早于本测试**（创建时间 2026-10-28 08:54–13:18）的
  `plugin-v1` 基线 host 进程（exe 路径 `D:\work\chrome\plugin-v1\native-host\dist\browserpilot-host-1788400184619.exe`，
  `--parent-window=0`）。它们不是本次构建产物、不在隔离 session 目录内，本测试未启动、
  未触碰、也未清理它们（避免影响其它并行工作）。本次自己的 host（PID 40068，新 exe）已自行退出。

---

## 8. 风险与未覆盖

1. **遮挡前状态**：本机非前台会话里目标窗口在创建后已被桌面其它窗口遮挡，
   无法测到 `visible → hidden` 的跃迁；报告记录 `pre-occlusion visibilityState=hidden`。
   遮挡后 hidden/no-focus、遮挡窗口 z-order 与 rect 覆盖均已核验。要测跃迁需交互式桌面。
2. **renderer viewport 滞后**：窗口被遮挡时 `SetWindowPos` 后 `window.innerWidth` 仍是
   resize 前尺寸（1249×1221），而 PNG 是 1084×649（内容 1:1、被裁切）。测试用 marker 实测
   24 px 反推 CSS→PNG 比例（`marker-box`），不依赖 `innerWidth`。其它工具若用 `innerWidth`
   换算遮挡窗口截图坐标，可能偏移。
3. **性能**：rAF 停止后单张 48–432 ms（avg 277 ms），高于 rAF 运行时的 45–126 ms；
   仍远低于 8 s 超时。未做分钟级持续压测（本次 60 张，总 16.6 s）。
4. **多根/多 display**：3 窗口是同一 rect、同一 display；`GetOldestRootCompositorFrameSinkId`
   只唤醒最老父根，tab 拖拽/多父根场景未覆盖。
5. **平台/构建**：仅 `out/WinDev` + `--in-process-gpu`（Windows 10.0.26200）；macOS/Linux、
   Hardened Runtime/发布签名构建未跑。
6. **测试专用参数**：`--enable-logging=stderr --v=0` 仅用于捕获 FATAL/crash；产品默认不带。
   `open_space` 默认 `focused:false`，本机没有抢前台（前台 HWND 全程 590308）。
7. **未覆盖**：标签悬停预览、真实用户桌面（非自托管会话）、遮挡状态下跨进程崩溃恢复、
   GPU 进程独立崩溃（`--in-process-gpu` 下 GPU 与浏览器同进程）。

---

## 9. 判定

- 真实产品链路：`list_tabs` → `screenshot {format:"png"}` 通过（`fromSurface=true`、
  `possiblyStale=false`）。
- 遮挡 + 新鲜度：60/60 帧号完全一致（delta 0），iframe/Canvas2D/WebGL 像素全部命中。
- 连续性/稳定性：60 次无 stale、无 FATAL/0xC0000005/Crashpad dump，浏览器与 host 存活。
- 多窗口并发：3/3 fresh，前台与 z-order 完全不变。
- 清理：Chrome/host 无残留，HKCU 恢复原值。

**VERDICT: PASS（52/52 checks）**。报告：
`D:\c\logs\product-occluded-2026-10-29T01-36-29-073Z.json`。
