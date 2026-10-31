// Source bridge popup. All values stay in the service worker unless the user
// explicitly clicks Send.
const $ = (id) => document.getElementById(id);

let groups = [];
let totals = null;
let jobId = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: "no-response" });
    });
  });
}

function fmt(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

function render() {
  const host = $("groups");
  host.innerHTML = "";
  if (!groups.length) {
    host.textContent = "没有可显示的 Cookie。";
    return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th></th><th>域名</th><th>数量</th><th>HttpOnly</th><th>Session</th><th>Partitioned</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const g of groups) {
    const tr = document.createElement("tr");
    const td0 = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.domain = g.domain;
    cb.className = "domain-check";
    td0.appendChild(cb);
    tr.appendChild(td0);
    for (const value of [g.domain, fmt(g.count), fmt(g.httpOnly), fmt(g.session), fmt(g.partitioned)]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

$("scanBtn").addEventListener("click", async () => {
  $("summary").textContent = "扫描中…";
  const res = await sendMessage({ type: "scan" });
  if (!res.ok) {
    $("summary").textContent = `扫描失败：${res.error}`;
    return;
  }
  groups = res.groups || [];
  totals = res.totals;
  jobId = null;
  $("listWrap").hidden = false;
  $("summary").textContent =
    `共 ${fmt(totals.cookies)} 条 Cookie（${fmt(totals.domains)} 个域名）。` +
    ` HttpOnly ${fmt(totals.httpOnly)}，Session ${fmt(totals.session)}，Partitioned ${fmt(totals.partitioned)}。\n` +
    `扫描时间：${res.scannedAt || ""}\n` +
    `说明：官方 API 可读取 HttpOnly；分区 Cookie 会携带 partitionKey；Session Cookie 会包含。`;
  render();
});

$("allBtn").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".domain-check")) cb.checked = true;
});
$("noneBtn").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".domain-check")) cb.checked = false;
});

$("sendBtn").addEventListener("click", async () => {
  const brokerUrl = $("brokerUrl").value.trim();
  const pair = $("pair").value.trim();
  if (!brokerUrl || !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(brokerUrl)) {
    $("sendResult").textContent = "Broker 地址必须是 http://127.0.0.1:<port>。";
    return;
  }
  if (!pair) {
    $("sendResult").textContent = "请填写 broker 启动时打印的配对码。";
    return;
  }
  if (!$("consent").checked) {
    $("sendResult").textContent = "请先确认你理解 Cookie 等同于登录凭证。";
    return;
  }
  const domains = [...document.querySelectorAll(".domain-check")]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.domain);
  if (!domains.length) {
    $("sendResult").textContent = "至少选择一个域名。";
    return;
  }
  $("sendResult").textContent = "发送中（仅发往本机）…";
  const res = await sendMessage({
    type: "send",
    payload: { brokerUrl, pair, domains, profileLabel: $("profileLabel").value.trim() },
  });
  if (!res.ok) {
    $("sendResult").textContent = `发送失败：${res.error || res.status}`;
    return;
  }
  jobId = res.jobId;
  $("sendResult").textContent =
    `已交给本机 Broker：job ${jobId}，${fmt(res.totals?.cookies)} 条 Cookie / ${fmt(res.totals?.domains)} 个域名。\n` +
    `现在切换到目标浏览器的 Bridge 扩展并点击“获取待导入任务”。`;
});

// Optional status polling button is intentionally omitted: the target extension
// reports counts, and the CLI's three-state result is authoritative.
