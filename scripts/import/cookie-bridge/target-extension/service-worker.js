// Target-side cookie bridge. Writes cookies into THIS profile only, through
// chrome.cookies.set. The source browser keeps its cookies; nothing is deleted
// or modified there.
import { cookieToSetDetails, classifySetError } from "./lib/apply-cookie.mjs";

let currentJob = null;
let lastResult = null;

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

async function fetchNext({ brokerUrl, pair }) {
  const res = await fetch(`${trimSlash(brokerUrl)}/v1/jobs/next`, { headers: { "x-bp-pair": pair } });
  if (res.status === 204) {
    currentJob = null;
    return { ok: true, empty: true };
  }
  if (!res.ok) return { ok: false, error: `http-${res.status}` };
  const body = await res.json();
  currentJob = body;
  return {
    ok: true,
    empty: false,
    jobId: body.jobId,
    source: body.source,
    totals: body.totals,
    sample: (body.cookies || []).slice(0, 5).map((c) => ({
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      session: c.session,
      partitioned: !!c.partitionKey,
      sameSite: c.sameSite,
    })),
  };
}

async function applyJob({ brokerUrl, pair, concurrency = 4 }) {
  if (!currentJob) {
    const got = await fetchNext({ brokerUrl, pair });
    if (!got.ok) return got;
    if (got.empty) return { ok: false, error: "no-pending-job" };
  }
  const job = currentJob;
  const cookies = Array.isArray(job.cookies) ? job.cookies : [];
  let applied = 0;
  let failed = 0;
  const failures = {};

  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 4, 8)) }, async () => {
    while (index < cookies.length) {
      const i = index++;
      const cookie = cookies[i];
      const mapped = cookieToSetDetails(cookie);
      if (!mapped.ok) {
        failed += 1;
        failures[mapped.reason] = (failures[mapped.reason] || 0) + 1;
        continue;
      }
      try {
        const result = await chrome.cookies.set(mapped.details);
        if (result) applied += 1;
        else {
          failed += 1;
          failures["api-returned-null"] = (failures["api-returned-null"] || 0) + 1;
        }
      } catch (err) {
        failed += 1;
        const reason = classifySetError(err);
        failures[reason] = (failures[reason] || 0) + 1;
      }
    }
  });
  await Promise.all(workers);

  const resultPayload = { applied, failed, failures, loginVerified: "not_verified" };
  const res = await fetch(`${trimSlash(brokerUrl)}/v1/jobs/${encodeURIComponent(job.jobId)}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bp-pair": pair },
    body: JSON.stringify(resultPayload),
  });
  lastResult = {
    jobId: job.jobId,
    applied,
    failed,
    failures,
    reported: res.ok,
    loginVerified: "not_verified",
    note: "Cookie set is not proof of a working login. Open the site in this browser and confirm.",
    at: new Date().toISOString(),
  };
  currentJob = null;
  if (!res.ok) return { ok: false, error: `report-failed-${res.status}`, result: lastResult };
  return { ok: true, result: lastResult };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "fetch") {
        sendResponse(await fetchNext(msg.payload || {}));
        return;
      }
      if (msg && msg.type === "apply") {
        sendResponse(await applyJob(msg.payload || {}));
        return;
      }
      if (msg && msg.type === "lastResult") {
        sendResponse({ ok: true, result: lastResult });
        return;
      }
      sendResponse({ ok: false, error: "unknown-message" });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});
