import type { Command, CommandName } from "../shared/types";
import { mutateState } from "./state";
import { commandClientId } from "./spaces";

const LEASE_TTL_MS = 90_000;
const RENEW_MS = 30_000;

// 只覆盖"会改变窗口展示状态"的命令。后台能力（DOM 读写、点击/输入、截图、求值、
// 等待、CDP 透传、下载）刻意不在其中：它们不需要前台，若也去抢一个进程级租约，
// 不同窗口上的两个 Agent 会被无谓地串行化——那正是"多 Agent 并行"要避免的。
//
// 同一窗口内的输入冲突不靠这个租约解决：space 归属已经保证一个 space 只有一个
// owner；人类与 AI 争同一 Tab 的控制权由插件遮罩 + 后续内核侧输入仲裁负责。
const FOREGROUND_COMMANDS = new Set<CommandName>([
  "ensure_visible", "open_space", "close_space", "complete_space", "handoff_space",
  "run_template", "start_mask", "stop_mask",
]);

export class ForegroundLeaseError extends Error {
  readonly code = "FOREGROUND_BUSY";
  constructor(ownerClientId: string, spaceId?: string, detail?: string) {
    super(
      "浏览器前台正由其他 Agent 使用: owner=" + ownerClientId + (spaceId ? " space=" + spaceId : "")
        + (detail ? "（" + detail + "）" : ""),
    );
    this.name = "ForegroundLeaseError";
  }
}

export interface ForegroundLeaseHandle {
  release(): Promise<void>;
}

async function refresh(token: string): Promise<void> {
  await mutateState((state) => {
    if (state.foregroundLease?.token === token) {
      state.foregroundLease.expiresAt = Date.now() + LEASE_TTL_MS;
    }
  });
}

export async function acquireForegroundLease(cmd: Command): Promise<ForegroundLeaseHandle | undefined> {
  if (!FOREGROUND_COMMANDS.has(cmd.name)) return undefined;

  const clientId = commandClientId(cmd);
  const inherited = cmd._foregroundLeaseToken;
  let token = inherited;
  let ownsLease = false;

  await mutateState((state) => {
    const current = state.foregroundLease;
    const active = current && current.expiresAt > Date.now();
    if (inherited && active && current.token === inherited && current.ownerClientId === clientId) {
      current.expiresAt = Date.now() + LEASE_TTL_MS;
      return;
    }
    if (active && current.ownerClientId !== clientId) {
      throw new ForegroundLeaseError(current.ownerClientId, current.spaceId);
    }
    if (active) {
      throw new ForegroundLeaseError(
        current.ownerClientId,
        current.spaceId,
        "同一 Agent 有命令正在使用前台；模板子步骤应继承 _foregroundLeaseToken，不要并发派发前台命令",
      );
    }
    token = crypto.randomUUID();
    ownsLease = true;
    state.foregroundLease = {
      token,
      ownerClientId: clientId,
      spaceId: cmd.space,
      startedAt: Date.now(),
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
  });

  if (!token) throw new Error("前台租约创建失败");
  cmd._foregroundLeaseToken = token;
  if (!ownsLease) return { release: async () => {} };

  const timer = setInterval(() => { void refresh(token as string); }, RENEW_MS);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await mutateState((state) => {
        if (state.foregroundLease?.token === token) delete state.foregroundLease;
      });
    },
  };
}
