# Desktop roadmap

The Electron migration and OMP v17.0.1 sidecar connection are implemented, but full
feature parity is not complete. The current audit is tracked in
`docs/omp-v17-parity-audit.md`: the desktop mirrors all 78 core RPC command types,
implements all 78 in `DesktopRpcClient`, and still has product-level gaps in lifecycle
recovery, queue/session controls, host extensibility, configuration, diagnostics,
and advanced browser/memory/MCP/plugin flows.

Implementation order is P0 correctness/lifecycle → P1 core workflow surfaces → P2
extensibility/configuration → P3 UI depth → P4 packaged release validation. Auto-update
remains intentionally deferred until a signed update endpoint exists.

The 2026-07-17 parity implementation update completed structured cancellation rendering,
Scheduled Tasks wire correctness, and bounded Electron sidecar recovery. See
`docs/parity-implementation-2026-07-17.md` for verification details. Multi-window
isolation and the remaining P1–P4 backlog are still open.
