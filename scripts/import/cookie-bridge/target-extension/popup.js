const $ = (id) => document.getElementById(id);

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: "no-response" });
    });
  });
}

function brokerParams() {
  const brokerUrl = $("brokerUrl").value.trim();
  const pair = $("pair").value.trim();
  if (!brokerUrl || !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(brokerUrl)) {
    return { error: "Broker 地址必须是 http://127.0.0.1:<port>。" };
  }
  if (!pair) return { error: "请填写 broker 启动时打印的配对码。" };
  return { brokerUrl, pair };
}

$("fetchBtn").addEventListener("click", async () => {
  const p = brokerParams();
  if (p.error) {
    $("out").textContent = p.error;
    return;
  }
  $("out").textContent = "查询中…";
  const res = await sendMessage({ type: "fetch", payload: p });
  if (!res.ok) {
    $("out").textContent = `查询失败：${res.error}`;
    return;
  }
  if (res.empty) {
    $("out").textContent = "当前没有待导入任务。请先在来源浏览器中点击发送。";
    $("applyBtn").disabled = true;
    return;
  }
  $("applyBtn").disabled = false;
  const t = res.totals || {};
  const lines = [
    `任务 ${res.jobId}`,
    `来源：${res.source?.browser || "unknown"} / ${res.source?.profileLabel || "default"}`,
    `Cookie ${t.cookies ?? 0} 条，域名 ${t.domains ?? 0} 个`,
    "",
    "示例（不含值）：",
    ...(res.sample || []).map(
      (c) =>
        `  ${c.domain}${c.path} secure=${c.secure} httpOnly=${c.httpOnly} session=${c.session} partitioned=${c.partitioned} sameSite=${c.sameSite}`,
    ),
    "",
    "点击“应用 Cookie”后才会写入当前 Profile。",
  ];
  $("out").textContent = lines.join("\n");
});

$("applyBtn").addEventListener("click", async () => {
  const p = brokerParams();
  if (p.error) {
    $("out").textContent = p.error;
    return;
  }
  $("applyBtn").disabled = true;
  $("out").textContent = "写入中…（失败项只统计原因，不记录 Cookie 内容）";
  const res = await sendMessage({ type: "apply", payload: p });
  if (!res.ok) {
    $("out").textContent = `写入失败：${res.error}`;
    $("applyBtn").disabled = false;
    return;
  }
  const r = res.result;
  const failureLines = Object.entries(r.failures || {}).map(([k, v]) => `  ${k}: ${v}`);
  $("out").textContent = [
    `已写入：${r.applied} 条；失败：${r.failed} 条。`,
    failureLines.length ? "失败原因：" : "没有失败项。",
    ...failureLines,
    "",
    "登录状态：未验证（not_verified）。",
    "请在当前浏览器实际打开网站确认登录；如需记录，请使用 CLI: browser-data-import verify --confirm-user-action。",
  ].join("\n");
});
