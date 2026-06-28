# Icons

Tauri expects this directory to contain platform-specific icon files. They
are NOT checked in to source — generate them locally from a single PNG.

## Generate

From `packages/desktop-shell/`:

```sh
bun run icon ../../assets/icon-source.png   # provide a ≥ 1024x1024 PNG
```

This produces:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)
- additional sizes used by mobile targets

Until you generate icons, `tauri dev` / `tauri build` will fail with a missing
icon error. Pick any 1024×1024 PNG to unblock dev work — replace with the real
brand asset before shipping.

See [Tauri icon docs](https://tauri.app/develop/icons/) for details.
