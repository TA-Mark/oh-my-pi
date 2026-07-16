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
*does* overwrite the working tree) was deliberately left out of scope; the Revert buttons
stay disabled. Additive only (two union arms + one interface + one case each). No existing
behavior changed. If upstream adds its own staging RPC, drop this during sync. Verified by
the runtime probe in `scripts/smoke-rpc.ts` (stage_hunks + unstage steps).

## Git Review status, revert, and commit RPCs

The desktop Git Review panel now uses additive `get_git_status`, `revert_files`, and `commit`
commands. Revert is confirmation-gated and accepts tracked files only, restoring from `HEAD`;
commit requires a non-empty message and staged changes. Additive `push`, `create_pull_request`,
`list_worktrees`, `create_worktree`, and `remove_worktree` commands complete the next slice. Push
never force-pushes and rejects detached HEAD; PR creation uses authenticated `gh`; worktree removal
rejects the active workspace and unregistered paths. The runtime smoke probe validates all safe,
non-network guard paths without publishing or deleting user data.

The desktop Worktree Manager consumes these commands to list registered worktrees, switch the
live engine with `set_workspace`, attempt non-force removal first, and expose force removal as a
separate confirmation-gated action. The active workspace can never be removed.

## Workspace Files RPCs

The Files panel uses additive `list_workspace_files` and `read_workspace_file` commands. The
engine caps directory walks at 5,000 entries, skips symlinks and heavy generated directories,
and returns relative DOM-safe metadata. Reads resolve both the workspace and target through
`realpath`, reject lexical and symlink escapes, reject binary/non-UTF-8 content, and cap previews
at 1 MiB. The desktop polls the bounded listing while Files is open, refreshes the selected
preview, supports search/reveal, and injects either an `@file` mention or a bounded text selection
into the composer. The smoke probe verifies listing, bounded text reads, and traversal rejection.

## Browser integration RPCs

The Browser panel is backed by the existing OMP `BrowserTool` and tab supervisor through additive
`browser_open`, `browser_close`, `browser_snapshot`, `browser_navigate`, and `browser_history`
commands. URLs are restricted to HTTP(S) without embedded credentials. Snapshots are capped at
128 KiB before reaching the desktop and can be staged into Context Inspector as text. External
open continues to use the host URL policy; non-HTTP schemes are not silently permitted.

## Side Chat isolation

Side Chat runs through a second Electron engine process and a separate `DesktopRpcTransport`;
its transcript and session state never reuse the main client. Staged Files/Context Inspector
items can be forked into the side session, and the latest assistant response can be staged back
into the main context. An optional Git worktree can be created for the side engine; cleanup is
non-force by default and retains dirty worktrees for explicit review in Worktree Manager.

## Scheduled Tasks

Scheduled Tasks are persisted by the Electron main process under the app user-data directory and
exposed through a dedicated IPC CRUD surface. The background scheduler checks every 15 seconds,
validates that the workspace still exists, prevents duplicate execution per task, and runs each
prompt in a short-lived RPC engine with a five-minute timeout. Each task keeps its last 20 run
diagnostics; removal is rejected while a task is running.
Tasks support bounded retry with exponential backoff (maximum five retries), and the UI exposes a
confirmation-gated Run now action that uses the same lock, timeout, diagnostics, and retry path.
Persistence uses a temporary file plus atomic rename. Only one Electron instance owns the
scheduler, resume from system sleep immediately checks overdue tasks, and shutdown terminates
active task engines. Contract tests cover migration, restart persistence, duplicate locking,
retry backoff, missing workspaces, and overdue-task recovery; Electron E2E verifies persistence
through a real application restart.

## Wire-level parity additions

MCP lifecycle commands are available through the RPC boundary: `get_mcp_status`,
`reconnect_mcp`, and `set_mcp_enabled`. Responses contain only server state, transport,
tool count, and redacted OAuth booleans. Enable/disable persists through the OMP-owned
config writer and updates reconnect state without exposing credentials, headers, tokens,
or command arguments.

The desktop RPC client now accepts OMP's optional `streamingBehavior` on prompt commands, forwards
`host_tool_update` partial results, and classifies `prompt_result` frames. These frames are kept
separate from the normal response/event channels so request correlation and transcript ordering
remain unchanged.

The sidebar Plugins entry now opens the live Settings Plugins category instead of presenting a
separate placeholder. Full install/update/uninstall still requires explicit lifecycle commands;
the current RPC settings surface intentionally only exposes installed-plugin descriptors and
enable/disable mutations.

Context Inspector now receives canonical skill discovery details (description, source, file path,
hidden flag) and skill-loading warnings through `get_context_snapshot`. This improves discovery
parity without exposing memory contents or credentials; structured memory search and MCP server
lifecycle still require dedicated RPC commands.
