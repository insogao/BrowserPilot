// Prototype source-side export. The popup calls the same function after the
// user clicks the toolbar button. The loopback endpoint and pairing code are
// supplied by the target Browser CLI importer.
async function exportCookies({ domain, token, endpoint }) {
  if (!domain || !token || !endpoint) throw new Error("missing domain/token/endpoint");
  const cookies = await chrome.cookies.getAll({ domain });
  if (!cookies.length) return { applied: 0, failed: 0, empty: true };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bp-token": token },
    body: JSON.stringify({
      domain,
      cookies: cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        session: c.session, expirationDate: c.expirationDate ?? null,
        partitionKey: c.partitionKey ?? null,
      })),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

globalThis.exportCookies = exportCookies;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bp-export-cookies") return false;
  exportCookies(message.payload).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error.message || error) }),
  );
  return true;
});
