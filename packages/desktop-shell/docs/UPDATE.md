# Auto-Update setup

The shell ships with `tauri-plugin-updater` already wired in. To make it
actually fetch updates, three pieces of one-time setup are required.

## 1. Generate a signing keypair

The updater verifies release artifacts against a public key embedded in the
app. Generate the pair once and **never lose the private key** — it's the
only thing that lets you ship a signed update to existing installs.

```sh
cd packages/desktop-shell
bun run tauri signer generate -w ~/.omp/updater.key
```

This writes:
- `~/.omp/updater.key` — private key (keep secret, store in CI as `TAURI_SIGNING_PRIVATE_KEY`)
- `~/.omp/updater.key.pub` — public key (paste into `tauri.conf.json`)

Replace the `REPLACE_ME` placeholder in `tauri.conf.json` under
`plugins.updater.pubkey` with the contents of `~/.omp/updater.key.pub`.

## 2. Publish an update manifest

On every release, host a JSON file at the configured endpoint
(`https://omp.sh/desktop/updates/{{target}}/{{arch}}/{{current_version}}` in
this skeleton — swap to your real domain).

The endpoint replaces `{{target}}` (`darwin`, `windows`, `linux`),
`{{arch}}` (`x86_64`, `aarch64`), and `{{current_version}}` (semver) before
fetching. Return **204 No Content** when there's no update, or a JSON body:

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes + new chat composer",
  "pub_date": "2026-07-15T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<base64 from tauri signer sign>",
      "url": "https://omp.sh/desktop/releases/v0.2.0/Oh-My-Pi-Desktop_0.2.0_x64-setup.nsis.zip"
    },
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://omp.sh/desktop/releases/v0.2.0/Oh-My-Pi-Desktop_0.2.0_aarch64.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://omp.sh/desktop/releases/v0.2.0/oh-my-pi-desktop_0.2.0_amd64.AppImage.tar.gz"
    }
  }
}
```

## 3. Sign each release artifact

In your release pipeline, after Tauri produces installers:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.omp/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_KEY_PASSWORD:-}"
bun run tauri signer sign --private-key-path ~/.omp/updater.key path/to/installer.exe
```

This emits a `.sig` file; paste its base64 content into the manifest above.

## 4. (Optional) Update check in the UI

The shell uses `dialog: true`, so Tauri shows a native "Update available"
dialog on launch. To trigger a manual check from a settings button, call
the JS API:

```ts
import { check } from "@tauri-apps/plugin-updater";
const update = await check();
if (update) {
  await update.downloadAndInstall();
}
```

That requires adding `@tauri-apps/plugin-updater` to
`packages/collab-web`'s dependencies. The dialog flow works without it.
