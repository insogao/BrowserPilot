// 事件游标缓冲：数组 + 自增 sequence + drainEvents（after_sequence / methods / limit）。
// 参考技术路径 §4.8（ChatGPT tab_cdp_events）。
import type { EventMsg } from "../shared/types";

const MAX = 10000;
const events: EventMsg[] = [];
let sequence = 0;

export function recordEvent(name: string, args: unknown): EventMsg {
  const ev: EventMsg = { type: "event", name, args, sequence: ++sequence };
  events.push(ev);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  return ev;
}

export function drainEvents(opts: {
  after_sequence?: number;
  methods?: string[];
  limit?: number;
}): { events: EventMsg[]; cursor: number; hasMore: boolean; truncated: boolean } {
  const after = opts.after_sequence ?? 0;
  let list = events.filter((e) => e.sequence > after);
  if (opts.methods && opts.methods.length) list = list.filter((e) => opts.methods!.includes(e.name));
  const limit = opts.limit ?? 1000;
  const hasMore = list.length > limit;
  // 从最早尚未消费的事件开始分页，保证调用方按 cursor 连续拉取时不会跳过事件。
  const out = hasMore ? list.slice(0, limit) : list;
  const cursor = out.length ? out[out.length - 1].sequence : after;
  const truncated = hasMore;
  return { events: out, cursor, hasMore, truncated };
}

/** 记录事件，并通过 send 回调推给 host（广播）。 */
export function broadcastEvent(
  name: string,
  args: unknown,
  send: (msg: EventMsg) => void
): void {
  const ev = recordEvent(name, args);
  send(ev);
}
