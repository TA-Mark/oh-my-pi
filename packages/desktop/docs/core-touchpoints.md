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

## `packages/coding-agent/src/modes/rpc/` — Goal lifecycle RPC commands

OMP's goal lifecycle lived in `GoalRuntime` and the hidden `goal` tool, but RPC
hosts could only observe `goal_updated` text. Electron needs authoritative state
and user lifecycle controls, so the RPC layer now exposes additive `get_goal`,
`create_goal`, `pause_goal`, `resume_goal`, and `drop_goal` commands.

The handlers call `GoalRuntime` directly, include `goalMode` in `get_state`, and
reconcile the hidden `goal` tool when the mode becomes active or inactive. They
reject lifecycle mutation during streaming and enforce the same Plan/Goal mutual
exclusion as the interactive mode. The smoke probe executes the complete
create → pause → resume → drop sequence and validates the returned state.

## `packages/coding-agent/src/modes/rpc/` — `stage_hunks` + `unstage` RPC commands

The RPC layer shipped `get_workspace_diff` (read-only) but no way to *act* on the diff, so
the desktop Changes panel's Stage buttons were inert. The engine already had the full staging
API (`git.stage.hunks` / `git.stage.reset` in `utils/git.ts`, used by the git tools); we
exposed two additive commands that drive it:

- `rpc-types.ts`: `RpcCommand` gains `{ type: "stage_hunks"; selections: RpcHunkSelection[] }`
  and `{ type: "unstage"; files?: string[] }`; new `RpcHunkSelection` interface
  (`path` + `hunks: { type: "all" } | { type: "indices"; indices: number[] }`, a DOM-safe
  subset of the engine's `HunkSelection`); `RpcResponse` gains matching success arms
  (`stage_hunks` → `{ staged: number }`, `unstage` → no data).
- `rpc-mode.ts`: a `case "stage_hunks"` calls `git.stage.hunks(cwd, selections)` and a
  `case "unstage"` calls `git.stage.reset(cwd, files ?? [])`.

**Non-destructive by design:** both commands only mutate the git *index*, never the working
tree — a mistaken stage is fully reversible with `unstage` (and vice versa). Revert (which
*does* overwrite the working tree) is exposed separately as `revert_files`, and the Desktop
requires explicit confirmation before calling it. Additive only (two union arms + one
interface + one case each). No existing
behavior changed. If upstream adds its own staging RPC, drop this during sync. Verified by
the runtime probe in `scripts/smoke-rpc.ts` (stage_hunks + unstage steps).

## `packages/coding-agent/src/modes/rpc/` — desktop parity surfaces

OMP v17 desktop parity adds additive RPC commands for settings/plugins, workspace file
listing and bounded UTF-8 previews, context snapshot, MCP status/reconnect/toggle, memory
status/search, browser tab/navigation/snapshot, git review actions, and worktree lifecycle.
The implementation validates workspace containment and rejects binary or oversized previews;
Git write/network operations remain explicit commands so the UI can require confirmation.
`rpc-settings.ts` redacts secret settings and only exposes schema-validated values. Runtime
coverage is included in `scripts/smoke-rpc.ts` for settings, files, context, MCP, browser tabs,
git status, and worktrees.

Plugin parity also adds `set_plugin_features`. It delegates validation and
persistence to `PluginManager.setEnabledFeatures()` and then reloads runtime
plugin, skill, capability, and slash-command discovery, matching whole-plugin
enable/disable behavior.

MCP parity adds `reauth_mcp` and `unauth_mcp`. Reauthorization uses the same
endpoint discovery, PKCE/DCR-capable `MCPOAuthFlow`, profile-scoped AuthStorage,
and reconnect path as OMP, while routing browser/manual-code interaction through
RPC extension UI frames. Sign-out removes only managed credentials and refreshes
the live MCP tool registry. Status snapshots expose redacted last errors and
whether the referenced credential is actually available, never the credential.

Marketplace parity adds `get_marketplace`, `install_marketplace_plugin`,
`upgrade_marketplace_plugin`, `uninstall_marketplace_plugin`, and
`set_marketplace_plugin_enabled`. These commands route through the canonical
`MarketplaceManager`, preserve user/project scope, reload runtime discovery
after writes, and omit source URIs and cache paths from renderer snapshots.

Memory parity adds `save_memory`, `enqueue_memory`, and `clear_memory` beside
the existing status/search calls. They route through the active backend rather
than a Desktop-specific store. Hindsight now provides a bank health probe plus
tag-scoped search/save; clear keeps its existing local-cache-only semantics.

## Bounded artifact preview RPC

Subagent and tool transcripts can contain `artifact://<id>` references, but the
RPC surface previously had no safe way for a GUI host to resolve them. The
additive `read_artifact` command delegates lookup to the active
`SessionManager`, accepts numeric IDs only, caps previews at 1 MiB, reports
size/truncation metadata, and never returns the artifact's filesystem path.
This also works for in-memory sessions and for the shared artifact manager used
by subagents. The runtime smoke verifies the structured missing-artifact error.

The Electron main process owns two isolated engine slots (main + Side Chat) with independent
IPC channels and child-process cleanup. Scheduled Tasks are persisted under Electron's app-data
directory and executed by the main-process scheduler with duplicate-run prevention, bounded
retry, missing-workspace skipping, five-minute timeout, and a 20-entry diagnostics history.
