# OMP Desktop roadmap

Current architecture: **Electron main/preload + React renderer + RPC sidecar**.

## Completed

- React transcript, composer, session history, model/thinking controls, login, workspace changes, subagent status, and extension UI.
- Engine isolation through `omp --mode rpc-ui`.
- Secure Electron preload bridge with context isolation and Node integration disabled.
- Electron Builder configuration for Windows and macOS.
- Unit tests for reducer/RPC behavior and Playwright Electron smoke coverage for renderer/preload/real-engine RPC.
- Engine restart action after a sidecar crash, with structured main-process lifecycle logs.

## Next

1. Run packaged installer smoke tests on Windows and both macOS architectures.
2. Configure signed releases and notarization credentials.
3. Add `electron-updater` after the signed release endpoint is available.
4. Refine the Codex-style application shell, task navigation, settings, command palette, and diff review experience.
5. Add crash recovery and structured main-process logging.

The older `roadmap-phase-*.md` files are historical planning records from the former Tauri implementation and are not current architecture documentation.
