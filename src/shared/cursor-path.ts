// 虚拟光标的拟人轨迹（纯函数，无 DOM / chrome 依赖，便于离线单测）。
//
// 设计要点：
// - 输入输出都是**页面 CSS 像素**（与 getBoundingClientRect / CDP Input.* 同一坐标系）。
//   绝不涉及屏幕坐标或系统鼠标位置。
// - 轨迹是「三次贝塞尔 + 缓入缓出 + 垂直方向小抖动」：起点是当前光标位置，终点是
//   目标元素 rect 的中心（由调用方用真实 rect 算好），中段略微偏离直线，避免机械感。
// - 采样点带归一化时间 t（0..1），content 侧按 t 线性插值即可获得平滑动画。

export interface Pt {
  x: number;
  y: number;
}

export interface PathPoint extends Pt {
  /** 归一化时间 0..1（单调不减）。 */
  t: number;
}

export interface HumanPathOptions {
  /** 总时长（ms）。缺省按距离推算，夹在 160..700ms。 */
  durationMs?: number;
  /** 采样点数（含首尾），默认 12。 */
  samples?: number;
  /** 横向抖动上限（像素），默认 min(18, max(2, 距离 * 0.12))。 */
  jitter?: number;
  /** 可注入的随机源（测试用），默认 Math.random。 */
  random?: () => number;
}

export interface HumanPath {
  points: PathPoint[];
  durationMs: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 缓入缓出（cubic）。 */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 三次贝塞尔。 */
export function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** 距离 -> 默认时长（ms）。原地移动返回 0（不需要动画）。 */
export function durationForDistance(distance: number): number {
  if (!Number.isFinite(distance) || distance < 1) return 0;
  return Math.round(clamp(140 + distance * 0.5, 160, 700));
}

/**
 * 生成从 `from` 到 `to` 的拟人轨迹。
 * 保证：points[0] === from，points[last] === to，t 从 0 单调到 1。
 */
export function buildHumanPath(from: Pt, to: Pt, opts: HumanPathOptions = {}): HumanPath {
  const rand = opts.random ?? Math.random;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const durationMs = Math.max(
    0,
    Math.round(opts.durationMs !== undefined ? opts.durationMs : durationForDistance(distance)),
  );
  const samples = Math.max(2, Math.floor(opts.samples ?? 12));

  // 退化情形：原地移动或零时长 —— 只返回端点，避免除零与无意义的抖动。
  if (distance < 1 || durationMs === 0) {
    return { points: [{ ...from, t: 0 }, { ...to, t: 1 }], durationMs: 0 };
  }

  const jitterCap = opts.jitter !== undefined ? Math.abs(opts.jitter) : Math.min(18, Math.max(2, distance * 0.12));
  const px = -dy / distance;
  const py = dx / distance;
  const j1 = (rand() * 2 - 1) * jitterCap;
  const j2 = (rand() * 2 - 1) * jitterCap * 0.55;

  const c1: Pt = { x: from.x + dx * 0.3 + px * j1, y: from.y + dy * 0.3 + py * j1 };
  const c2: Pt = { x: from.x + dx * 0.72 + px * j2, y: from.y + dy * 0.72 + py * j2 };

  const points: PathPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const eased = easeInOutCubic(t);
    const p = cubicBezier(from, c1, c2, to, eased);
    points.push({ x: p.x, y: p.y, t });
  }
  // 端点必须精确等于真实坐标（浮点误差会让落点偏离元素中心）。
  points[0] = { x: from.x, y: from.y, t: 0 };
  points[points.length - 1] = { x: to.x, y: to.y, t: 1 };
  return { points, durationMs };
}

/** 在已采样轨迹上按归一化时间取点（分段线性插值）。 */
export function samplePath(points: PathPoint[], u: number): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  const t = clamp(u, 0, 1);
  if (t <= points[0].t) return { x: points[0].x, y: points[0].y };
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.t - a.t;
      const k = span <= 0 ? 1 : (t - a.t) / span;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}
