# @oh-my-pi/desktop

OMP Desktop is an Electron + React + TypeScript application. Electron owns the
native process, secure preload bridge, workspace dialogs, scheduled-task lifecycle,
and the OMP sidecar. The renderer speaks the OMP v17.0.1 `rpc-ui` protocol over
newline-delimited JSON.

## Architecture

```text
React renderer ── contextBridge IPC ── Electron main ── stdin/stdout ── omp --mode rpc-ui
                                      ├─ main engine
                                      ├─ side-chat engine
                                      └─ scheduled-task store
```

- `electron/main.ts` owns child processes, diagnostics, scheduler, and IPC handlers.
- `electron/preload.ts` exposes a narrow `window.desktop` API with context isolation.
- `src/lib/desktop-bridge.ts` adapts the preload API for the renderer.
- `src/lib/rpc-client.ts` correlates requests, responses, events, and engine failures.
- `src/lib/rpc-protocol.ts` mirrors the OMP RPC contract and is checked by the runtime smoke probe.
- `src/lib/reducer.ts` folds OMP session events into the view model.

## Development

```sh
bun install
bun --cwd packages/desktop run electron:dev
```

For a frontend-only Vite session:

```sh
bun --cwd packages/desktop run dev
```

After a manual source or upstream update, desktop commands verify their local
workspace dependencies before running. If a package is missing or an exact
version is stale (for example `happy-dom` after a production-only install), the
guard repairs the hoisted workspace with `bun install --frozen-lockfile`:

```sh
bun --cwd packages/desktop run deps:ensure
```

`build`, `check`, and `test` invoke this guard automatically. Test-only packages
remain development dependencies and are not added to the packaged application.

The development main process runs the source engine through Bun. Set
`OMP_ENGINE_PATH` to use a compiled OMP binary instead.

## Validation and packaging

```sh
bun --cwd packages/desktop run check
bun --cwd packages/desktop run test
bun --cwd packages/desktop run smoke
bun --cwd packages/desktop run sidecar
bun --cwd packages/desktop run electron:build
```

`sidecar` builds the current `packages/coding-agent` source and stages
`resources/omp.exe` (or the platform equivalent). `electron:build` runs that
sidecar step before Electron Builder, then produces installers under `release/`
on Windows. Auto-update is intentionally disabled
until a signed update endpoint is configured.
