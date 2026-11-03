# F3 产品截图 P0：根因与修复（2026-10-30）

## 现象

managed 隐藏窗口里的静态页面（无 rAF / 无定时器）首次 `screenshot` 会失败：

- 产品路径 `Page.captureScreenshot(fromSurface=true)` 8s 超时；
- 降级 `fromSurface=false` 返回
  `-32000 Only screenshots from surface are allowed`；
- 同一 tab、同一 CDP 会话、同样参数的 **raw** `Page.captureScreenshot(fromSurface=true)`
  也会挂住（实测 8s / 30s / 60s 均有超时），因此不是产品串行化、冷却或光标遮罩导致；
- 一次性超时后，请求仍留在 viz，但下一次**新的**请求有时能成功，说明“旧请求挂住”
  不是唯一原因，而是“没有新合成帧可服务 copy request”。

## 根因

静态/隐藏页面加载完成后不再产生新的合成帧。`Page.captureScreenshot` 的
`CopyOutputRequest` 会排到 renderer surface 的 copy 队列；display 只有在真正
aggregate + draw 时才会服务它。窗口隐藏后 display 不再 draw，于是：

- patch 027 的 `ActivatePendingRootFrameIfNeeded()` 只能激活**已存在的 pending root
  frame**；没有 pending frame 时它直接返回，不会强制产生一帧；
- 因此 copy request 永远没有机会被服务，promise 永不 settle，直到调用方超时。

`fromSurface=false` 不是“本构建不可用”，而是 **trusted-only**：Chromium 在
`PageHandler::CaptureScreenshot` 中要求 `is_trusted_`，`chrome.debugger` 是
untrusted session，必然被拒绝。它不能作为产品降级路径。

## 产品修复（BrowserPilot）

1. 主路径 `Page.captureScreenshot(fromSurface=true)` 最多等 **4s**；调用方传入的
   `timeoutMs` 是整次预算，主路径始终受 4s 上限保护，避免在已知会挂住的请求上白等。
2. 主路径失败/超时后，用 **单帧 `Page.startScreencast`** 兜底：
   - `waitForDebuggerEvent(tabId, "Page.screencastFrame", timeoutMs)` 先注册；
   - `Page.startScreencast {format, quality:100, everyNthFrame:1}`；
   - 取第一帧、`Page.screencastFrameAck`，立即 `Page.stopScreencast`；
   - 不设置 `maxWidth/maxHeight`，实测返回原生 1249×1277，不是缩略图；
   - 空帧/超时/断连一律失败，绝不返回旧图；`possiblyStale=false`，`path="screencast"`。
3. 删除 `fromSurface=false` 作为产品降级路径；`captureWithFallback` 仅保留给离线
   策略测试并标记 deprecated。
4. 同一 tab 仍由 `withTabCaptureLock` 串行；主路径超时后 30s 冷却只限制主路径，
   不影响单帧投屏兜底；4 次连续超时的硬闸也不会让产品失去截图能力。
5. `screenshot` 返回 `screenshot.path`（`surface`/`screencast`）、`fromSurface`、
   `possiblyStale`、`reason`；新增只读 `screenshot_diagnostics` 便于现场排障。

## 真实 E2E 证据（out/WinDev + 真实扩展 + native host + chrome.debugger）

### A. 静态隐藏页，product-first

`node scripts/test-product-screenshot-ab.mjs --scenario=static-product-first --no-build`

| 步骤 | wall | 结果 | PNG 帧号 | DOM 帧号 | fresh | path | reason |
|---|---:|---|---:|---:|---|---|---|
| product cold | 2160ms | OK | 0 | 0 | true | surface | - |
| raw right-after-product | 8003ms | TIMEOUT | - | 0 | false | - | captureScreenshot 8s |
| product after-raw | 272ms | OK | 0 | 0 | true | surface | - |
| product after-raw-long | 4271ms | **OK** | 0 | 0 | true | **screencast** | fromSurface 4000ms 超时 |
| raw after | 8013ms | TIMEOUT | - | 0 | false | - | captureScreenshot 8s |

`after-raw-long` 是兜底路径：主路径 4s 超时后，投屏 255ms 返回原生分辨率、
marker=0 与 DOM=0 一致的新鲜帧；`possiblyStale=false`。

### B. 动画隐藏页，3 窗口 + 45s 空闲

`--scenario=f3-like-idle`

| 步骤 | wall | 结果 | PNG 帧号 | DOM 帧号 | delta | fresh | path |
|---|---:|---|---:|---:|---:|---|---|
| product cold-after-idle | 3226ms | OK | 53 | 49 | +4 | true | surface |
| raw right-after-product | 4149ms | OK | 61 | 57 | +4 | true | - |
| product after-raw | 4075ms | **OK** | 68 | 66 | +2 | true | **screencast** |
| product-cdp after | 2132ms | OK | 77 | 73 | +4 | true | - |

产品三条路径全部帧号 >= 截图开始前 DOM 帧号，没有 stale；主路径挂住时投屏兜底
仍然返回当前帧。

### C. 单帧投屏独立探针（raw CDP）

静态隐藏页：

- `Page.captureScreenshot` 8s 超时；
- `Page.startScreencast` 第一帧 ~0.1s，原生 1249×1277，marker=0；
- 执行 `__bump()` 后投屏第一帧 marker=1（当前 DOM=1），证明投屏不是缓存旧帧；
- 之后再次 `Page.captureScreenshot` 仍超时（说明投屏不会修复 copy request，
  只是产品兜底）。

## 离线测试

- `npx tsc --noEmit` exit 0；
- `node scripts/test-core.mjs` exit 0，包含：
  - 主路径超时后单帧投屏兜底、`path=screencast`、`possiblyStale=false`；
  - 迟到帧丢弃、pending 归零、冷却期直接投屏、同 tab 串行、跨 tab 不阻塞；
- `node scripts/build.js` exit 0。

## 剩余缺口

- raw CDP `Page.captureScreenshot` 在静态隐藏页仍会挂住；产品靠投屏兜底，不改变
  内核 copy request 行为。若要求 raw CDP 也可靠，需要另做 viz 侧“copy 时强制 draw
  一帧”的补丁（当前未做）。
- 投屏帧格式/分辨率：默认 png、原生尺寸；若页面超过 media 最大尺寸或请求格式
  不受投屏支持，会失败而不是返回旧图。
- 若外部已有 screencast 正在运行，`Page.startScreencast` 返回 already active，
  产品 fail closed；不会抢占用户的投屏会话。
- 多窗口并发、长期连续截图、`Page.captureScreenshot` 与投屏交错的最长稳定性仍需
  在完整 P0 回归中复跑。
