// 宿主浏览器能力探测（Phase 7）。
//
// 唯一判断依据是 `chrome.browserCli.getCapabilities()` 是否存在并成功返回。
// 禁止用 User-Agent、产品名或任何可伪造信号判断增强能力：普通 Chrome 上该命名
// 空间根本不存在，接口缺失即等价于“没有增强能力”，插件自动走 Generic 路径。
//
// 同一份插件代码同时运行在普通 Chrome 与 Browser CLI，不构建两套产物。

/** 本插件理解的 capability 协议版本。宿主返回其它值时必须保守降级。 */
export const SUPPORTED_PROTOCOL_VERSION = 1;

/** Generic 模式的并发上限：普通浏览器一次只安全地驱动一个前台窗口。 */
export const GENERIC_MAX_CONCURRENT_WINDOWS = 1;

export type BrowserCliMode = "enhanced" | "generic";

export interface HostCapabilities {
  mode: BrowserCliMode;
  /** 协议版本；generic 模式下为 0（表示宿主没有该协议）。 */
  protocolVersion: number;
  product?: string;
  browserVersion?: string;
  managedMode: boolean;
  backgroundWindows: boolean;
  backgroundCapture: boolean;
  hardFocusIsolation: boolean;
  foregroundAssist: boolean;
  maxConcurrentWindows: number;
  /** 非 enhanced 时说明降级原因，用于诊断与 onboarding 展示。 */
  degradeReason?: string;
}

export function genericCapabilities(reason: string): HostCapabilities {
  return {
    mode: "generic",
    protocolVersion: 0,
    managedMode: false,
    backgroundWindows: false,
    backgroundCapture: false,
    hardFocusIsolation: false,
    foregroundAssist: false,
    maxConcurrentWindows: GENERIC_MAX_CONCURRENT_WINDOWS,
    degradeReason: reason,
  };
}

/** chrome.browserCli 的最小形状；普通 Chrome 上为 undefined。 */
interface BrowserCliApi {
  getCapabilities(): Promise<unknown>;
}

function getBrowserCliApi(): BrowserCliApi | undefined {
  // 必须走 globalThis：MV3 service worker 里扩展 API 挂在 globalThis 上，
  // 裸标识符 `chrome` 并不总是绑定（实测 Worker 启动阶段取不到）。
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  const api = g.chrome && g.chrome["browserCli"];
  if (!api || typeof api !== "object") return undefined;
  const fn = (api as Record<string, unknown>)["getCapabilities"];
  return typeof fn === "function" ? (api as unknown as BrowserCliApi) : undefined;
}

/**
 * 等待 chrome.browserCli 出现。
 *
 * 内核在 Service Worker 创建后才把 API 注入 Worker 全局，实测存在约 0.5s 的
 * 窗口期：此刻 SW 里 `globalThis.chrome.browserCli` 仍是 undefined。若只探测一次，
 * Browser CLI 会被误判成普通 Chrome 并永久降级。因此这里按 deadline 重试，
 * 超时仍未出现才认定“宿主没有该接口”。
 *
 * 普通 Chrome 上每次检查都是 undefined，走满重试后正常降级，代价只是首次
 * 初始化多等一小段时间（与 connectHost 并行感知，不阻塞其它启动工作）。
 */
const API_APPEAR_TIMEOUT_MS = 5000;
const API_APPEAR_POLL_MS = 100;

async function waitForBrowserCliApi(
  timeoutMs: number = API_APPEAR_TIMEOUT_MS,
): Promise<BrowserCliApi | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const api = getBrowserCliApi();
    if (api) return api;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, API_APPEAR_POLL_MS));
  }
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}

/**
 * 探测宿主能力。永不抛出：任何异常都降级为 generic 并记录原因。
 *
 * 三种结果：
 *  1. 接口不存在 → Generic Browser（普通 Chrome 的正常路径）；
 *  2. 接口存在且协议兼容 → Enhanced（Browser CLI）；
 *  3. 接口存在但调用失败或协议不认识 → 保守降级，记录错误。
 */
export async function detectHostCapabilities(
  options: { apiAppearTimeoutMs?: number } = {},
): Promise<HostCapabilities> {
  const api = await waitForBrowserCliApi(options.apiAppearTimeoutMs);
  if (!api) {
    return genericCapabilities("api-absent");
  }

  let raw: unknown;
  try {
    raw = await api.getCapabilities();
  } catch (e) {
    return genericCapabilities(`call-failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!raw || typeof raw !== "object") {
    return genericCapabilities("invalid-response");
  }
  const caps = raw as Record<string, unknown>;

  const protocolVersion = caps["protocolVersion"];
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return genericCapabilities("invalid-protocol-version");
  }
  if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    return genericCapabilities(`unsupported-protocol: ${protocolVersion}`);
  }

  // managedMode 是内核侧的权威判断（是否带 --browser-cli-background-presentation
  // 启动）。它关闭时不得相信其它增强标志位，否则插件会在没有策略保护的内核上
  // 按“有保护”行事。
  const managedMode = readBoolean(caps, "managedMode");
  if (!managedMode) {
    return genericCapabilities("managed-mode-disabled");
  }

  const rawMax = caps["maxConcurrentWindows"];
  const maxConcurrentWindows =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.floor(rawMax)
      : GENERIC_MAX_CONCURRENT_WINDOWS;

  return {
    mode: "enhanced",
    protocolVersion,
    product: typeof caps["product"] === "string" ? (caps["product"] as string) : undefined,
    browserVersion:
      typeof caps["browserVersion"] === "string" ? (caps["browserVersion"] as string) : undefined,
    managedMode: true,
    backgroundWindows: readBoolean(caps, "backgroundWindows"),
    backgroundCapture: readBoolean(caps, "backgroundCapture"),
    hardFocusIsolation: readBoolean(caps, "hardFocusIsolation"),
    foregroundAssist: readBoolean(caps, "foregroundAssist"),
    maxConcurrentWindows,
  };
}

/** 供调度层查询并发上限的唯一入口。 */
export function concurrencyLimit(caps: HostCapabilities): number {
  return caps.mode === "enhanced" ? caps.maxConcurrentWindows : GENERIC_MAX_CONCURRENT_WINDOWS;
}
