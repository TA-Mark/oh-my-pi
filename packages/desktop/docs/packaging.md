# Packaging & Release

The desktop app ships as a **Tauri bundle** (installer per OS) that carries the
`omp` engine as a **sidecar binary**. There is no separate engine install — the
compiled `omp` runs beside the app and speaks RPC over stdio (see `design.md`).

## Moving parts

| Piece | How it's built | Where it lands |
| ----- | -------------- | -------------- |
| Frontend | `vite build` (via Tauri `beforeBuildCommand`) | `dist/` |
| Engine sidecar | `scripts/build-sidecar.ts` → `bun --cwd=packages/coding-agent run build` | `src-tauri/binaries/omp-<triple>[.exe]` |
| Shell + installer | `tauri build` | `src-tauri/target/release/bundle/` |

**Sidecar contract.** `tauri.conf.json` declares `bundle.externalBin: ["binaries/omp"]`.
Tauri requires a file named `binaries/omp-<RUST_TARGET_TRIPLE>[.exe]` at build time and
**strips the triple** when copying it next to the app binary. At runtime
`src-tauri/src/rpc.rs` (`resolve_engine_program`) resolves plain `omp[.exe]` beside
`current_exe`, falling back to `PATH`. `OMP_ENGINE_ARGV` overrides both (used in dev).

## Build locally (host platform)

```sh
bun install
bun --cwd=packages/desktop run bundle     # = sidecar (host triple) + tauri build
```

Installer output:
- **Windows**: `src-tauri/target/release/bundle/nsis/*.exe` and `.../msi/*.msi`
- **macOS**: `.../bundle/dmg/*.dmg` and `.../macos/*.app`
- **Linux**: `.../bundle/{deb,rpm,appimage}/*`

Stage the sidecar without rebuilding the engine (e.g. after a Rust-only change):

```sh
SKIP_BUILD=1 bun --cwd=packages/desktop run sidecar
```

## Cross-compiling the engine

The engine sidecar is normally built natively on each target runner. To cross-build
the engine for another target, pass `CROSS_TARGET` (see `coding-agent/scripts/build-binary.ts`):

```sh
CROSS_TARGET=linux-arm64 bun --cwd=packages/desktop run sidecar
```

Known `CROSS_TARGET` values → Rust triples: `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `windows-x64`. The Tauri shell itself is built per platform on its own
runner (mac apps require a macOS host; Windows apps a Windows host).

## Code signing

Unsigned builds run locally but trigger OS warnings (SmartScreen / Gatekeeper) for users.

### Windows (Authenticode)

Configure in `tauri.conf.json` under `bundle.windows` (`certificateThumbprint`,
`digestAlgorithm`, `timestampUrl`) or a custom `signCommand`. In CI, import the PFX and
set the thumbprint. Tauri signs the NSIS/MSI during `tauri build`.

### macOS (sign + notarize)

Set the signing identity in `bundle.macOS.signingIdentity` (Developer ID Application),
and provide notarization credentials to `tauri build` via env:

```
APPLE_CERTIFICATE            # base64 .p12
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID
APPLE_PASSWORD               # app-specific password
APPLE_TEAM_ID
```

Tauri submits the `.app`/`.dmg` for notarization and staples the ticket. Note the engine
sidecar is a separate Mach-O and must also be signed with the hardened runtime — Tauri
signs bundled `externalBin` as part of the app signing pass.

## Auto-update (optional, not yet enabled)

Add `@tauri-apps/plugin-updater` + `tauri-plugin-updater`, a keypair
(`tauri signer generate`), the public key + update endpoints in `tauri.conf.json`
(`plugins.updater`), and publish `latest.json` + signed artifacts. Deferred until a
release channel exists.

## CI

`.github/workflows/desktop-release.yml` builds the matrix (Windows x64, macOS arm64/x64)
on tag `desktop-v*` or manual dispatch: install → stage the host sidecar → `tauri build`
via `tauri-apps/tauri-action`, attaching installers to a GitHub release. Signing/notary
secrets are read from repo secrets when present; without them the workflow still produces
unsigned artifacts.
