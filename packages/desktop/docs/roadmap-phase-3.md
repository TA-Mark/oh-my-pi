# Giai đoạn 3 — Đóng gói, bảo mật, phân phối

Đưa app tới trạng thái phân phối được: bảo mật WebView, ký/notarize, tự cập nhật, sidecar
bền trên mọi kênh cài đặt. Chủ yếu `src-tauri/` + CI release.

## Bối cảnh

- `tauri.conf.json`: CSP `null` (tắt) — tăng blast radius nếu render nội dung không tin cậy.
- Capabilities tối thiểu (dialog/opener), chưa cấp shell tùy ý cho frontend — tốt, giữ.
- Sidecar khai báo external binary `binaries/omp`; `build-sidecar.ts` stage theo target triple.
- `desktop-release.yml` tồn tại nhưng chi tiết trigger/matrix/signing chưa xác minh đầy đủ.

## Các thay đổi

### 3.1 — Bật CSP tường minh

**Mục tiêu.** Thay `csp: null` bằng policy chặt.

**Thiết kế.**
- Xác định nguồn hợp lệ: asset cục bộ, kết nối IPC Tauri, không cho remote script.
- `default-src 'self'`; siết `script-src`/`style-src`/`connect-src`/`img-src` theo thực tế
  (ảnh base64 trong prompt → cho `data:` ở `img-src`).
- Test kỹ vì extension UI render nội dung động; đảm bảo không vỡ widget/title/editor.

### 3.2 — Rà soát capabilities least-privilege

**Mục tiêu.** Chỉ cấp quyền thực dùng.

**Thiết kế.** Kiểm từng permission trong `capabilities/default.json`; loại bỏ quyền không
dùng; tách capability theo cửa sổ nếu cần. Xác nhận frontend không có shell tùy ý.

### 3.3 — Signing & notarization

**Mục tiêu.** Cài đặt không cảnh báo trên macOS/Windows.

**Thiết kế.**
- macOS: Developer ID + notarization + stapling.
- Windows: Authenticode (EV nếu có) để tránh SmartScreen.
- Bí mật ký nằm ở CI secrets, không commit; job release ký artifact sau build.

### 3.4 — Auto-update

**Mục tiêu.** Cập nhật liền mạch.

**Thiết kế.** Tauri updater: endpoint manifest có chữ ký; kiểm phiên bản lúc khởi động;
UX thông báo + cập nhật nền. Ký update tách khỏi ký cài đặt.

### 3.5 — Sidecar bền & graceful shutdown

**Mục tiêu.** Resolve binary đúng trên mọi kênh; tắt sạch.

**Thiết kế.**
- Xác nhận thứ tự resolve (`OMP_ENGINE_ARGV` → source debug → binary cạnh exe/PATH) đúng
  cho bản đóng gói (`rpc.rs`).
- Graceful shutdown: `stop_engine` gửi tín hiệu, chờ thoát, kill nếu quá hạn; dọn
  process-tree (nối GĐ1.4).
- Xử lý sidecar crash: tự khởi lại có kiểm soát hoặc báo lỗi rõ (dựa GĐ0.4).

## Thứ tự triển khai

3.5 (bền vận hành, nối GĐ1.4) → 3.1 + 3.2 (bảo mật) → 3.3 → 3.4 (phân phối). Signing phải
xong trước auto-update (update cần artifact đã ký).

## Điều kiện ra GĐ3

- CSP tường minh, không vỡ extension UI.
- Capabilities least-privilege đã rà.
- Artifact ký + notarize trên macOS/Windows; cài không cảnh báo.
- Auto-update ký hoạt động.
- Sidecar resolve đúng mọi kênh; shutdown sạch, không rò process.

## Trạng thái triển khai (đã xong bằng code)

- **3.5 Process-tree reaping** — `rpc.rs`: engine spawn trong process group riêng
  (`process_group(0)`, Unix); `stop_engine` + workspace-switch replace gọi `reap_process_tree`
  → Unix `kill(-pgid, SIGTERM)` → sleep 150ms → `SIGKILL`; Windows `taskkill /PID <pid> /T /F`.
  libc `kill` bind trực tiếp (2 symbol, không thêm crate). Không còn rò LSP/bash grandchild.
- **3.1 CSP** — `tauri.conf.json` thay `csp: null` bằng allowlist tường minh: `default-src
  'self'`; `img-src` + `data:`/`asset:`/`blob:` (ảnh base64); `style-src 'unsafe-inline'`
  (Vite `<style>` + inline `style={{height}}` của diff virtualizer); `connect-src` + `ipc:`;
  `object-src`/`frame-src` `'none'`. Đã đối chiếu mọi nguồn tài nguyên (Markdown escape HTML,
  không script inline).
- **3.2 Capabilities** — xác nhận least-privilege; `description` giải thích từng permission
  (core:default IPC, dialog picker, 3 opener đều dùng). Không cấp fs/shell/http cho WebView.
- **3.3 Signing config** — `bundle.windows` (`digestAlgorithm` sha256 + DigiCert timestamp,
  inert khi vắng cert) + `bundle.macOS.hardenedRuntime: true` (bắt buộc cho notarize). Cả hai
  field xác minh hợp lệ với schema Tauri v2. Unsigned build vẫn chạy.
- **3.4 Auto-update** — **đã wire đầy đủ**. Keypair minisign đã sinh; pubkey thật trong
  `tauri.conf.json` (`plugins.updater.pubkey` + `createUpdaterArtifacts: true`), endpoint
  `releases/latest/download/latest.json`. Rust đăng ký `tauri-plugin-updater` +
  `tauri-plugin-process` (desktop-only cfg); capability thêm `updater:default` +
  `process:allow-restart`. Frontend: `lib/updater.ts` (`checkForUpdate`/`installUpdate`) →
  `app.tsx` check-on-mount → `AppShell` render `.update-banner` → nút "Install & restart"
  stop client rồi `downloadAndInstall` + `relaunch`. Private key **không commit** (chỉ nằm ở
  CI secret `TAURI_SIGNING_PRIVATE_KEY`).
- **Verify** — cargo test 2 pass + clippy sạch (Windows host, đã compile cả 2 plugin mới);
  desktop check/lint/32 test/smoke 18 OK. Nhánh Unix reaping compile qua `#[cfg(unix)]`
  (build trên runner Linux/macOS; cross-check tại chỗ chặn bởi transitive dep `libdbus-sys`
  cần sysroot — không liên quan code).

## Hạ tầng CI (đã xong bằng code)

- **Ký + notarize + updater** — `desktop-release.yml`:
  - Windows Authenticode: step optional import PFX từ secret `WINDOWS_CERTIFICATE` vào cert
    store rồi tiêm `certificateThumbprint` vào config (no-op nếu vắng secret).
  - macOS: env `APPLE_*` truyền sẵn cho `tauri build` (đã có từ trước).
  - Updater signing: env `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD` cho `tauri build` → sinh
    artifact `.sig` mỗi platform (no-op → unsigned nếu vắng key).
- **`latest.json`** — job `updater-manifest` (post-matrix, chỉ trên tag): gộp fragment `.sig`
  từng platform, resolve URL asset thật qua GitHub API (khử space→`.`), publish `latest.json`
  lên release đúng endpoint updater. Không có platform ký → bỏ qua, không vỡ release.
- **Packaged WebDriver smoke** — job `e2e-smoke` (Windows, tag/manual, `continue-on-error`,
  không chặn PR/release): cài `tauri-driver` + `msedgedriver`, build bundle thật, chạy
  `e2e/wdio.conf.ts` + `specs/launch.e2e.ts` — xác minh app đóng gói mount `.app-shell`,
  render nav, title đúng, không rơi vào error boundary (bắt regression CSP/asset/bridge).

## Còn lại (cần hạ tầng ngoài repo)

- **Cấp cert thật** — cần Apple Developer ID + Windows Authenticode cert, nạp vào CI secrets
  (`APPLE_*`, `WINDOWS_CERTIFICATE`/`_PASSWORD`). Plumbing CI đã sẵn.
- **Nạp updater key vào CI** — `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD` (đã sinh, chờ user
  lưu vào repo secret). Sau đó tag `desktop-v*` sẽ tự sinh + publish `latest.json`.
- **Xác minh CSP end-to-end** — job `e2e-smoke` sẽ bắt phần lớn; vẫn nên kiểm bản build thật
  để chắc extension UI/widget không vỡ dưới CSP mới.
