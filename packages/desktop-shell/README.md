# @oh-my-pi/desktop-shell

Tauri 2.x desktop wrapper around the oh-my-pi WebUI. It bundles:

- **Frontend** — pre-built `packages/collab-web/dist`
- **Backend** — `packages/desktop-bridge` runs as a child process supervised by
  the Rust main, talking to the WebView over `http://127.0.0.1:8787`

The user gets a single native window. No browser, no manual launcher script.

## Prerequisites (one-time)

1. **Rust toolchain** — install via [rustup](https://rustup.rs):
   ```powershell
   irm https://win.rustup.rs/x86_64 -OutFile rustup.exe; .\rustup.exe -y --default-toolchain stable
   ```
2. **Tauri platform deps** —
   - **Windows**: Visual Studio Build Tools (Desktop development with C++) + WebView2 (preinstalled on Win11)
   - **macOS**: Xcode CLT (`xcode-select --install`)
   - **Linux**: see [Tauri docs](https://tauri.app/start/prerequisites/)
3. **omp native addon** — already required by Phase 2/3:
   ```sh
   bun --cwd=../natives run build
   ```
4. **Bun ≥ 1.3.14** — already required by the monorepo.

## Dev workflow

```sh
cd packages/desktop-shell
bun install              # picks up @tauri-apps/cli
bun run dev              # builds collab-web → starts tauri dev window
```

Tauri opens a native window pointing at the collab-web build. The Rust main
spawns `bun src/server.ts` from `packages/desktop-bridge` and kills it on exit.

## Production build

```sh
bun run build
```

Outputs to `src-tauri/target/release/bundle/`:

- Windows: `nsis/<App>.exe`, `msi/<App>.msi`
- macOS: `macos/<App>.app`, `dmg/<App>.dmg`
- Linux: `appimage/`, `deb/`

## Icons

Tauri needs a `src-tauri/icons/` directory with `icon.ico`, `icon.icns`,
`32x32.png`, `128x128.png`, etc. Generate from a single source:

```sh
bun run icon ../../assets/icon.png
```

(There is already a hero PNG at `assets/hero.png` and a favicon set in
`packages/collab-web/public/` we can reuse.)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri main (Rust)                                          │
│  ┌──────────────────┐   ┌────────────────────────────────┐  │
│  │ BridgeSupervisor │ ► │ child: bun .../server.ts       │  │
│  │  - spawn         │   │   /api/v1/...  → port 8787     │  │
│  │  - health probe  │   │   ws/...                        │  │
│  │  - kill on exit  │   └────────────────────────────────┘  │
│  └──────────────────┘                                       │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WebView (system WebView2 / WKWebView / WebKitGTK)   │   │
│  │  loads tauri://localhost/index.html                  │   │
│  │  fetches → http://127.0.0.1:8787/api/v1/...          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

The shell never imports oh-my-pi core; it only supervises the bridge.

## Signing / notarization

Production signing is **not** wired up in this skeleton. See
[Tauri's signing guide](https://tauri.app/distribute/sign/) for the platform-
specific steps. CI integration belongs in `scripts/ci-release-build-binaries.ts`.
