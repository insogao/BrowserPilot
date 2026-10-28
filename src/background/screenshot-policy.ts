// 截图策略：超时、降级与新鲜度标记。刻意与 chrome.debugger 分离，便于离线测试。
//
// 背景：Page.captureScreenshot 的 fromSurface=true 在"窗口可见但被其它窗口完全
// 遮挡"时不会返回新帧（Chromium 的 DelegatedFrameHost 对 HiddenCause::kOccluded
// 提前返回，保留了表面），请求会一直挂住。这里给它一个硬超时，超时后退回浏览器
// 进程快照（fromSurface=false），并明确标记 this frame may be stale —— 绝不把
// 旧帧当成实时画面返回。

export interface ScreenshotMeta {
  /** true = 合成器取帧；false = 浏览器进程快照（可能是缓存位图）。 */
  fromSurface: boolean;
  durationMs: number;
  /** true 表示这次结果可能不是最新画面，调用方必须自行决定能否接受。 */
  possiblyStale: boolean;
  /** 走到降级路径的原因。 */
  reason?: string;
}

export interface ScreenshotResult {
  base64: string;
  meta: ScreenshotMeta;
}

export type CaptureSend = (params: Record<string, unknown>) => Promise<{ data?: string }>;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " 在 " + ms + "ms 内没有返回")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 先取合成器帧，超时后退回浏览器进程快照。
 *
 * 两条路径都拿不到数据时抛错（带首次失败原因），不返回空图。
 * `timeoutMs` 对每一次尝试独立生效。
 */
export async function captureWithFallback(
  send: CaptureSend,
  format: string,
  timeoutMs: number,
): Promise<ScreenshotResult> {
  const started = Date.now();
  try {
    const res = await withTimeout(
      send({ format, fromSurface: true }),
      timeoutMs,
      "Page.captureScreenshot(fromSurface=true)",
    );
    const base64 = res?.data ?? "";
    if (!base64) throw new Error("Page.captureScreenshot 返回空数据");
    return { base64, meta: { fromSurface: true, durationMs: Date.now() - started, possiblyStale: false } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const res = await withTimeout(
      send({ format, fromSurface: false }),
      timeoutMs,
      "Page.captureScreenshot(fromSurface=false)",
    );
    const base64 = res?.data ?? "";
    if (!base64) throw new Error("截图失败：两种路径都没有返回数据（" + reason + "）");
    return {
      base64,
      meta: { fromSurface: false, durationMs: Date.now() - started, possiblyStale: true, reason },
    };
  }
}
