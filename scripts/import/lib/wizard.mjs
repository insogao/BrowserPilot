// Presentation and wait-loop helpers for the product CLI flow.
//
// All output is counts/codes only: cookie names, values and per-site URLs never
// reach the terminal. Domains are only ever typed by the user in the explicit
// confirm-login step (and are then recorded in the local report).
import { failureText, TERMINAL_JOB_STATES } from "../contract.mjs";

export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_POLL_MS = 500;

function authorizationText(view) {
  const auth = view?.authorization || {};
  if (auth.targetUserConfirmed === true) {
    return auth.simulated === true
      ? "目标已确认（测试目标模拟，非真实用户确认）"
      : "目标浏览器内用户已确认";
  }
  if (view?.state === "denied") return "目标浏览器内用户已拒绝";
  if (view?.state === "awaiting_authorization") return "等待目标浏览器内用户确认";
  return "未确认";
}

export function formatProgressLine(view) {
  const total = view.totals.cookies;
  const done = view.progress.applied + view.progress.failed;
  return (
    `[${view.state}] ${done}/${total} 已处理` +
    `（写入 ${view.progress.applied}，失败 ${view.progress.failed}；授权：${authorizationText(view)}）`
  );
}

export function formatThreeState(view) {
  const lines = [];
  const c = view.cookieImported;
  const cookieLabel = {
    not_started: "未开始",
    imported: "已写入",
    partially_imported: "部分写入",
    failed: "写入失败",
  }[c.status] || c.status;
  lines.push("三态结果：");
  lines.push("  1. 数据复制：不适用（Cookie 不会写入文件包）");
  lines.push(`  2. Cookie 写入：${cookieLabel}（成功 ${c.applied} / 失败 ${c.failed}）`);
  lines.push("  3. 实际登录：未验证（本工具不会从 Cookie 数量推断登录）");
  lines.push(`目标授权：${authorizationText(view)}（这是目标浏览器内的导入范围授权，不是登录验证）`);
  if (view.sessionCookies?.count > 0) {
    lines.push(
      `会话 Cookie：${view.sessionCookies.count} 条；不保证在浏览器重启后保留（持久 Cookie 由目标 CookieStore 决定）。`,
    );
  }
  const failures = Object.entries(c.failures || {});
  if (failures.length) {
    lines.push("失败原因：");
    for (const [code, count] of failures) lines.push(`  ${code}: ${count} 条 — ${failureText(code)}`);
  }
  if (view.error) lines.push(`目标错误：${view.error.code} — ${view.error.message}`);
  return lines.join("\n");
}

export function reloginGuidance(view) {
  if (!view) {
    return "尚未收到来源扩展的任务。请在来源 Chrome/Edge 中打开扩展，扫描并选择域名后发送。";
  }
  if (view.state === "denied") {
    return "目标浏览器内的用户拒绝了本次导入范围。请检查勾选域名，或在 Browser CLI 中重新启动导入会话获取新票据。";
  }
  if (view.progress.applied === 0 && view.progress.failed === 0) {
    return "目标没有写入任何 Cookie。请检查导入票据、目标状态和扩展中的票据后重试（需要新票据）。";
  }
  const parts = [
    "下一步：在 Browser CLI 中打开你刚才勾选的网站，亲自确认是否仍处于登录状态。",
    "若未登录，请在目标浏览器中重新登录；设备绑定/风控会话可能无法迁移。",
    "会话 Cookie 在浏览器重启后不保证保留。",
    "确认登录后运行（必须由你本人执行）：",
    "  node scripts/import/browser-data-import.mjs confirm-login --file <report> --domain <domain> " +
      "--status user_confirmed --confirm-user-action",
  ];
  return parts.join("\n");
}

export function formatCapabilities(cap) {
  const lines = [
    `目标：${cap.product}（mode=${cap.mode}, transport=${cap.transport || "unknown"}, native=${cap.native === true}）`,
    `能力：cookieStoreWrite=${cap.capabilities.cookieStoreWrite === true}, ` +
      `persistAcrossRestart=${cap.capabilities.persistAcrossRestart === true}, ` +
      `partitioned=${cap.capabilities.partitionedCookies === true}, ` +
      `sessionCookiePersistence=${cap.capabilities.sessionCookiePersistence || "unknown"}`,
    `目标授权：${cap.authorization?.mode || "unknown"}` +
      (cap.authorization?.independentTargetConfirmation === true ? "（目标浏览器内确认）" : "（非目标浏览器确认）"),
  ];
  if (!cap.native) {
    lines.push("注意：这是本地测试目标，不是 Browser CLI 原生目标；不能据此宣称产品链路完成。");
  }
  if (!cap.capabilities.persistAcrossRestart) {
    lines.push("注意：测试目标只在内存中保存 Cookie；重启后不会保留。原生目标必须持久化到目标 CookieStore。");
  }
  if (cap.authorization?.independentTargetConfirmation !== true) {
    lines.push("注意：目标授权是模拟的；真实产品必须在目标浏览器内由用户本人确认。");
  }
  return lines.join("\n");
}

export function formatInstructions({ source, ticket, endpoint, native }) {
  return [
    "来源扩展操作：",
    `  1. 在 ${source.browserName} 的 Profile“${source.label}”中打开扩展 Browser CLI Import (source)。`,
    "  2. 勾选明确授权，点击“扫描本 Profile 的域名”。",
    "  3. 勾选要迁移的域名（默认不选）。",
    `  4. 导入票据填 ${ticket}（一次性，5 分钟内有效）。`,
    "  5. 勾选发送授权，点击“发送勾选域名的 Cookie”。",
    native
      ? "  Browser CLI 原生目标会先在自己的窗口里要求你确认域名范围，再用 CookieStore 写入。"
      : `  当前使用本地测试目标；它只验证契约与流程，不代表产品已完成。
  测试目标地址（仅测试客户端使用）：${endpoint}`,
    "等待任务中…（Ctrl+C 取消当前任务；不会关闭任何浏览器）",
  ].join("\n");
}

// Poll /v2/import/status until a terminal job arrives. When afterJobId is set,
// the already-finished job is ignored so the caller can wait for a retry.
export async function waitForJob({
  client,
  afterJobId = null,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_MS,
  onProgress = null,
  signal = null,
  clock = () => Date.now(),
}) {
  const start = clock();
  let lastSignature = null;
  let consecutiveErrors = 0;
  for (;;) {
    if (signal && signal.aborted) return { ok: false, error: "cancelled-by-user" };
    const res = await client.status();
    if (!res.ok) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 10) return { ok: false, error: res.error || "target-unavailable" };
    } else {
      consecutiveErrors = 0;
      const view = res.view;
      if (view && view.jobId !== afterJobId) {
        const signature = `${view.state}:${view.progress.applied}:${view.progress.failed}:${view.totals.cookies}`;
        if (onProgress && signature !== lastSignature) onProgress(view);
        lastSignature = signature;
        if (TERMINAL_JOB_STATES.has(view.state)) return { ok: true, view };
      }
    }
    if (clock() - start >= timeoutMs) return { ok: false, error: "timeout" };
    await sleep(intervalMs, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    if (signal) {
      if (signal.aborted) finish();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
