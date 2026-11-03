// 虚拟鼠标（插件级 AI 光标）的跨端契约：content script / SW / 测试共用。
//
// 只描述 overlay 与消息名；不引入任何 DOM 或 chrome API，SW 与离线测试都能安全 import。

/** overlay host 的 DOM id。SW 侧在 content 消息失败时用它做 DOM 兜底（截图隐藏）。 */
export const CURSOR_HOST_ID = "bp-virtual-cursor-host";

/** content ↔ SW 消息名。 */
export const CURSOR_MSG = {
  show: "cursor_show",
  hide: "cursor_hide",
  remove: "cursor_remove",
  move: "cursor_move",
  pulse: "cursor_pulse",
  status: "cursor_status",
  captureHidden: "cursor_capture_hidden",
} as const;

export type CursorStyle = "arrow" | "dot";

export interface CursorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** content 侧的真实 overlay 状态（closed shadow root 内部才拿得到，必须由 content 汇报）。 */
export interface CursorWireState {
  /** overlay 是否已挂载（导航后为 false）。 */
  mounted: boolean;
  visible: boolean;
  /** 是否为「截图临时隐藏」状态。 */
  hiddenForCapture: boolean;
  style: CursorStyle;
  /** 光标热点（箭头尖端）在视口中的 CSS 像素坐标。 */
  x: number;
  y: number;
  /** host / glyph 的 computed pointer-events，必须是 none。 */
  pointerEvents: string;
  glyphPointerEvents: string;
  hostDisplay: string;
  hostRect: CursorRect;
  glyphRect: CursorRect;
  /** 命中测试：该点最上层元素（overlay 不得出现在这里）。 */
  elementAtPoint: string | null;
  elementsAtPoint: string[];
  viewport: { width: number; height: number };
  /** 最近一次移动的轨迹摘要（测试与诊断用）。 */
  lastMove?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    steps: number;
    durationMs: number;
    cancelled: boolean;
  };
}
