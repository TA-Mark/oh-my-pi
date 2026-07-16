# Electron packaging

`electron-builder` creates the desktop installers. The React bundle, Electron main/preload bundles, and compiled OMP engine are packaged together.

## Local commands

```bash
bun --cwd packages/desktop run electron:dev
bun --cwd packages/desktop run e2e
bun --cwd packages/desktop run bundle
```

`bundle` performs these steps:

1. Compile the OMP engine into `resources/omp[.exe]`.
2. Build the React renderer into `dist/`.
3. Bundle Electron main and preload into `dist-electron/`.
4. Produce installers in `release/`.

Windows targets are NSIS and MSI. macOS produces a DMG. The application icon is `resources/icon.png`.

## Development overrides

- `OMP_ENGINE_PATH`: use a specific compiled engine.
- `BUN_BINARY`: use a specific Bun executable for the source engine.
- `CROSS_TARGET`: compile the engine for `windows-x64`, `darwin-x64`, or `darwin-arm64`.
- `SKIP_BUILD=1`: stage an already compiled engine.

## Signing

The release workflow accepts Electron Builder signing variables:

- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

Unsigned local builds remain supported. Auto-update is intentionally disabled until a signed release endpoint is configured; `src/lib/updater.ts` currently returns no available update.

## Release validation

After producing an unpacked build, run `bun run release:validate`. The release workflow runs this automatically after Electron Builder and blocks artifact upload if the platform executable, `app.asar`, or bundled OMP sidecar is missing or empty. The Settings panel also provides **Copy diagnostics**, which copies a redacted support bundle containing app/runtime metadata and the recent Electron log tail; tokens and the local home path are removed.
