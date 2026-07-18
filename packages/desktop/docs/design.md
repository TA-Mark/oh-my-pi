# Desktop design

The desktop is a thin Electron host around the OMP coding-agent RPC engine.
React owns presentation and state reduction; Electron owns native capabilities and
process lifecycle; OMP remains the source of truth for agent behavior.

## Runtime flow

1. Electron creates a BrowserWindow with `contextIsolation` and a preload script.
2. The renderer asks the preload bridge to start OMP in `rpc-ui` mode.
3. Electron writes JSON commands to the engine stdin and forwards stdout frames to
   the renderer as IPC events.
4. The renderer's `DesktopRpcClient` correlates response IDs and reduces session events.

The main engine, Side Chat engine, and scheduled tasks are independent lifecycle
domains. A renderer crash does not grant it direct process access, and an engine exit
rejects all pending RPC requests with a classified transport error.

## Core parity

The renderer protocol mirrors OMP v17.0.1 commands for prompting, steering, follow-up,
settings, plugins, MCP, memory, skills, browser activity, files/context, Git review,
worktrees, terminal, session history, and lifecycle events. `scripts/smoke-rpc.ts`
exercises the contract against both source OMP and the staged sidecar.
