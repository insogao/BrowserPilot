import type { Command, CommandName } from "../shared/types";
import { mutateState } from "./state";
import { commandClientId } from "./spaces";

const LEASE_TTL_MS = 90_000;
const RENEW_MS = 30_000;

const FOREGROUND_COMMANDS = new Set<CommandName>([
  "snapshot", "readText", "screenshot", "scroll_screenshot", "getElementInfo",
  "click", "dblclick", "hover", "drag", "wheel", "down", "up", "press", "type", "fill",
  "selectOption", "check", "uncheck", "setChecked", "js", "waitForURL", "waitForSelector",
  "waitForTimeout", "pageInfo", "tab_cdp_call", "open_tab", "close_tab", "switch_tab",
  "ensure_visible", "open_space", "close_space", "complete_space", "run_template",
  "start_mask", "stop_mask", "download_image", "download_resource",
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
