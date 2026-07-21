# Packaging & Release

The desktop app is packaged with Electron Builder. The installer carries the
compiled OMP v17.0.1 engine as an extra resource and starts it with
`omp --mode rpc-ui`.

## Build pipeline

| Piece | Command | Output |
| --- | --- | --- |
| Renderer | `bun run build` | `dist/` |
| Electron main/preload | `bun run electron:compile` | `dist-electron/` |
| Engine | `bun run sidecar` (also run by `electron:build`) | `resources/omp[.exe]` |
| Installer | `bun run electron:build` | stages sidecar, writes `release/` |
| Packaged validation | `bun run release:validate` | launch/DOM/preload/sidecar RPC result |

The sidecar is built from the checked-out `packages/coding-agent` source.
`electron:build` runs `sidecar` immediately before Electron Builder, so a direct
package build cannot silently reuse a stale staged OMP binary. `OMP_ENGINE_PATH`
may be used during development to point at a specific engine.

## Local build

```sh
bun install
bun --cwd=packages/desktop run bundle
```

On Windows this produces:

- `release/OMP Desktop Setup 0.1.0.exe` (NSIS)
- `release/OMP Desktop 0.1.0.msi` (MSI)

macOS and Linux targets use the corresponding Electron Builder target configured
for that runner.

## Packaged runtime validation

After Electron Builder creates `release/win-unpacked`, run:

```sh
bun --cwd=packages/desktop run release:validate
```

The validator launches the packaged executable with an isolated user-data
directory and checks the actual runtime rather than source files. It fails when
the renderer is blank, the `file://...app.asar/dist/index.html` URL is wrong,
the preload bridge or diagnostics IPC is missing, the bundled sidecar is not
`omp/17.0.1`, the Side Chat / settings smoke fails, or the multiwindow engine
probe does not observe a healthy running engine. The Windows release workflow
runs this gate after packaging and no longer treats contract-smoke failures as
optional. It also performs an MSI administrative extraction into the runner's
temporary directory and runs the same packaged validator against that payload,
without installing the app or writing shortcuts.

## Security and lifecycle

- Renderer isolation is enabled (`contextIsolation: true`, `nodeIntegration: false`).
- The preload exposes only typed operations needed by the UI; arbitrary child-process
  spawning is not available to renderer code.
- Main and Side Chat use independent OMP processes.
- Electron Builder skips native rebuilds and packages `node-pty`'s shipped
  prebuilds; this avoids requiring local Visual Studio Spectre libraries just to
  package the app.
- Scheduled tasks are persisted in Electron's application data directory, reject
  duplicate runs, skip missing workspaces, cap retries, and retain bounded history.
- Main-process logs redact credential-shaped values and are available through the
  diagnostics bundle.

## Signing and updates

Local builds are unsigned and may trigger Windows SmartScreen warnings. Configure
Electron Builder signing in CI when a certificate is available. Auto-update is
disabled by default as requested; enabling it later requires a signed update feed and
an explicit updater implementation in `src/lib/updater.ts`.
