# OMP Desktop architecture

OMP Desktop is an Electron application with a React renderer and the existing OMP coding-agent engine running as a separate process.

## Process model

```text
React renderer
  -> window.desktop (contextBridge)
  -> Electron preload
  -> ipcRenderer / ipcMain
  -> Electron main process
  -> omp --mode rpc-ui (NDJSON over stdio)
```

The renderer never receives Node.js or Electron primitives. `contextIsolation` is enabled and `nodeIntegration` is disabled. The preload exposes only workspace selection, external URL/file reveal operations, and the typed engine transport.

The first stdout frame is a capability handshake:

```json
{"type":"ready","protocolVersion":1,"capabilities":["prompt","get_state"]}
```

`DesktopRpcClient.readyInfo` stores this negotiated data. Older cores that only emit `{ "type": "ready" }` are treated as protocol version 1 with an empty capability list; new UI features should check the list before exposing a command.

## Source layout

- `electron/main.ts`: window lifecycle, native dialogs/shell operations, and engine process ownership.
- `electron/preload.ts`: narrow context bridge exposed as `window.desktop`.
- `src/lib/desktop-bridge.ts`: renderer-side wrapper around the preload API.
- `src/lib/rpc-client.ts`: request correlation, timeout/error mapping, and frame classification.
- `src/lib/rpc-protocol.ts`: DOM-safe copy of the RPC contract.
- `src/app.tsx`: product state and engine lifecycle.
- `src/components/`: React presentation and interactions.

## Engine lifecycle

Development launches the engine from `packages/coding-agent/src/cli.ts` with Bun. Packaged builds load `omp` or `omp.exe` from Electron's resources directory. `OMP_ENGINE_PATH` can override the engine binary, and `BUN_BINARY` can override Bun during development.

The main process attaches stdout/stderr listeners before returning from `engine:start`. Stdout is decoded as NDJSON and forwarded to the renderer as `rpc:frame`; stderr and exit state use separate channels.

If the child exits, the renderer surfaces a Restart engine action. Restart reuses the existing RPC client, reattaches listeners, waits for a new `ready` frame, and refreshes models, session state, providers, history, and the workspace diff.

## Security boundary

- Remote content is never loaded into the application window.
- Renderer code cannot call `require`, access `process`, or spawn commands.
- External URLs are opened by the main process.
- Engine commands remain constrained by the coding-agent approval and sandbox policies.
- Main-process lifecycle events are written as JSON lines to Electron's `omp-electron.log` file under the app logs directory.
- New native capabilities must be added explicitly to preload and mirrored in `env-electron.d.ts`.
