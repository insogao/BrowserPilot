// smoke:template 的常驻窗口复用逻辑（可被确定性测试注入假 client）。
//
// 硬要求：能一条命令说明白「复用哪个窗口」时就复用，绝不在瞬态失败下新建窗口。
// 因此这里是 fail-closed：
//   - list_spaces 失败/数据异常 = 不新建，抛错；
//   - 只有 list_spaces 成功且确认没有可复用的专用 Smoke Space，才允许 open_space；
//   - 已有专用 Smoke Space 时，use_space/list_tabs 的瞬态失败一律抛错；
//     仅当扩展明确回报 SPACE_INACTIVE（窗口已被探测为消失并退休）才允许重建；
//   - --visible 的 ensure_visible 失败同样抛错，不报告 reused。
// 选取只针对名为 SMOKE_SPACE_NAME 的专用 Space，绝不复用同一 Agent 下其他用途窗口。
export const SMOKE_SPACE_NAME = "BrowserPilot Smoke";

function failureDetail(result) {
  const code = result?.parsed?.errorCode;
  const detail = result?.stderr || result?.parsed?.error || result?.stdout || "";
  return (code ? code + ": " : "") + String(detail).trim();
}

function isSpaceInactive(result) {
  // 扩展的 SPACE_INACTIVE 只在 windows.get 确认窗口消失并退休该 Space 后发出（惰性探测）。
  return result?.parsed?.errorCode === "SPACE_INACTIVE";
}

/**
 * @param {(command: string, args: Record<string, unknown>, timeoutMs: number) => Promise<{ok: boolean, parsed?: any, stderr?: string, stdout?: string}>} call
 * @param {{visible?: boolean, name?: string}} [options]
 * @returns {Promise<{spaceId: string, spaceMode: "reused"|"created"}>}
 */
export async function ensureSmokeSpace(call, { visible = false, name = SMOKE_SPACE_NAME } = {}) {
  const openNewWindow = async () => {
    const openSpaceArgs = { name, url: "about:blank" };
    if (visible) openSpaceArgs.focus = true;
    const opened = await call("open_space", openSpaceArgs, 30_000);
    if (!opened.ok || typeof opened.parsed?.data?.spaceId !== "string") {
      throw new Error("open_space 失败: " + failureDetail(opened));
    }
    return { spaceId: opened.parsed.data.spaceId, spaceMode: "created" };
  };

  // 1) 枚举当前 Agent 的 Space。枚举失败不能被当成“没有窗口”而触发新建。
  const spaces = await call("list_spaces", {}, 15_000);
  if (!spaces.ok) throw new Error("list_spaces 失败，拒绝新建窗口（fail-closed）: " + failureDetail(spaces));
  const mine = spaces.parsed?.data;
  if (!Array.isArray(mine)) throw new Error("list_spaces 返回数据异常，拒绝新建窗口（fail-closed）");

  const dedicated = mine.filter((s) => s && s.name === name && typeof s.spaceId === "string");
  const candidates = dedicated.filter((s) => s.ownership === "agent" && s.windowId !== undefined);
  const userHeld = dedicated.find((s) => s.ownership === "user");

  // 逐个尝试候选：某个候选已被扩展确认窗口消失（SPACE_INACTIVE）就换下一个，避免在还有活窗口时重建。
  for (const candidate of candidates) {
    const used = await call("use_space", { spaceId: candidate.spaceId }, 15_000);
    if (!used.ok) {
      // 窗口已由扩展确认消失（退休）→ 换下一个候选；其余失败保持 fail-closed。
      if (isSpaceInactive(used)) continue;
      throw new Error("use_space 失败，拒绝新建窗口（fail-closed）: " + failureDetail(used));
    }
    const probe = await call("list_tabs", {}, 15_000);
    if (!probe.ok) {
      if (isSpaceInactive(probe)) continue;
      throw new Error("list_tabs 失败，拒绝新建窗口（fail-closed）: " + failureDetail(probe));
    }
    if (visible) {
      const raised = await call("ensure_visible", {}, 15_000);
      if (!raised.ok) throw new Error("--visible 置前失败: " + failureDetail(raised));
    }
    return { spaceId: candidate.spaceId, spaceMode: "reused" };
  }

  // 专用 Smoke Space 存在但被用户接管：不得另开窗口绕过接管。
  if (userHeld) {
    throw new Error("专用 Smoke Space 由用户接管（SPACE_USER_IN_CONTROL），拒绝新建窗口: " + userHeld.spaceId);
  }

  // 2) 枚举成功且明确没有可复用的专用 Smoke Space（含候选全部已退休的情况）→ 才新建。
  return openNewWindow();
}
