const status = document.getElementById("status");
const run = document.getElementById("run");

function siteFromUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.hostname;
  } catch {
    return null;
  }
}

run.addEventListener("click", async () => {
  run.disabled = true;
  status.textContent = "Reading cookies...";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const domain = siteFromUrl(tab?.url || "");
    if (!domain) throw new Error("Current tab is not an http(s) site");
    const cookies = await chrome.cookies.getAll({ domain });
    if (!cookies.length) throw new Error("No cookies for " + domain);
    // The pairing token is created by the native Browser CLI importer and
    // pasted/confirmed by the user; never ship a fixed token.
    const stored = await chrome.storage.session.get("bpImportToken");
    const token = stored.bpImportToken || prompt("Browser CLI pairing code (printed by the importer):");
    if (!token) throw new Error("No pairing code");
    await chrome.storage.session.set({ bpImportToken: token });
    const response = await fetch("http://127.0.0.1:18082/import", {
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
    status.textContent = `Imported ${result.applied || 0} cookies; failed ${result.failed || 0}.`;
  } catch (error) {
    status.textContent = String(error.message || error);
  } finally {
    run.disabled = false;
  }
});
