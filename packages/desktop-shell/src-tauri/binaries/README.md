# Sidecar binaries

Tauri looks here for `omp-bridge-<rust-target-triple>{.exe}` at bundle time.
The binaries are NOT checked in — they are produced by:

```sh
bun run prep-sidecar    # from packages/desktop-shell
```

which calls `bun run compile` in `packages/desktop-bridge` and stages the
output here with the expected name.

`prep-sidecar` runs automatically via Tauri's `beforeDevCommand` and
`beforeBuildCommand` hooks (see `tauri.conf.json`).

## Cross-platform releases

`bun build --compile` produces a binary for the **host** platform only.
Building installers for all targets requires running `prep-sidecar` on a
Windows, macOS, and Linux runner respectively — handled in CI.
