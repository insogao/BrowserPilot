---
type: DeveloperArchitecture
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# Task Spaces And Foreground Scheduling

BrowserPilot runs in ordinary Chrome, so it cannot claim ego-lite's closed Chromium-level BrowserContext isolation. Its practical contract is:

- One Task Space owns one normal Chrome window and the tabs inside it.
- Spaces in the same Chrome profile share cookies and login state.
- The Native Host injects a stable logical Agent identity into every command.
- The extension command dispatcher, not an Agent prompt, enforces Space ownership and tab membership.
- Visible browser work is globally serialized because ordinary Chrome has one foreground/focus surface.

## Identity

Raw TCP clients send a stable top-level `agentId`. The official client reads `BROWSERPILOT_AGENT_ID` and defaults to `browserpilot-cli`. The Host validates this value, discards any externally supplied internal identity or foreground token, and forwards `_clientId` to the extension.

An `agentId` is a routing identity, not a second authentication secret. The build capability token remains the authentication boundary.

## Lifecycle

- `open_space {name?,url?,state?}` creates and selects an Agent-owned window. Agent windows default to `maximized`; pass `state:"normal"` only when a workflow intentionally tests a narrow responsive layout.
- `list_spaces {}` returns only spaces owned by the caller.
- `use_space {spaceId|name}` selects an existing owned space.
- `handoff_space {spaceId|name?}` changes ownership to `user` and blocks Agent page commands.
- `claim_space {spaceId|name?}` resumes the same Agent-owned space after explicit user permission.
- `complete_space {spaceId|name?,keep?}` either hands the window to the user or closes it and marks the space inactive.

For compatibility, the first scoped command from an Agent with no active space adopts the currently focused unowned window. If another Agent already owns that window, the command fails instead of silently stealing it.

## Enforced Errors

- `SPACE_NOT_FOUND`
- `SPACE_NOT_OWNED`
- `SPACE_USER_IN_CONTROL`
- `SPACE_INACTIVE`
- `TAB_OUTSIDE_SPACE`
- `FOREGROUND_BUSY`

These codes are returned by the extension/native protocol and must be treated as control signals. Agents must not retry around ownership or user-control errors.

## Foreground Lease

Commands that focus, observe, capture, mutate, or close visible browser state acquire one extension-side foreground lease. A complete `run_template` owns the lease and passes its internal token to every nested step. Other Agents receive `FOREGROUND_BUSY`.

Visibility restoration never demotes a maximized window back to normal. A minimized adopted window is restored to normal; smoke-created Task Spaces use a maximized viewport so responsive controls do not move merely because the test window inherited a small size.

The lease renews while the command is alive, releases in `finally` after normal or failed completion, and expires after 90 seconds if the service worker or command crashes. There is no manual unlock operation.

The repository's `browser:lease` file lock remains an additional development/test guard. It prevents independent CLI Agent processes from starting competing smoke tests before commands reach the extension; it is not the product ownership authority.

## Multi-process Future

An optional Agent Pool can later assign one independent `user-data-dir`, Native Host, dynamic port, and extension instance per Agent. That provides stronger process/profile isolation but does not share login state and costs substantially more memory. The default Chrome Web Store experience remains one profile with logical Task Spaces plus serialized foreground work.
