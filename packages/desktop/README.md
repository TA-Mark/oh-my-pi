# @oh-my-pi/desktop

Desktop GUI for OMP. A thin **Tauri v2** shell (Rust + OS WebView) that runs the
`omp` engine as an **RPC sidecar** (`omp --mode rpc-ui`) and talks to it over
newline-delimited JSON via stdio. Frontend is **React + Vite**.

> Design & rationale: [`docs/design.md`](docs/design.md).
> Keeping the fork in sync with upstream OMP: [`docs/upstream-sync.md`](docs/upstream-sync.md).

## Status

Phase 2: everything from Phase 1 (workspace picker, streamed markdown chat, tool
lifecycle chips, abort) **plus** a model picker (filterable, `get_available_models`
/ `set_model`), a thinking-level selector (`set_thinking_level`), and session
controls — new session (`new_session`), inline rename (`set_session_name`), and
live session metadata (model / thinking / name / message count via `get_state`).

Protocol drift is guarded at runtime by `scripts/smoke-rpc.ts`
(`bun packages/desktop/scripts/smoke-rpc.ts`), which now also exercises the
`set_thinking_level` → `get_state` round-trip.

Phase 3 adds **rich tool cards** (the collab-web `ToolView` renderers are reused
directly — 40+ tools, fed straight from `tool_execution_*` events) and a **subagent
panel** (`set_subagent_subscription` + `get_subagents`).

Phase 4 adds **interactive UI**: `extension_ui_request` dialogs (select / confirm /
input / editor — this is also how tool-approval prompts surface), `notify` toasts,
`open_url` (system browser via the opener plugin), `set_editor_text` → composer, and
**OAuth login** (`get_login_providers` + `login`). `scripts/smoke-rpc.ts` probes the
subagent and login-provider contracts.

Phase 5 adds **packaging**: the `omp` engine is built and bundled as a Tauri
**sidecar** (`scripts/build-sidecar.ts` → `src-tauri/binaries/omp-<triple>`), resolved
next to the app binary at runtime. `bun --cwd=packages/desktop run bundle` produces the
installer. Verified on Windows (MSI + NSIS, sidecar embedded); macOS DMG + signing/notary
and a multi-platform release workflow are wired in CI. See [`docs/packaging.md`](docs/packaging.md).

Session history/switch is implemented via a left **History drawer**: an additive
`list_sessions` RPC command (paired with the pre-existing `switch_session` + `get_messages`)
lists the workspace's sessions, and picking one switches the engine and re-seeds the
transcript from its persisted messages (see `docs/core-touchpoints.md`).

All five roadmap phases are implemented. Remaining optional work: auto-update, macOS
build/signing verification on a mac host, and the currently-ignored
`setStatus`/`setWidget`/`setTitle` extension-UI methods.

## Architecture (short)

```
React (WebView) ──invoke("send_rpc")──►  Rust bridge  ──stdin──►  omp --mode rpc-ui
             ◄──event("rpc://frame")───  (rpc.rs)     ◄─stdout──  (engine)
```

- `src/lib/tauri-bridge.ts` — Tauri IPC wrapper.
- `src/lib/rpc-client.ts` — request/response correlation + event routing.
- `src/lib/rpc-protocol.ts` — standalone protocol types (drift guarded at runtime via `scripts/smoke-rpc.ts`).
- `src/lib/reducer.ts` — folds engine events into the view model.
- `src-tauri/src/rpc.rs` — owns the engine process, bridges stdio to WebView events.

## Develop

Run the engine from source (no bundled binary needed) by pointing the bridge at
the repo CLI via `OMP_ENGINE_ARGV` (JSON argv):

```sh
# from repo root
export OMP_ENGINE_ARGV='["bun","'"$PWD"'/packages/coding-agent/src/cli.ts","--mode","rpc-ui"]'
bun --cwd packages/desktop run tauri:dev
```

On Windows (PowerShell):

```powershell
$env:OMP_ENGINE_ARGV = '["bun","' + (Resolve-Path .\packages\coding-agent\src\cli.ts) + '","--mode","rpc-ui"]'
bun --cwd packages/desktop run tauri:dev
```

Without `OMP_ENGINE_ARGV`, the bridge launches `omp --mode rpc-ui` from `PATH`
(the production sidecar path).

## Frontend only

```sh
bun --cwd packages/desktop run dev     # Vite dev server on :1420
bun --cwd packages/desktop run build   # static bundle → dist/
bun --cwd packages/desktop run check   # type-check
```
