# Parity implementation update — 2026-07-17

This update closes the P0 correctness gaps found during the OMP v17.0.1 audit and adds the first P1 workflow controls.

It also closes the `DesktopRpcClient` method gap: all 83 core command types now have a typed client wrapper, including command discovery, queue/compaction/retry controls, subagent messages, goal lifecycle, session branch/export/handoff, and host registration surfaces.

## Host-tool and host-URI bridge

The Electron RPC client now mirrors OMP's bidirectional host frames: host tool
call/cancel/update/result and host URI request/cancel/result. Registered host
handlers can stream partial results, complete calls, and observe cancellation.
When no handler is registered, the client returns a structured error result so
the OMP engine cannot remain blocked on an unanswered request. The bridge is
transport-agnostic and therefore works for both the main and side session
clients.

## Extension UI parity

Desktop now mirrors the OAuth `launchUrl` field, copies the safe loopback URL
while opening the full URL, returns `timedOut: true` for dialog deadlines, and
surfaces core `extension_error` frames as user toasts and diagnostics entries.

## Cancellation semantics

The agent core now emits structured synthetic details for tool execution that is interrupted or skipped. The shared tool renderer and Electron reducer use those details to show a neutral cancelled/skipped state, while genuine tool failures remain errors.

## Scheduled Tasks wire correctness

The Electron scheduler now consumes OMP's real top-level `agent_end` frame. It inspects the final assistant message and records `stopReason: "error"` or `"aborted"` as failed runs with the provider error. Scheduler timestamps are ISO strings in both the store and desktop RPC contract. Regression tests cover success and failure frames.

## Engine lifecycle recovery

`DesktopRpcClient` can be started again after an unexpected sidecar exit. The main React app rejects in-flight requests as transport failures, clears the interrupted turn, and retries startup with bounded exponential backoff (three attempts). Intentional shutdown still removes listeners and does not restart.

## Window and diagnostics isolation

The Electron main process now owns a main and side engine per renderer window. IPC commands, frames, stderr, exit signals, ready frames, and diagnostics protocol versions are routed by `webContents.id`; closing one window does not stop another window's session. Settings opens a redacted Diagnostics panel and can export a JSON bundle under the Electron user-data directory.

## Queue and session controls

The composer now exposes steer/follow-up queue selection, queue count, steering/follow-up policy modes, interrupt mode, auto-compaction, auto-retry, manual compact, and abort-retry actions. These controls call the corresponding OMP RPC commands and refresh the authoritative session state.

## Host registry and approval

Tools settings now persist a validated desktop host registry. Four safe actions
are available (open external URL, reveal path, copy text, and bounded workspace
file read), each defaulting to an explicit one-shot approval dialog. Tool
cancellation aborts pending approvals/execution, while `workspace://` is
read-only and delegates containment, binary and size guards to the core file
RPC. Registry parsing rejects malformed or unknown actions.

## Subagent transcript drill-down

The subagent status list now opens the selected agent's persisted transcript
through `get_subagent_messages`. The client preserves the core's `fromByte`,
`nextByte`, and `reset` fields so a later live incremental refresh can continue
without re-reading the complete session file. The first UI pass shows the
authoritative message snapshot and keeps transport failures visible as desktop
errors instead of silently dropping the selection.

## Session actions and goal lifecycle

The session header now exposes Branch, Export HTML, and Handoff actions backed
by the canonical RPC commands. Branching selects a real user-message entry ID
and re-seeds the transcript after the core changes the session leaf; handoff
also re-seeds the fresh session and reveals the generated artifact.

Goal mode is no longer represented only by event text. The core RPC surface now
provides goal snapshot/create/pause/resume/drop operations backed directly by
`GoalRuntime`. It synchronizes the hidden `goal` tool with mode transitions,
rejects mode mutation while streaming, and enforces Plan/Goal mutual exclusion.
Electron displays the authoritative goal status and exposes matching controls.

## Authoritative context usage

Context Inspector now distinguishes staged attachment estimates from the core's
authoritative model-window usage. It shows tokens/window/percent, prioritizes
70% and 90% core pressure warnings over local estimates, and refreshes after
compaction events so the warning tracks the post-compaction session state.

## Built-in tool transcript coverage

The shared `ToolView` registry now has schema-aware renderers for checkpoint,
rewind, memory editing, learning, and managed-skill operations. Their cards
surface lifecycle state and domain fields instead of raw generic JSON, while
unknown extension tools retain the safe generic fallback.

## Workspace filesystem watcher

Each Electron window now owns a workspace watcher that is replaced on workspace
switch and closed with the window. Events are debounced into bounded batches,
ignore `.git` and `node_modules` churn, and refresh Files, Git status/diff, plus
the currently open preview when its path changes. Platforms without recursive
watch support fall back to root-level watching instead of failing startup.

## Incremental subagent transcript

Selected subagent transcripts now advance from the core `nextByte` cursor on
progress/lifecycle events. Deltas append without re-reading the session file,
duplicate cursors are ignored, and a core truncation reset atomically replaces
stale accumulated rows.

## Subagent artifact preview

The subagent drill-down now renders structured message cards instead of raw
transcript JSON and detects unique `artifact://<id>` references in text and tool
details. The new additive core `read_artifact` RPC resolves numeric IDs through
the active session manager, caps output at 1 MiB, preserves size/truncation
metadata, supports in-memory artifacts, and never exposes the backing path.

## Authoritative context breakdown

`get_state` now includes the core `AgentSession.getContextBreakdown()` result.
Electron renders provider-anchored versus estimated state and the exact token
categories for system prompt, tools, system context, skills, and messages; the
sidecar smoke verifies this response shape.

## Browser policy and activity

`browser_list_tabs` now returns the core download policy alongside tabs. The
policy is `deny`, matching the CDP behavior applied before managed navigation,
and Electron displays that authoritative value. Desktop navigation, history,
reload, and snapshot operations now join browser tool events in one activity
timeline with running, success, and error outcomes.

## Side Chat session lineage

Side Chat forks now create a fresh OMP session whose header points at the main
task's persisted `sessionFile` through the canonical `new_session.parentSession`
contract. A bounded recent transcript still seeds the fork's immediate prompt,
while an extension veto stops the prompt instead of accidentally continuing in
the old side session. The main New Task action likewise restores its previous
transcript when an extension cancels session creation.

## Plugin feature lifecycle

Settings now exposes each plugin manifest feature as a real runtime control.
The additive `set_plugin_features` RPC validates feature names through
`PluginManager.setEnabledFeatures()`, persists the selection, and reloads plugin,
skill, capability, and slash-command discovery before returning the updated
descriptor.

## MCP OAuth lifecycle and diagnostics

MCP Settings now distinguishes a configured credential pointer from a credential
that is actually available in the active profile. Core connection and reconnect
failures are retained per server, redacted for bearer tokens, secret-like
assignments and sensitive query parameters, then surfaced as `lastError`.

The additive `reauth_mcp` command runs OMP's `MCPOAuthFlow` headlessly, routes
authorization through the existing Desktop `open_url` and manual-code dialogs,
persists refresh material under the profile-scoped credential ID, and reconnects
the live tool registry. `unauth_mcp` removes only OMP-managed credentials,
updates an explicit OAuth config when present, disconnects stale tools, and is
guarded by a Desktop confirmation.

Scheduled Tasks now wait for the child process `close` event after `agent_end`
before resolving a run. This closes stdio/file handles deterministically and
prevents Windows `EBUSY` failures during cleanup or rapid subsequent runs.

## Marketplace and memory lifecycle

Settings/Plugins now reads the canonical `MarketplaceManager` inventory and
shows safe marketplace metadata without exposing cache or source filesystem
paths. Install, update, uninstall, and enabled state are scoped explicitly to
the user or active project, then plugin discovery is reloaded before the
updated snapshot reaches the renderer.

Settings/Memory now exposes backend capabilities, structured search previews,
durable save, consolidation, and confirmed clear operations. Hindsight gained
a real API health probe plus bank/tag-scoped search and save behavior; local
and Mnemopi continue through the same backend abstraction. Per-record mutation
is not presented as universal because Hindsight and local memory do not share
Mnemopi's editable-record semantics.

The former source-regex protocol drift test was replaced by a compile-time
parity contract covering all 95 command discriminants and core success-response
arms. The runtime smoke now additionally validates marketplace inventory and
memory health response shapes.

## Verification

- `packages/agent`: check pass; targeted agent-loop tests pass.
- `packages/collab-web`: check pass; 67 tests pass, including all five new built-in renderer contracts.
- `packages/desktop`: check pass; 66 tests pass, including scheduler process reaping, RPC lifecycle, session/goal/plugin/marketplace/MCP/memory wrappers, Side Chat lineage, context/browser policy, host bridge, host registry, extension UI, and incremental subagent/artifact contracts.
- Electron production renderer build: pass.
- Windows `win-unpacked` validation: pass; packaged DOM, preload, diagnostics IPC, bundled `omp/17.0.1`, and Electron-to-sidecar `get_state` all verified.
- Windows installers: NSIS and MSI builds pass; MSI administrative extraction and extracted-runtime validation pass. Artifacts remain intentionally unsigned.
- `git diff --check`: pass.

The remaining parity backlog is tracked in `omp-v17-parity-audit.md`; arbitrary
third-party host handler SDK, Side Chat context inspection, renderer E2E,
release gating, and packaged validation remain before installer work. Plugin,
MCP, Skills, Memory, and Browser administration now have usable core-backed
Electron surfaces rather than mockups.
