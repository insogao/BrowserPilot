// HTTP client for the Browser CLI cookie-import v2 contract.
//
// This client is used by the local test target and by contract tests. The
// product source extension does not use HTTP: it talks to the BrowserPilot
// native messaging host, which connects out to the Browser CLI named pipe.
// The client still validates every response and strips it to the public,
// count-only shape, so a buggy or hostile target cannot inject cookie values
// or a fake login verification into the terminal/report.
import * as contract from "../contract.mjs";

export class TargetClient {
  constructor({ endpoint, ticket, timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
    const check = contract.validateLoopbackEndpoint(endpoint);
    if (!check.ok) throw new Error(check.error);
    if (!contract.isValidTicket(ticket)) throw new Error("ticket-invalid");
    if (typeof fetchImpl !== "function") throw new Error("fetch-unavailable");
    this.endpoint = check.base;
    this.ticket = contract.normalizeTicket(ticket);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async _request(pathname, { method = "GET", body, rawBody, extraHeaders = {}, authenticated = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
        method,
        headers: {
          ...(authenticated ? { "x-bp-ticket": this.ticket } : {}),
          ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, error: err && err.name === "AbortError" ? "timeout" : "network-error" };
    }
    clearTimeout(timer);
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code =
        parsed && typeof parsed.error === "string" && /^[a-z0-9-]{1,64}$/.test(parsed.error)
          ? parsed.error
          : `http-${response.status}`;
      return { ok: false, error: code, status: response.status, body: parsed };
    }
    if (parsed === null) return { ok: false, error: "invalid-json", status: response.status };
    return { ok: true, status: response.status, body: parsed };
  }

  async capabilities() {
    const res = await this._request("/v2/import/capabilities", { authenticated: false });
    if (!res.ok) return res;
    const body = res.body;
    if (!body || body.contract !== contract.CONTRACT_ID) {
      return { ok: false, error: "target-contract-mismatch" };
    }
    if (!body.capabilities || body.capabilities.cookieStoreWrite !== true) {
      return { ok: false, error: "target-cookie-store-unsupported" };
    }
    return {
      ok: true,
      contract: body.contract,
      protocolVersion: body.protocolVersion,
      product: typeof body.product === "string" ? body.product : "unknown",
      mode: typeof body.mode === "string" ? body.mode : "unknown",
      transport: typeof body.transport === "string" ? body.transport : "unknown",
      native: body.native === true,
      authorization: body.authorization && typeof body.authorization === "object"
        ? {
            mode: typeof body.authorization.mode === "string" ? body.authorization.mode : "unknown",
            independentTargetConfirmation: body.authorization.independentTargetConfirmation === true,
            note: typeof body.authorization.note === "string" ? body.authorization.note : undefined,
          }
        : { mode: "unknown", independentTargetConfirmation: false },
      capabilities: {
        cookieStoreWrite: true,
        persistAcrossRestart: body.capabilities.persistAcrossRestart === true,
        partitionedCookies: body.capabilities.partitionedCookies === true,
        sessionCookies: body.capabilities.sessionCookies === true,
        sessionCookiePersistence: body.capabilities.sessionCookiePersistence === "not_guaranteed"
          ? "not_guaranteed"
          : "unknown",
        maxCookiesPerJob: Number.isInteger(body.capabilities.maxCookiesPerJob)
          ? body.capabilities.maxCookiesPerJob
          : contract.MAX_COOKIES_PER_JOB,
        maxValueBytes: Number.isInteger(body.capabilities.maxValueBytes)
          ? body.capabilities.maxValueBytes
          : contract.MAX_VALUE_BYTES,
        ticketTtlSeconds: Number.isInteger(body.capabilities.ticketTtlSeconds)
          ? body.capabilities.ticketTtlSeconds
          : Math.floor(contract.TICKET_TTL_MS / 1000),
      },
    };
  }

  async status() {
    const res = await this._request("/v2/import/status");
    if (!res.ok) return res;
    if (res.body?.state === "idle") return { ok: true, idle: true, view: null };
    const view = contract.sanitizePublicJobView(res.body);
    if (!view) return { ok: false, error: "target-response-invalid" };
    return { ok: true, idle: false, view };
  }

  async job(jobId) {
    if (typeof jobId !== "string" || !/^[a-f0-9]{24}$/.test(jobId)) return { ok: false, error: "job-id-invalid" };
    const res = await this._request(`/v2/import/jobs/${jobId}`);
    if (!res.ok) return res;
    const view = contract.sanitizePublicJobView(res.body);
    if (!view) return { ok: false, error: "target-response-invalid" };
    return { ok: true, view };
  }

  async cancel(jobId) {
    if (typeof jobId !== "string" || !/^[a-f0-9]{24}$/.test(jobId)) return { ok: false, error: "job-id-invalid" };
    const res = await this._request(`/v2/import/jobs/${jobId}/cancel`, { method: "POST" });
    if (!res.ok) return res;
    return { ok: true, state: typeof res.body?.state === "string" ? res.body.state : "unknown" };
  }

  // Used by tests and by the local test target; the product CLI never submits
  // because the source extension is the only component that holds cookie
  // values.
  async submit(request) {
    const checked = await contract.validateImportRequest(request);
    if (!checked.ok) return { ok: false, error: "invalid-request", details: checked.errors };
    const payloadText = JSON.stringify(request);
    const digest = await contract.jobDigest(payloadText);
    const res = await this._request("/v2/import/cookies", {
      method: "POST",
      rawBody: payloadText,
      extraHeaders: { "x-bp-job-digest": digest },
    });
    if (!res.ok) return res;
    const body = res.body;
    if (!body || body.contract !== contract.CONTRACT_ID || typeof body.jobId !== "string") {
      return { ok: false, error: "target-response-invalid" };
    }
    return {
      ok: true,
      jobId: body.jobId,
      state: typeof body.state === "string" ? body.state : "pending",
      transport: typeof body.transport === "string" ? body.transport : "unknown",
      native: body.native === true,
      totals: {
        cookies: Number(body.totals?.cookies) || 0,
        domains: Number(body.totals?.domains) || 0,
        selectedDomains: Number(body.totals?.selectedDomains) || 0,
        sessionCookies: Number(body.totals?.sessionCookies) || 0,
      },
    };
  }
}
