# Desktop roadmap

The Electron migration and OMP v17.0.1 sidecar connection are implemented, but full
feature parity is not complete. The current audit is tracked in
`docs/omp-v17-parity-audit.md`: the desktop mirrors the full core RPC command set,
implements the full command set in `DesktopRpcClient`, and still has product-level gaps in
lifecycle recovery, queue/session controls, host extensibility, configuration, diagnostics,
and advanced browser/memory/MCP/plugin flows.

Implementation order is P0 correctness/lifecycle → P1 core workflow surfaces → P2
extensibility/configuration → P3 UI depth → P4 packaged release validation. Auto-update
remains intentionally deferred until a signed update endpoint exists.

The 2026-07-17 parity implementation update completed structured cancellation rendering,
Scheduled Tasks wire correctness, bounded Electron sidecar recovery, and the later
packaged-release validation now covers renderer/preload/diagnostics, Side Chat context,
The 2026-07-20 update completed guided-goal, vibe workflow parity, and the branch session picker. Remaining P1–P4 backlog is still open.
