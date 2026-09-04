# BrowserPilot Template Author Guide

This directory is the only writable area for website-adaptation agents.

Normal Chrome Web Store users do not have this source tree. They do not run npm, do not rebuild the extension, and do not edit the installed extension directory. Runtime templates are installed by the extension into `chrome.storage.local` through the template board, `install_template`, or a remote Registry entry.

## Roles

- End user: installs the BrowserPilot extension, then installs templates from the template board or a template URL. No build step.
- Adaptation agent: creates or updates one template package under `registry/templates/<template-id>/`. No plugin source edits.
- Maintainer or CI: publishes template packages and generates `registry/catalog.json` plus `registry/details/*.md`.

## Writable Scope

Allowed:

- `registry/templates/<template-id>/template.json`
- `registry/templates/<template-id>/README.md`
- `registry/templates/<template-id>/CHANGELOG.md`
- `registry/templates/<template-id>/examples/*.json`
- `registry/templates/<template-id>/tests/*.json`

Do not edit:

- `src/`
- `native-host/`
- `manifest.json`
- root `README.md`
- root `templates/`
- `registry/catalog.json`
- `registry/details/`

`registry/catalog.json` and `registry/details/*.md` are generated files. Do not hand-edit them in an adaptation task.

## Delivery Rule

A website adaptation must be a runtime-installable template package. It must not require users to rebuild the extension.

Only request plugin-core changes when the current command set cannot express the workflow at all.

Do not mark an adaptation as complete merely because files were created. A delivery has three different states:

- Package complete: all required files exist and `template.json` is valid.
- Static verified: Registry/schema checks pass after maintainer-generated catalog/details are refreshed.
- Runtime verified: the template was installed with `install_template` and exercised with `run_template` against the real browser/site/profile.

Adapter agents may say "package created" only after writing the files. They may say "ready for review" only after a local JSON/schema check or a clear note that static verification is pending. They may say "runtime smoke passed" only after a real BrowserPilot run returns expected output.

If BrowserPilot host is unavailable, login is missing, captcha/rate-limit appears, or the target site blocks the flow, stop and report the exact blocker. Do not call the template "done" or "passed" in that state.

Every adapter handoff must include:

- Files changed.
- Commands run.
- Runtime smoke status: `passed`, `failed`, or `blocked`.
- If blocked/failed: exact command, error/failback summary, and next required action.

## BrowserPilot Debugging Workflow

Do not guess selectors from memory. Use BrowserPilot against the real page.

Do not hard-code the TCP port or capability token in this file or in a template package. The native host port can change after extension reloads. Use the official client from this repository; it scans ports and reads the current build token automatically:

```bash
npm run client -- ping '{}' --no-launch
npm run client -- export_guide '{}' --no-launch
npm run client -- list_tabs '{}' --no-launch
```

Use `export_guide` only when you need the current dynamic connection guide. For ordinary template work, prefer the client commands below.

Suggested loop:

1. Open or locate the target page:

```bash
npm run browser:lease -- client <agent-name> <template-id> open_space '{"name":"<template-id>-inspection","url":"https://www.example.com","state":"maximized"}'
npm run browser:lease -- client <agent-name> <template-id> list_tabs '{}'
```

2. Observe structure cheaply first:

```bash
npm run browser:lease -- client <agent-name> <template-id> snapshot '{"level":"L0","tabId":123}'
```

3. Use screenshots when layout, overlays, disabled buttons, captcha, result cards, or media state matter:

```bash
npm run browser:lease -- client <agent-name> <template-id> screenshot '{"tabId":123,"format":"jpeg"}'
```

On responsive sites, a visible search control may initially be a clickable launcher rather than an `input`. Compare the screenshot with the L0 click targets, click/expand the launcher if needed, and only then probe `input`, `textarea`, `[contenteditable=true]`, `[role=searchbox]`, and `[role=combobox]`. An input-only DOM query is not evidence that search is absent.

4. Probe selectors with `js` before putting them into `template.json`:

```bash
npm run browser:lease -- client <agent-name> <template-id> js '{"tabId":123,"expression":"[...document.querySelectorAll(\"input,textarea,[contenteditable=true]\")].map((el)=>({tag:el.tagName,id:el.id,name:el.getAttribute(\"name\"),text:(el.innerText||el.value||\"\").slice(0,80),visible:!!el.offsetParent}))"}'
```

5. Install the candidate template at runtime and test it. Do not rebuild the extension. Run this when the core maintainer assigns this adapter the browser test turn:

```bash
npm run smoke:template -- example-search
```

`smoke:template` acquires the repository-wide browser test lease, creates one temporary Task Space window, runs all requested templates serially, closes that window, and releases the lease immediately when it exits. It uses `--no-launch`. If the process crashes, the lease expires automatically after ten minutes and the plugin-side foreground lease expires after 90 seconds. There is no manual unlock step, and agents must never create or edit lease files themselves.

The runner is serial and forces `--no-launch`.

For manual page inspection, every command that opens, focuses, reads, captures, or changes a page must run through the lease wrapper:

```bash
npm run browser:lease -- client <agent-name> <template-id> open_tab '{"url":"https://www.example.com"}'
npm run browser:lease -- client <agent-name> <template-id> screenshot '{"tabId":123,"format":"jpeg"}'
npm run browser:lease -- client <agent-name> <template-id> complete_space '{"keep":false}'
```

Manual inspection must begin with `open_space` and end with `complete_space`. Reuse the exact same `<agent-name>` for every command so Host-side ownership stays stable. If the user explicitly takes over that Space, do not close it; report the handoff instead.

The wrapper grants one command exclusive browser access. For a complete multi-command smoke flow, use `smoke:template` so the same lease covers install, execution, and verification.

6. If a template fails, read the structured failback. It usually includes the failed step and an L0 `snapshot_content`; update only the template package.

7. Record runtime smoke status in the template README or handoff summary. A smoke test is not optional for "complete"; if it cannot run, the delivery is blocked/pending, not complete.

Only one adapter agent may perform real-browser work at a time. Adapter agents may and should inspect the real target page and run runtime smoke when the core maintainer assigns them the browser test turn. They must use `smoke:template` or the browser lease wrapper, and must use `--no-launch`. If another lease is active, report `runtime smoke: blocked (browser lease active)` and wait for a later assignment; never bypass the lease. If BrowserPilot host is unavailable, report runtime smoke as blocked and ask the core maintainer/user to start or repair the BrowserPilot profile.

Batch smoke performed by a separate reviewer is only triage. If a site fails, the adapter responsible for that site must receive its own exclusive browser turn and directly inspect the live DOM, snapshots, and screenshots before changing selectors. Do not implement a site fix solely from another agent's prose summary.

Adapter agents must never open `chrome-extension://.../onboarding/index.html` or any other extension UI page as part of smoke testing. Extension pages are user-facing control surfaces, not test targets.

For image or file workflows, do not trust internal return fields alone. Use `download_resource` for page-owned blob or login-gated resources, then verify the downloaded bytes and the real page screenshot.

## Human-like Operation Baseline

BrowserPilot templates should behave like a careful human using one browser, not like a bulk scraper.

This is a reliability and account-safety baseline. Do not implement stealth, captcha bypass, fingerprint spoofing, hidden background scraping, or traffic patterns intended to evade a platform's anti-abuse systems.

Required principles:

- Prefer trusted browser actions: `click`, `fill`, `type`, `press`, `wheel`, `hover`, `waitForSelector`, and `waitForURL`.
- Keep each workflow small and bounded. A template should complete one user-requested task, not fan out into unbounded pages or searches.
- Add explicit waits for real page states, not blind high-speed loops.
- Use moderate typing and action intervals when a site is sensitive. `type` supports `typingDelayMs`; `waitForTimeout` may be used sparingly between major user-like steps.
- For virtual lists and social feeds, use small scroll batches with waits, then verify with `screenshot` or `snapshot`.
- Stop and report when the page shows login walls, captcha, rate-limit messages, unusual verification, or permission prompts.
- Do not retry indefinitely. Use bounded `retry` and explain failure conditions in the template README.
- Do not open many tabs or issue many searches in parallel from one template.

Current framework note: `set_humanize` is reserved but not implemented. Template authors must encode pacing explicitly with existing commands until plugin-core provides a global humanization policy.

## Package Shape

Use this structure:

```text
registry/templates/<template-id>/
  template.json
  README.md
  CHANGELOG.md
  examples/basic.json
  tests/smoke.json
```

`template.json` is the single source of truth.

## Search Adaptation Pattern

First inspect the real page and identify:

- Search input selectors.
- Result container selectors.
- Result link selector.
- URL pattern after submitting the search.
- Returned fields and known limitations.

Then convert the findings into a commands template:

- `open_tab` opens the search page.
- `ensure_visible` is optional because `run_template` already restores and focuses the target tab before observation, JS, screenshots, and wait steps. Add it explicitly only when the workflow needs a visible checkpoint.
- `js` with `expression:"@focus"` declares `selectors:[...]`.
- `fill` targets `selector:"[data-bp-focus]"`.
- `press` submits with `key:"Enter"` and `selector:"[data-bp-focus]"`, so the input is re-focused immediately before the key event.
- Prefer `waitForSelector` on a real result container. Use `waitForURL` only when navigation identity is itself part of the contract; regional domains and SPA routes make URL-only success checks brittle.
- `js` with `expression:"@results"` declares `rootSelectors:[...]` plus optional `linkSelector`, `minResults`, `limit`, and `textLimit`.

Do not add a new branch to `src/background/templates.ts` for ordinary search engines.

For pages with virtual lists or lazy-loaded cards, such as X/Twitter, include deliberate scroll/wait logic in the template and verify with `screenshot`. BrowserPilot can restore a minimized window to `normal`, but it cannot force a site to render content that the site itself only loads after scroll or viewport exposure.

## AI Chat Adaptation Pattern

For Gemini, ChatGPT, or a similar AI chat site, inspect:

- Editor type: textarea, contenteditable, Quill, ProseMirror, or custom.
- Send button selector and disabled state.
- User message container.
- Assistant response container.
- Conversation URL identity for follow-up safety.
- Image/media DOM shape if downloads matter.

If the existing `@write`, `@chatCollect`, and `@verifyConv` placeholders support the site, create a commands template with those placeholders. If the site requires a genuinely new editor or collection primitive, document the missing primitive in the template README and stop; that is a plugin-core request, not a template-only adaptation.

## Examples And Tests

`examples/*.json` and `tests/*.json` should be directly executable payloads:

```json
{
  "command": "run_template",
  "args": {
    "id": "example-search",
    "params": {
      "query": "BrowserPilot"
    }
  },
  "expect": {
    "minResults": 1,
    "requiredResultFields": ["title", "url"],
    "resultUrlIncludes": "/expected/result/route"
  }
}
```

`requiredResultFields` checks non-empty fields on the first result. `resultUrlIncludes`
proves the returned result came from the expected route. Use these assertions whenever
a template promises structured result fields; a count-only smoke is not sufficient.

Do not provide only a `params` fragment unless a test runner explicitly documents that format.

## Duplicate Check

Before creating a new package, compare against existing templates by intent, site, inputs, outputs, and capabilities. If it overlaps with an existing template, either update that template or declare `alternatives` / `replaces` in `discovery`.
