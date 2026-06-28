# Code signing — Windows & macOS

Production installers MUST be signed or the OS will warn users (Windows
SmartScreen) or refuse to open (macOS Gatekeeper). This guide walks through
the per-platform setup. Linux distros don't require signing; AppImage / deb
can ship unsigned.

`tauri.conf.json` already contains the template fields (`bundle.windows`,
`bundle.macOS`) — fill them in or set the equivalent env vars listed below.

## Windows

### 1. Acquire a certificate

You need an **OV** ("Organization Validation") or **EV** ("Extended
Validation") code-signing certificate from a trusted CA — e.g.
DigiCert, Sectigo, SSL.com, GlobalSign. EV is required to immediately
bypass SmartScreen for new publishers (~$300–500/year).

The cert lives in either:
- The Windows Certificate Store (`Cert:\CurrentUser\My` after import) —
  identify by thumbprint
- A `.pfx` file + password — preferred for CI

### 2. Wire the thumbprint (local machine)

```powershell
# List installed code-signing certs
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select Thumbprint, Subject
```

Paste the thumbprint into `tauri.conf.json`:

```json
"bundle": {
  "windows": {
    "certificateThumbprint": "ABCDEF0123..."
  }
}
```

Then `bun run build` will sign every installer it produces.

### 3. CI signing (preferred — no thumbprint in source)

Replace `certificateThumbprint` with a custom `signCommand` that signs
from an env-supplied `.pfx`:

```json
"bundle": {
  "windows": {
    "signCommand": "signtool sign /f %WIN_PFX_PATH% /p %WIN_PFX_PASSWORD% /tr http://timestamp.digicert.com /td sha256 /fd sha256 %1"
  }
}
```

Provide secrets to the runner:
- `WIN_PFX_BASE64` — base64-encoded `.pfx` (decoded into `WIN_PFX_PATH` at job start)
- `WIN_PFX_PASSWORD` — passphrase

## macOS

### 1. Apple Developer Program

You need:
- Apple Developer account ($99/year)
- A **Developer ID Application** certificate (for distribution outside
  the App Store) imported into Keychain
- App-specific password OR App Store Connect API key for notarization

### 2. Wire the identity (local machine)

```sh
# List Developer ID Application identities
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Paste into `tauri.conf.json`:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
    "providerShortName": "TEAM_ID"
  }
}
```

### 3. Notarization

After signing, the `.dmg` / `.app` must be notarized by Apple. Tauri 2
handles this when the following env vars are set during `tauri build`:

```sh
# Either app-specific password
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TEAM_ID"

# OR App Store Connect API key (preferred for CI)
export APPLE_API_ISSUER="..."
export APPLE_API_KEY="..."
export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXX.p8"
```

Then:

```sh
bun run build
```

Tauri will sign, notarize, staple the ticket, and produce a Gatekeeper-clean
artifact. Verify:

```sh
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Oh-My-Pi Desktop_0.1.0_aarch64.dmg"
spctl -a -t open --context context:primary-signature "Oh-My-Pi Desktop.app"
```

## CI secrets checklist

Recommended GitHub Actions secret names:

| Secret                          | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `WIN_PFX_BASE64`                | Windows .pfx (base64)                    |
| `WIN_PFX_PASSWORD`              | Windows .pfx passphrase                  |
| `APPLE_CERTIFICATE_BASE64`      | macOS Developer ID cert (.p12 base64)    |
| `APPLE_CERTIFICATE_PASSWORD`    | macOS .p12 passphrase                    |
| `APPLE_API_ISSUER`              | App Store Connect API issuer ID          |
| `APPLE_API_KEY`                 | App Store Connect API key ID             |
| `APPLE_API_KEY_BASE64`          | .p8 file contents (base64)               |
| `TAURI_SIGNING_PRIVATE_KEY`     | Auto-updater signing key (see UPDATE.md) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key passphrase              |

## What gets signed

Tauri signs ALL of the following automatically when configured:
- `.exe`, `.msi` (Windows NSIS + WiX installers)
- The bundled `omp-bridge` sidecar binary
- `.app` bundle contents (macOS)
- `.dmg` outer wrapper (macOS)

It does NOT sign:
- Linux artifacts (AppImage / deb) — distros handle integrity differently
- The updater manifest JSON — that uses the Tauri updater signing key from
  [UPDATE.md](UPDATE.md), not the OS code-signing cert
