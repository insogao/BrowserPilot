// Source extension popup. It never sees cookie values: the service worker
// keeps them in memory and only returns domain/count metadata or a sanitized
// job view.
import { failureText } from "./lib/contract.mjs";

const $ = (id) => document.getElementById(id);

let groups = [];
let totals = null;
let currentView = null;
let pollTimer = null;
let pollFailures = 0;
let settingsCache = { lastJob: null, selectedDomains: [] };
let sendInFlight = false;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: "extension-message-failed" });
      else resolve(response || { ok: false, error: "no-response" });
    });
  });
}

function fmt(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

function setSummary(id, text, kind) {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("error", kind === "error");
  el.classList.toggle("ok", kind === "ok");
}

function errorText(code) {
  const map = {
    "consent-required": "请先勾选明确授权。",
    "scan-required": "扫描结果已释放，请重新扫描。",
    "no-domains-selected": "请至少勾选一个域名。",
    "domain-not-scanned": "所选域名不在本次扫描结果中，请重新扫描。",
    "no-cookies-selected": "所选域名没有可发送的 Cookie。",
    "ticket-invalid": "导入票据格式不正确；请从 Browser CLI 导入窗口重新复制。",
    "ticket-expired": "导入票据已过期；请在 Browser CLI 中获取新票据。",
    "ticket-consumed": "这张导入票据已经被使用；一张票据只能授权一次导入。",
    "rate-limited": "失败次数过多，Browser CLI 已暂时锁定导入会话；请重新启动导入。",
    "target-not-running": "没有找到运行中的 Browser CLI 导入会话；请先在 Browser CLI 中启动导入。",
    "target-disconnected": "与 Browser CLI 的连接已中断；请查看目标浏览器窗口中的结果。",
    "protocol-mismatch": "来源扩展与目标协议版本不一致，请同时更新两端。",
    "native-messaging-unavailable": "BrowserPilot 本机中转进程不可用；请确认 native host 已注册。",
    "transport-closed": "本机中转进程连接已关闭。",
    "import-mode-conflict": "本机中转进程已进入普通模式；请重新发送以启动新的导入会话。",
    "job-not-observable": "后台页面可能已休眠；请查看 Browser CLI 导入窗口中的最终结果。",
    "target-busy": "目标正在处理另一个导入任务，请稍后重试。",
    "target-response-invalid": "目标返回了不符合契约的响应，已停止显示。",
    "target-contract-mismatch": "目标接口版本不匹配。",
    "job-not-found": "任务不存在或已过期，请重新发送。",
    "too-many-cookies": "Cookie 数量超过目标上限。",
    "too-large": "导入数据超过大小上限。",
    "internal-error": "扩展内部错误。",
    "extension-message-failed": "扩展消息失败。",
    "no-response": "扩展没有响应。",
    busy: "上一次发送仍在进行。",
  };
  if (code in map) return map[code];
  if (code && String(code).startsWith("http-")) return `目标返回错误 ${code}。`;
  const text = failureText(code);
  return text === "未知失败原因。" ? String(code || "未知错误") : text;
}

function selectedDomains() {
  return [...document.querySelectorAll(".domain-check:checked")].map((cb) => cb.dataset.domain);
}

function selectedCookieCount() {
  const wanted = new Set(selectedDomains());
  return groups.filter((g) => wanted.has(g.domain)).reduce((n, g) => n + g.count, 0);
}

function updateSelectionUi() {
  const domains = selectedDomains();
  $("selectionCount").textContent = `已选 ${fmt(domains.length)} 个域名 / ${fmt(selectedCookieCount())} 条 Cookie`;
  const ready =
    domains.length > 0 &&
    $("sendConsent").checked &&
    $("ticket").value.trim() !== "" &&
    !sendInFlight;
  $("sendBtn").disabled = !ready;
}

function renderGroups(selected = []) {
  const tbody = $("groupsTable").querySelector("tbody");
  tbody.innerHTML = "";
  const wanted = new Set(selected);
  for (const group of groups) {
    const tr = document.createElement("tr");
    const checkCell = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "domain-check";
    cb.dataset.domain = group.domain;
    cb.checked = wanted.has(group.domain);
    cb.addEventListener("change", updateSelectionUi);
    checkCell.appendChild(cb);
    tr.appendChild(checkCell);
    for (const [value, className] of [
      [group.domain, "domain"],
      [fmt(group.count), ""],
      [fmt(group.httpOnly), ""],
      [fmt(group.session), ""],
      [fmt(group.partitioned), ""],
    ]) {
      const td = document.createElement("td");
      if (className) td.className = className;
      td.textContent = String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  updateSelectionUi();
}

async function doScan({ preserveSelection = false } = {}) {
  if (!$("ack").checked) {
    setSummary("scanSummary", errorText("consent-required"), "error");
    return false;
  }
  const previous = preserveSelection ? selectedDomains() : [];
  $("scanBtn").disabled = true;
  setSummary("scanSummary", "正在读取域名列表（只读取元数据）…", null);
  const res = await sendMessage({ type: "scan", payload: { acknowledged: true } });
  $("scanBtn").disabled = !$("ack").checked;
  if (!res.ok) {
    setSummary("scanSummary", `扫描失败：${errorText(res.error)}`, "error");
    return false;
  }
  groups = res.groups || [];
  totals = res.totals || null;
  $("listWrapCard").hidden = false;
  $("sendCard").hidden = false;
  const restore = preserveSelection
    ? previous
    : Array.isArray(settingsCache.selectedDomains)
      ? settingsCache.selectedDomains
      : [];
  renderGroups(restore);
  setSummary(
    "scanSummary",
    `共 ${fmt(totals.cookies)} 条 Cookie / ${fmt(totals.domains)} 个域名。` +
      ` HttpOnly ${fmt(totals.httpOnly)}，Session ${fmt(totals.session)}，分区 ${fmt(totals.partitioned)}。` +
      `\n只显示数量；Cookie 值不会显示在界面上。`,
    "ok",
  );
  return true;
}

function clearTicket() {
  $("ticket").value = "";
  updateSelectionUi();
}

async function doSend({ isRetry = false } = {}) {
  if (!$("sendConsent").checked) {
    setSummary("sendSummary", "请重新勾选“发送授权”后再发送。", "error");
    return;
  }
  if ($("ticket").value.trim() === "") {
    setSummary("sendSummary", "请粘贴 Browser CLI 导入窗口显示的一次性导入票据。", "error");
    $("ticket").focus();
    return;
  }
  if (isRetry) {
    const ok = await doScan({ preserveSelection: true });
    if (!ok) return;
  }
  const domains = selectedDomains();
  if (domains.length === 0) {
    setSummary("sendSummary", errorText("no-domains-selected"), "error");
    return;
  }
  sendInFlight = true;
  updateSelectionUi();
  $("sendBtn").disabled = true;
  setSummary("sendSummary", "正在通过 BrowserPilot 本机中转进程连接 Browser CLI…", null);
  const res = await sendMessage({
    type: "send",
    payload: {
      ticket: $("ticket").value.trim(),
      domains,
      consent: true,
      profileLabel: $("profileLabel").value.trim(),
    },
  });
  sendInFlight = false;
  updateSelectionUi();
  if (!res.ok) {
    setSummary("sendSummary", `发送失败：${errorText(res.error)}`, "error");
    if (["ticket-consumed", "ticket-expired", "rate-limited"].includes(res.error)) clearTicket();
    return;
  }
  settingsCache.selectedDomains = domains;
  settingsCache.lastJob = { jobId: res.jobId };
  // The ticket is one-time; never keep it after a successful handoff.
  clearTicket();
  $("sendConsent").checked = false;
  $("sendBtn").disabled = true;
  const skipped = res.skipped && Object.keys(res.skipped).length
    ? `\n已跳过 ${Object.entries(res.skipped).map(([code, n]) => `${failureText(code)}（${n}）`).join("；")}。`
    : "";
  const targetNote = res.targetNative === true
    ? ""
    : "\n注意：当前目标不是原生 Browser CLI（测试目标），不能据此宣称产品链路完成。";
  setSummary(
    "sendSummary",
    `已交给本机中转进程：${fmt(res.totals?.cookies)} 条 Cookie / ${fmt(res.totals?.domains)} 个域名。` +
      `\n任务号 ${res.jobId}。等待目标浏览器中的用户确认…${skipped}${targetNote}`,
    "ok",
  );
  $("resultCard").hidden = false;
  currentView = null;
  renderPending();
  startPolling();
}

function statusClass(status) {
  if (status === "imported") return "ok";
  if (status === "partially_imported") return "warn";
  if (status === "failed") return "bad";
  return "pending";
}

function renderAuthorization(view) {
  const auth = view?.authorization || {};
  if (auth.targetUserConfirmed === true) {
    const simulated = auth.simulated === true
      ? "（测试目标模拟，非真实用户确认）"
      : "（目标浏览器内用户确认）";
    $("stateAuth").textContent = `已确认${simulated}`;
    $("stateAuth").className = auth.simulated === true ? "v warn" : "v ok";
    return;
  }
  if (view?.state === "denied") {
    $("stateAuth").textContent = "用户已拒绝";
    $("stateAuth").className = "v bad";
    return;
  }
  if (view?.state === "awaiting_authorization") {
    $("stateAuth").textContent = "等待你在 Browser CLI 中确认";
    $("stateAuth").className = "v warn";
    return;
  }
  $("stateAuth").textContent = "等待目标浏览器确认";
  $("stateAuth").className = "v pending";
}

function renderPending() {
  $("stateLabel").textContent = "等待目标浏览器确认导入范围…";
  $("progressBar").style.width = "0%";
  $("stateData").textContent = "不适用（Cookie 不写入文件包）";
  $("stateData").className = "v pending";
  $("stateAuth").textContent = "等待目标浏览器确认";
  $("stateAuth").className = "v pending";
  $("stateCookie").textContent = "未开始";
  $("stateCookie").className = "v pending";
  $("stateLogin").textContent = "未验证（不做推断）";
  $("stateLogin").className = "v warn";
  $("resultDetail").textContent = "";
  $("failures").hidden = true;
  $("failures").innerHTML = "";
  $("relogin").hidden = true;
  $("cancelBtn").hidden = false;
  $("retryBtn").hidden = true;
}

function renderView(view) {
  currentView = view;
  const total = view.totals.cookies;
  const doneCount = view.progress.applied + view.progress.failed;
  const pct = total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;
  $("progressBar").style.width = `${pct}%`;
  const stateText = {
    pending: "已接收，等待目标处理…",
    awaiting_authorization: "等待你在 Browser CLI 中确认导入范围…",
    applying: "正在写入 Cookie…",
    done: "目标已完成。",
    failed: "目标报告失败。",
    cancelled: "导入已取消。",
    denied: "你在目标浏览器中拒绝了本次导入。",
  }[view.state] || view.state;
  $("stateLabel").textContent = stateText;
  $("stateData").textContent = "不适用（Cookie 不写入文件包）";
  $("stateData").className = "v pending";
  renderAuthorization(view);

  const status = view.cookieImported.status;
  const cookieText = {
    not_started: "未开始",
    imported: `已写入 ${fmt(view.cookieImported.applied)} 条 Cookie`,
    partially_imported: `部分写入：成功 ${fmt(view.cookieImported.applied)} / 失败 ${fmt(view.cookieImported.failed)}`,
    failed: `写入失败：${fmt(view.cookieImported.failed)} 条`,
  }[status] || status;
  $("stateCookie").textContent = cookieText;
  $("stateCookie").className = `v ${statusClass(status)}`;

  // Login verification is never derived from cookie counts.
  $("stateLogin").textContent = "未验证（不做推断）";
  $("stateLogin").className = "v warn";

  const bits = [
    `共 ${fmt(total)} 条，已写入 ${fmt(view.progress.applied)} 条，失败 ${fmt(view.progress.failed)} 条`,
  ];
  if (view.totals.selectedDomains) bits.push(`勾选域名 ${fmt(view.totals.selectedDomains)} 个`);
  if (view.sessionCookies?.count > 0) {
    bits.push(`其中会话 Cookie ${fmt(view.sessionCookies.count)} 条（浏览器重启后不保证保留）`);
  }
  if (view.error) bits.push(`错误：${view.error.message}`);
  $("resultDetail").textContent = bits.join("；");

  const failures = Object.entries(view.cookieImported.failures || {});
  const list = $("failures");
  list.innerHTML = "";
  list.hidden = failures.length === 0;
  for (const [code, count] of failures) {
    const li = document.createElement("li");
    li.textContent = `${failureText(code)}（${fmt(count)} 条）`;
    list.appendChild(li);
  }

  const terminal = ["done", "failed", "cancelled", "denied"].includes(view.state);
  $("cancelBtn").hidden = terminal;
  $("retryBtn").hidden = !terminal;
  if (terminal && view.state === "denied") {
    $("relogin").textContent = "目标浏览器的用户拒绝了本次导入。请检查勾选域名，或重新启动 Browser CLI 导入会话。";
  } else if (terminal && view.state === "failed" && view.progress.applied === 0 && view.progress.failed === 0) {
    $("relogin").textContent = "目标没有写入任何 Cookie。请检查失败原因，并在 Browser CLI 中重新启动导入会话。";
  } else if (terminal) {
    $("relogin").textContent =
      "请在 Browser CLI 中打开上面勾选的网站，确认是否仍处于登录状态。若未登录，请重新登录；" +
      "设备绑定/风控会话可能无法迁移。Cookie 写入成功不等于登录成功。" +
      (view.sessionCookies?.count > 0 ? " 会话 Cookie 在浏览器重启后可能丢失。" : "");
  }
  if (terminal) {
    $("sendBtn").disabled = true;
    setSummary(
      "sendSummary",
      view.state === "done"
        ? "目标写入结束。请按下方提示在 Browser CLI 中确认登录。"
        : view.state === "cancelled"
          ? "已取消；已经写入的 Cookie 不会回滚。"
          : view.state === "denied"
            ? "目标浏览器中的用户拒绝了导入。"
            : "目标未能完成导入。请重新启动导入会话并获取新票据。",
      view.state === "done" ? "ok" : "error",
    );
  }
}

function startPolling() {
  stopPolling();
  pollFailures = 0;
  $("resultCard").hidden = false;
  $("cancelBtn").hidden = false;
  $("retryBtn").hidden = true;
  const tick = async () => {
    const res = await sendMessage({ type: "status", payload: {} });
    if (!res.ok) {
      pollFailures += 1;
      if (pollFailures >= 8) {
        stopPolling();
        $("stateLabel").textContent = `无法获取进度：${errorText(res.error)}`;
        $("cancelBtn").hidden = true;
        $("retryBtn").hidden = false;
        return;
      }
    } else {
      pollFailures = 0;
      renderView(res.view);
      if (["done", "failed", "cancelled", "denied"].includes(res.view.state)) {
        stopPolling();
        return;
      }
    }
    pollTimer = setTimeout(tick, 800);
  };
  pollTimer = setTimeout(tick, 300);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

$("ack").addEventListener("change", () => {
  $("scanBtn").disabled = !$("ack").checked;
});
$("scanBtn").addEventListener("click", () => {
  void doScan();
});
$("allBtn").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".domain-check")) cb.checked = true;
  updateSelectionUi();
});
$("noneBtn").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".domain-check")) cb.checked = false;
  updateSelectionUi();
});
$("sendConsent").addEventListener("change", updateSelectionUi);
$("ticket").addEventListener("input", updateSelectionUi);
$("sendBtn").addEventListener("click", () => {
  void doSend();
});
$("cancelBtn").addEventListener("click", async () => {
  const res = await sendMessage({ type: "cancel", payload: {} });
  if (!res.ok) {
    setSummary("sendSummary", `取消失败：${errorText(res.error)}`, "error");
    return;
  }
  setSummary("sendSummary", "已请求取消。已写入的 Cookie 不会回滚；可在目标浏览器中退出登录。", "error");
});
$("retryBtn").addEventListener("click", () => {
  if (!$("sendConsent").checked) {
    setSummary("sendSummary", "重试需要重新勾选“发送授权”。", "error");
    $("sendConsent").focus();
    return;
  }
  if ($("ticket").value.trim() === "") {
    setSummary("sendSummary", "一张票据只能授权一次导入。请从 Browser CLI 导入窗口获取新的票据后再重试。", "error");
    $("ticket").focus();
    return;
  }
  void doSend({ isRetry: true });
});

async function init() {
  const res = await sendMessage({ type: "settings" });
  if (res.ok) {
    settingsCache = {
      lastJob: res.lastJob || null,
      selectedDomains: res.selectedDomains || [],
    };
    updateSelectionUi();
    if (settingsCache.lastJob && settingsCache.lastJob.jobId) {
      $("resultCard").hidden = false;
      if (settingsCache.lastJob.lastView) {
        renderView(settingsCache.lastJob.lastView);
      } else {
        renderPending();
        startPolling();
      }
    }
  }
}

void init();
