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
let settingsCache = { endpoint: "", pair: "", lastJob: null, selectedDomains: [] };
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
    "endpoint-invalid": "地址格式不正确。",
    "endpoint-must-be-http": "地址必须以 http:// 开头。",
    "endpoint-must-be-loopback": "地址必须是 127.0.0.1（不允许局域网或域名）。",
    "endpoint-needs-port": "地址必须包含端口。",
    "endpoint-has-path": "地址不能带路径。",
    "endpoint-has-query-or-hash": "地址不能带查询参数。",
    "endpoint-has-credentials": "地址不能带用户名/密码。",
    "pair-code-invalid": "配对码必须是 6 位数字。",
    "network-error": "无法连接本机 Browser CLI；请确认导入命令仍在运行。",
    "target-busy": "目标正在处理另一个导入任务，请稍后重试。",
    "target-response-invalid": "目标返回了不符合契约的响应，已停止显示。",
    "target-contract-mismatch": "目标接口版本不匹配。",
    "job-not-found": "任务不存在或已过期，请重新发送。",
    "http-401": "配对码错误或已失效。",
    "http-403": "来源扩展未被目标允许。",
    "http-404": "目标接口不存在。",
    "http-409": "目标正忙，请稍后重试。",
    "http-413": "发送内容超过目标大小限制。",
    "internal-error": "扩展内部错误。",
    "extension-message-failed": "扩展消息失败。",
    "no-response": "扩展没有响应。",
    "busy": "上一次发送仍在进行。",
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
    $("endpoint").value.trim() !== "" &&
    $("pair").value.trim() !== "" &&
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

async function persistConnection() {
  const endpoint = $("endpoint").value.trim();
  const pair = $("pair").value.trim();
  settingsCache = { ...settingsCache, endpoint, pair };
  await chrome.storage.session.set({ bp_endpoint: endpoint, bp_pair: pair });
}

async function doSend({ isRetry = false } = {}) {
  if (!$("sendConsent").checked) {
    setSummary("sendSummary", "请重新勾选“发送授权”后再发送。", "error");
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
  setSummary("sendSummary", "正在发送到本机 Browser CLI…", null);
  const res = await sendMessage({
    type: "send",
    payload: {
      endpoint: $("endpoint").value.trim(),
      pair: $("pair").value.trim(),
      domains,
      consent: true,
      profileLabel: $("profileLabel").value.trim(),
    },
  });
  sendInFlight = false;
  updateSelectionUi();
  if (!res.ok) {
    setSummary("sendSummary", `发送失败：${errorText(res.error)}`, "error");
    return;
  }
  settingsCache.selectedDomains = domains;
  settingsCache.lastJob = { jobId: res.jobId };
  $("sendConsent").checked = false;
  $("sendBtn").disabled = true;
  const skipped = res.skipped && Object.keys(res.skipped).length
    ? `\n已跳过 ${Object.entries(res.skipped).map(([code, n]) => `${failureText(code)}（${n}）`).join("；")}。`
    : "";
  setSummary(
    "sendSummary",
    `已交给本机目标：${fmt(res.totals?.cookies)} 条 Cookie / ${fmt(res.totals?.domains)} 个域名。` +
      `\n任务号 ${res.jobId}。等待写入结果…${skipped}`,
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

function renderPending() {
  $("stateLabel").textContent = "等待目标写入…";
  $("progressBar").style.width = "0%";
  $("stateData").textContent = "不适用（Cookie 不写入文件包）";
  $("stateData").className = "v pending";
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
    pending: "已接收，等待目标写入…",
    applying: "正在写入 Cookie…",
    done: "目标已完成。",
    failed: "目标报告失败。",
    cancelled: "导入已取消。",
  }[view.state] || view.state;
  $("stateLabel").textContent = stateText;
  $("stateData").textContent = "不适用（Cookie 不写入文件包）";
  $("stateData").className = "v pending";

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

  const terminal = ["done", "failed", "cancelled"].includes(view.state);
  $("cancelBtn").hidden = terminal;
  $("retryBtn").hidden = !terminal;
  $("relogin").hidden = !terminal;
  if (terminal && view.progress.applied === 0 && view.progress.failed === 0) {
    $("relogin").textContent = "目标没有写入任何 Cookie。请检查失败原因、配对码和目标状态后重试。";
  } else if (terminal) {
    $("relogin").textContent =
      "请在 Browser CLI 中打开上面勾选的网站，确认是否仍处于登录状态。若未登录，请重新登录；" +
      "设备绑定/风控会话可能无法迁移。Cookie 写入成功不等于登录成功。";
  }
  if (terminal) {
    $("sendBtn").disabled = true;
    setSummary(
      "sendSummary",
      view.state === "done"
        ? "目标写入结束。请按下方提示在 Browser CLI 中确认登录。"
        : view.state === "cancelled"
          ? "已取消；已经写入的 Cookie 不会回滚。"
          : "目标未能完成导入。可重新扫描并重试。",
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
      if (["done", "failed", "cancelled"].includes(res.view.state)) {
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
$("endpoint").addEventListener("input", () => {
  void persistConnection();
  updateSelectionUi();
});
$("pair").addEventListener("input", () => {
  void persistConnection();
  updateSelectionUi();
});
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
  void doSend({ isRetry: true });
});

async function init() {
  const res = await sendMessage({ type: "settings" });
  if (res.ok) {
    settingsCache = {
      endpoint: res.endpoint || "",
      pair: res.pair || "",
      lastJob: res.lastJob || null,
      selectedDomains: res.selectedDomains || [],
    };
    $("endpoint").value = settingsCache.endpoint;
    $("pair").value = settingsCache.pair;
    updateSelectionUi();
    if (settingsCache.lastJob && settingsCache.lastJob.jobId) {
      $("resultCard").hidden = false;
      renderPending();
      startPolling();
    }
  }
}

void init();
