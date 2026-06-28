# Bundled resources

Files staged here are bundled INTO the installer by Tauri and copied next to
the installed `omp-desktop-shell.exe` at install time. NOT checked in —
produced by `bun run scripts/fetch-bundled-deps.ts`.

- `mingit/` — portable Git for Windows (MinGit). Bridge prepends its `cmd/`
  to PATH before spawning install scripts.
- `native/pi_natives.<triple>.node` — precompiled native addon for omp.
  Bridge copies into `<installDir>/packages/natives/native/` after the
  Installer phase finishes cloning the repo.
