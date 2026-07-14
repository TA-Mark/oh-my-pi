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

`bundle.windows` is pre-configured with `digestAlgorithm: "sha256"` and a DigiCert
`timestampUrl` — these are inert until a cert is supplied, so unsigned builds still
succeed. To sign, add `certificateThumbprint` (or a custom `signCommand`) in
`tauri.conf.json`; in CI, import the PFX and set the thumbprint. Tauri signs the NSIS/MSI
during `tauri build`. Timestamping (already wired) keeps signatures valid past cert expiry.

### macOS (sign + notarize)

`bundle.macOS.hardenedRuntime` is enabled (required for notarization). Add the signing
identity in `bundle.macOS.signingIdentity` (Developer ID Application), and provide
notarization credentials to `tauri build` via env:

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

**Deliberately not wired into `tauri.conf.json` yet** — the updater plugin *requires* a
real public key at build time, and a bad/placeholder key fails `tauri build`. Enabling it
is a config-only change once a keypair and release channel exist:

1. `bun add @tauri-apps/plugin-updater` + `tauri-plugin-updater` (Cargo).
2. `tauri signer generate` → private key (CI secret `TAURI_SIGNING_PRIVATE_KEY`) + public key.
3. Add to `tauri.conf.json`:
   ```json
   "plugins": { "updater": { "pubkey": "<public key>", "endpoints": ["https://.../latest.json"] } }
   ```
   and grant `updater:default` in `capabilities/default.json`.
4. The release workflow signs artifacts with the private key and publishes `latest.json`.

Update signing (this key) is separate from install signing (Authenticode / Developer ID).

## Security hardening (Phase 3)

- **CSP** — `app.security.csp` is an explicit allowlist (was `null`). `default-src 'self'`;
  `img-src` adds `data:`/`asset:`/`blob:` for base64 attachments and Tauri asset URLs;
  `style-src` keeps `'unsafe-inline'` (Vite injects a `<style>` tag and the diff virtualizer
  uses inline `style={{height}}`); `connect-src` allows `ipc:` for the bridge. `object-src`
  and `frame-src` are `'none'`. If a future feature loads a remote resource, widen the
  matching directive rather than reverting to `null`.
- **Capabilities** — `capabilities/default.json` is least-privilege; its `description`
  documents why each permission is needed. No fs/shell/http is granted to the WebView.
- **Process-tree reaping** — `stop_engine` (and workspace-switch replace) terminate the
  engine's whole descendant tree, not just the direct child: Unix spawns the engine in its
  own process group (`process_group(0)`) and kills the negative pgid (SIGTERM → SIGKILL);
  Windows uses `taskkill /T /F`. Prevents LSP/bash grandchildren leaking on every switch.

## CI

`.github/workflows/desktop-release.yml` builds the matrix (Windows x64, macOS arm64/x64)
on tag `desktop-v*` or manual dispatch: install → stage the host sidecar → `tauri build`
via `tauri-apps/tauri-action`, attaching installers to a GitHub release. Signing/notary
secrets are read from repo secrets when present; without them the workflow still produces
unsigned artifacts.
