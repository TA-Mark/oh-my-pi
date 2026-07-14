# Core touch-points

Changes the desktop app makes **outside** `packages/desktop/`. Keep this list short —
each entry is a merge-conflict risk during upstream sync (`upstream-sync.md`). Re-check
these after every sync.

## `packages/coding-agent/src/modes/rpc/` — `logout` RPC command

The RPC layer shipped `get_login_providers` + `login` but no `logout` (the TUI `/logout`
is a selector-based command with no text-mode handle, so it can't be driven headlessly).
The desktop Accounts UI needs sign-out, so we added a small, additive command:

- `rpc-types.ts`: `RpcCommand` gains `{ type: "logout"; providerId: string }`; `RpcResponse`
  gains the matching `command: "logout"` success variant.
- `rpc-mode.ts`: a `case "logout"` in `handleCommand` calls
  `authStorage.logout(providerId)` (the public AuthStorage sign-out method), then
  `modelRegistry.refresh()`.

Additive only (new union arm + new case); no existing behavior changed. If upstream adds
its own logout command, drop this in favor of theirs during the next sync. Verified by the
runtime probe in `scripts/smoke-rpc.ts` (logout step).

## `packages/coding-agent/src/modes/rpc/` — `list_sessions` RPC command

The RPC layer shipped `switch_session` (takes a `sessionPath`) but had no way to *enumerate*
sessions, so the desktop couldn't build a history/switch UI. `SessionManager.list(cwd)`
already exists (used by ACP/TUI); we exposed it over RPC:

- `rpc-types.ts`: `RpcCommand` gains `{ type: "list_sessions" }`; new `RpcSessionSummary`
  interface (path/id/title/messageCount/created/modified/active); `RpcResponse` gains the
  matching `command: "list_sessions"` success variant `{ sessions: RpcSessionSummary[] }`.
- `rpc-mode.ts`: a `case "list_sessions"` calls `SessionManager.list(session.sessionManager.getCwd())`
  and flags the entry whose `path === session.sessionFile` as `active`.

Additive only (new union arm + new case + one interface). No existing behavior changed. The
desktop pairs this with the pre-existing `switch_session` + `get_messages` to switch sessions
and re-seed the transcript. If upstream adds its own list command, drop this during sync.
Verified by the runtime probe in `scripts/smoke-rpc.ts` (list_sessions step).

## `packages/coding-agent/src/modes/rpc/` — `set_plan_mode` RPC command

The engine already had every plan-mode primitive (`AgentSession.getPlanModeState()` /
`setPlanModeState()` / `setStandingResolveHandler()` / `setPlanReferencePath()`), and the
ACP mode (`acp-agent.ts`) uses them headlessly. But the RPC layer never surfaced plan mode,
so the desktop couldn't toggle it. We mirrored the ACP wiring:

- `rpc-types.ts`: `RpcCommand` gains
  `{ type: "set_plan_mode"; enabled: boolean; workflow?: "parallel" | "iterative" }`;
  new `RpcPlanModeState` interface (enabled/planFilePath/workflow); `RpcResponse` gains the
  matching `command: "set_plan_mode"` success variant; `RpcSessionState` gains an optional
  `planMode`; and a new `RpcPlanModeChangedFrame` (`type: "plan_mode_changed"`) event.
- `rpc-mode.ts`: a `case "set_plan_mode"` (gated on the `plan.enabled` setting) toggles
  `session.setPlanModeState(...)` and installs a **standing resolve handler** that routes the
  agent's finalized plan through `rpcUiContext.confirm()` — the same host-dialog path the
  desktop already handles via `extension_ui_request`. `get_state` now reports `planMode`, and
  every toggle emits `plan_mode_changed`.

Approval is **agent-driven** (the agent submits the plan via `resolve { action: "apply" }`,
which the standing handler surfaces as a confirm dialog), so **no separate client-side
`resolve_plan` command is needed** — this deliberately reuses the existing confirm path
rather than inventing a new UI surface. Additive only (new union arms + one case + one
interface + one event frame). No existing behavior changed. If upstream adds its own plan-mode
RPC, drop this during sync. Verified by the runtime probe in `scripts/smoke-rpc.ts`
(set_plan_mode enable/disable + get_state steps).
