---
type: ExternalAgentRegistry
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-10-03
---

# BrowserPilot Opencode Agent Desk

Last updated: 2026-09-03 +08:00

This file tracks opencode sessions used to coordinate BrowserPilot template adaptation work. Use it as the dispatch desk when sending follow-up directions to reviewer or adapter agents.

## Operating Rules

- Default model for low-cost parallel review: `opencode-go/mimo-v2.5`.
- Do not ask adapter agents to edit plugin core unless a template cannot express the workflow with existing commands.
- Template adapter write scope is only `registry/templates/<template-id>/`.
- Adapter agents must read `registry/templates/README.md` before changing any template.
- Normal extension users must never be asked to run `npm`, rebuild the extension, or edit the installed Chrome extension directory. Templates are runtime-installed into `chrome.storage.local`.
- Maintainer/CI may run `npm run registry:build` after template packages change; adapter agents should not hand-edit `registry/catalog.json` or `registry/details/*.md`.
- File creation is not completion. Adapter handoff must distinguish package creation, static verification, and runtime smoke verification.
- A template can be called "runtime smoke passed" only after `install_template` plus `run_template` has been executed against the real browser/site/profile and returned the expected output.
- If BrowserPilot host, login, captcha, rate-limit, or site behavior blocks testing, the adapter must report `runtime smoke: blocked` with the exact command/error/failback. Do not call the task complete.
- Real-page inspection and runtime smoke are mandatory before an adapter may call its work complete. The core maintainer assigns the browser test turn to exactly one adapter agent at a time.
- A generic smoke operator may triage a regression batch, but its failback must not substitute for the site adapter's own browser investigation. Every failed site returns to its long-lived site adapter; that same adapter gets an exclusive browser turn, observes the live page/DOM/screenshots, edits only its package, and reruns smoke before handoff.
- Parallel agents are appropriate for source review, schema checks, documentation review, and non-browser tests. Site adapters must not be asked to write selectors from another agent's summary while they lack browser access.
- Tests that launch a Native Host are not resource-free static checks. They use the dedicated test port ranges configured by the test scripts and must never bind the production discovery range while live smoke is running.
- On a single Chrome profile, site-adapter browser turns are queued and serialized. True parallel live-page adaptation requires the future multi-instance Agent Pool (separate Chrome `user-data-dir`/Host per Agent).
- Preferred smoke path is `npm run smoke:template -- <template-id> [template-id...]`. It holds one repository-wide browser lease for the whole serial run.
- Manual browser commands must use `npm run browser:lease -- client <agent-name> <scope> <command> '<json>'`. Start with `open_space`, reuse the same Agent name, and end with `complete_space`. Naked page-affecting client commands are rejected by the client.
- Adapter agents must not auto-start the browser profile. If BrowserPilot host is unavailable or another browser lease is active, report blocked instead of opening tabs or bypassing the lease.
- The browser test lease is atomic, releases immediately after a normal run, and expires after ten minutes if its process crashes. There is no manual unlock step to forget.
- The CLI must not open `chrome-extension://.../onboarding/index.html` as a wake-up mechanism. Extension pages are user-facing UI and repeated opens are treated as a product bug.

## Maintenance Model

Use a hub-and-spoke model:

- Core maintainer agent: owns plugin-core capabilities, command semantics, runtime install/update/uninstall, download primitives, profile launch, visibility handling, and global human-like policy.
- Template family reviewers: periodically review related template packages for drift and duplication. Suggested families:
  - Search: Google, Baidu, Bing, Google Scholar.
  - Finance: Google Finance and future market-data pages.
  - Social: X/Twitter and other virtual-list/social-feed sites.
  - AI chat: ChatGPT, Gemini, and future chat UIs.
- Site adapter agents: create or update exactly one `registry/templates/<template-id>/` package at a time.

Do not create a permanent dedicated code-maintainer agent for every site unless that site is volatile or high-value. Start with template-family reviewers plus per-site adapter sessions. Promote a site to a dedicated maintainer only when it repeatedly breaks or has special flows such as login walls, virtual feeds, media downloads, or multi-step account state.

Human-like operation is a core policy, not a per-site invention. Site templates may add bounded waits, scroll batches, screenshots, and conservative retries, but global behavior such as randomized pacing, action jitter, and site-wide cooldowns belongs in plugin-core. `set_humanize` is reserved for that future core layer and should not be reimplemented differently in each template.

## Current Reviewer Sessions

| Role | Session ID | Title | Model | Status | Use for |
|---|---|---|---|---|---|
| Template contract reviewer | `ses_f9f393a61ffe3Jsa8mZ0JwiqWY` | `Reviewing BrowserPilot template contracts` | `opencode-go/mimo-v2.5` | Completed | Re-review Baidu/Bing/X template compliance against `registry/templates/README.md`. |
| Framework compatibility reviewer | `ses_f9f393a61ffeyCg5PTnZcuS0yh` | `BrowserPilot framework compatibility review` | `opencode-go/mimo-v2.5` | Completed | Re-check whether plugin-core supports runtime templates, `@focus`, `@results`, and visibility handling. |
| X/Twitter reviewer | `ses_f9f393a76ffeU040hO8jKPZfAq` | `BrowserPilot X search template review` | `opencode-go/mimo-v2.5` | Completed | Continue review of `x-search` lazy loading, screenshots, image URLs, and download handoff. |

## Latest Serialized Adapter Sessions

| Template | Session ID | Title | Runtime status |
|---|---|---|---|
| Bing | `ses_f9addf155ffeU78Qd3bJDFeZR8` | `BrowserPilot adapter for bing-search` | Passed: final smoke returned 10 links. |
| Google Scholar | `ses_f9acf38e1ffe7mkWHKsXU9vLL7` | `Google Scholar search template smoke test` | Blocked: Google anti-automation “Sorry...” page. |
| Google Finance | `ses_f9ac7502dffew0QWKpqq7IjTmQ` | `Configuring BrowserPilot for google-finance-search` | Blocked: inherited active Space caused `SPACE_NOT_OWNED`; no live DOM fix completed. |

## Earlier Adapter Sessions

These are likely the sessions that created the first Baidu/Bing search packages:

| Session ID | Title | Updated | Notes |
|---|---|---:|---|
| `ses_f9f1bc0f0ffenEBEvHdxFQsalr` | `Google Scholar search template creation` | 14:56 | New Google Scholar adapter session. Owns only `registry/templates/google-scholar-search/`. |
| `ses_f9f1bc0f5ffenbFu7ykCiDiWnT` | `Google Finance search template creation` | 14:58 | New Google Finance adapter session. Owns only `registry/templates/google-finance-search/`. |
| `ses_fa005b9cdffees6iTeiwGKL5B9` | `BrowserPilot适配百度必应搜索模板` | 12:50 | Adapter session. Inspect before sending targeted follow-up. |
| `ses_fa038d0b4ffe4Q1kZRARO64U4A` | `搜索网页模版适配：百度与必应` | 10:17 | Earlier adapter session. Inspect before sending targeted follow-up. |

Latest dispatch: on 2026-09-03, `ses_fa005b9cdffees6iTeiwGKL5B9` was resumed for exclusive, serial Baidu/Bing real-browser smoke under the enforced browser lease. Its write scope remains only `registry/templates/baidu-search/` and `registry/templates/bing-search/`.

## Useful Commands

List recent sessions:

```powershell
opencode session list
```

Export a session for audit:

```powershell
opencode export <session-id>
```

Continue an existing reviewer or adapter session:

```powershell
opencode run -m opencode-go/mimo-v2.5 --session <session-id> "Read registry/templates/README.md again, then perform the requested follow-up. Do not edit outside the allowed scope."
```

Start a new isolated read-only reviewer:

```powershell
opencode run -m opencode-go/mimo-v2.5 "You are a read-only BrowserPilot reviewer. Do not edit files. Read registry/templates/README.md first, then review the requested template package."
```

Start a new template adapter for one site:

```powershell
opencode run -m opencode-go/mimo-v2.5 "You are a BrowserPilot template adapter. Read registry/templates/README.md first. You may edit only registry/templates/<template-id>/. Do not edit src/, native-host/, manifest.json, registry/catalog.json, or registry/details/. When assigned the browser test turn, inspect the real page and run npm run smoke:template -- <template-id>; manual page commands must use the documented browser:lease wrapper and --no-launch. Never bypass an active lease, rebuild the extension, auto-start Chrome, or open a chrome-extension:// page. Do not call the task complete unless runtime smoke passed. If host/login/captcha/rate-limit/site behavior blocks testing, report runtime smoke: blocked with the exact command and error."
```

Run site adapters as an automatic serialized browser queue (the next Agent starts only after the previous process exits):

```powershell
npm run agents:queue -- bing-search google-scholar-search google-finance-search
```

Queue logs and `summary.json` are written under `.browserpilot-runs/<timestamp>/` and ignored by Git. The queue waits on actual Agent completion rather than polling every few seconds or assuming a fixed ten-minute duration. New runs require `BROWSERPILOT_ADAPTER_RESULT`, record `semanticStatus`, and count only `passed` as queue success; an exit code of zero is not sufficient. The queue also closes active temporary Spaces still owned by the completed Agent while preserving user-owned Spaces.

## Dispatch Notes From Latest Review

### Baidu Search

- Current package shape is acceptable.
- Main issue: result extraction is a monolithic inline JS block.
- Direction: refactor to declaration-driven `@focus selectors` plus `@results rootSelectors/linkSelector/minResults/limit/textLimit`.
- Suggested result declaration:
  - `rootSelectors`: `["#content_left", ".result", ".c-container"]`
  - `linkSelector`: `"h3 a,.t a"`
  - `minResults`: `3`
  - `limit`: `10`
  - `textLimit`: `6000`

### Bing Search

- Current package shape is acceptable.
- Main issue: result extraction is a monolithic inline JS block.
- Direction: refactor to declaration-driven `@focus selectors` plus `@results rootSelectors/linkSelector/minResults/limit/textLimit`.
- Suggested result declaration:
  - `rootSelectors`: `["#b_results"]`
  - `linkSelector`: `"li.b_algo h2 a"`
  - `minResults`: `3`
  - `limit`: `10`
  - `textLimit`: `6000`

### X/Twitter Search

- Current package shape is acceptable, but the template is not proven stable.
- Inline JS is justified because X/Twitter is a virtual-list SPA and needs tweet-specific extraction.
- Main issues:
  - No `waitForURL` after `open_tab`.
  - No `waitForSelector` for `article[data-testid=tweet]`.
  - No scroll loop to trigger lazy loading.
  - No screenshot verification.
  - Login/session/rate-limit states are not detected clearly.
  - Image URLs are returned but not downloaded.
- Direction for the adapter:
  - Revise only `registry/templates/x-search/`.
  - Add bounded wait/scroll/observe steps.
  - Use `screenshot` or `scroll_screenshot` when verifying visual feed state.
  - If downloads are required, collect image URLs and pass them to `download_resource` in a later step or document that the current template only returns URLs.
  - Stop and report on login wall, captcha, rate-limit, or verification prompts.

## Framework State For Future Agents

- Runtime templates can be installed via `install_template` and stored in `chrome.storage.local`.
- `run_template` now supports declaration-driven search:
  - `@focus` can receive `selectors`.
  - `@results` can receive `rootSelectors`, `linkSelector`, `minResults`, `limit`, and `textLimit`.
- `run_template` auto-restores/focuses the target tab before observation, JS, screenshot, and wait steps.
- Direct `ensure_visible` supports optional `tabId`.
- `download_resource` supports page-owned image resources, including `blob:`, `data:`, login-gated `http(s)`, and `urls[]` multi-download.
- `set_humanize` is still reserved and not implemented. Templates must encode pacing explicitly with existing commands.

## Human-like Baseline Reminder

BrowserPilot should act like a careful user, not a bulk scraper. Do not implement captcha bypass, fingerprint spoofing, hidden background scraping, unbounded retries, or high-frequency parallel searches. Use bounded waits, small scroll batches, screenshots for verification, and clear failure reports when a platform asks for login, verification, captcha, or rate-limit handling.
