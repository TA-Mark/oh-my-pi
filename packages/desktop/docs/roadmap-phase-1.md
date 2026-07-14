# Giai đoạn 1 — Contract & test bền vững

Sau khi correlation/lifecycle đúng (GĐ0), làm cho protocol **không drift** và test phủ
tới **bridge Tauri + sidecar binary thật**, không chỉ Bun source.

## Bối cảnh

- Protocol Desktop viết tay ở `src/lib/rpc-protocol.ts:1-14`, tự nhận là "DOM-safe mirror"
  của type engine, drift guard delegate cho `scripts/smoke-rpc.ts`.
- `smoke-rpc.ts` chạy `packages/coding-agent/src/cli.ts --mode rpc-ui` qua Bun, gửi chuỗi
  request `s1`–`s15`, kiểm payload/state — **nhưng chạy source engine, không phải app
  Tauri đã đóng gói**. Bridge Tauri, sidecar binary compiled, và lifecycle không được phủ.

## Các thay đổi

### 1.1 — Chặn drift protocol ở CI

**Mục tiêu.** Không để mirror viết tay lệch canonical engine type mà không ai biết.

**Hai lựa chọn (chọn theo chi phí):**
- **A. Codegen (mạnh hơn):** sinh `rpc-protocol.ts` từ type canonical của coding-agent
  (`packages/coding-agent/src/modes/rpc/rpc-types.ts`) qua bước build. Ưu: một nguồn sự
  thật. Nhược: cần lớp map DOM-safe (loại bỏ type engine-only).
- **B. CI diff-check (nhẹ hơn):** giữ mirror viết tay nhưng thêm test so khớp tên field /
  union arm giữa hai file; fail CI khi lệch. Ưu: ít động chạm. Nhược: không bắt được sai
  ngữ nghĩa, chỉ bắt lệch cấu trúc.

**Khuyến nghị:** bắt đầu B (rẻ, chặn phần lớn drift), tiến tới A khi protocol ổn định.

### 1.2 — Integration test `DesktopRpcClient`

**Mục tiêu.** Phủ correlation/timeout/cleanup mà không cần engine thật (đã khởi ở GĐ0.5,
mở rộng ở đây).

**Phạm vi.** Mock `tauri-bridge`; kịch bản: response đúng id, response sai id (không resolve),
frame không có id (session event), timeout, `rpc://exit` giữa chừng, nhiều request song song.
Xác nhận `#pending` luôn dọn sạch.

### 1.3 — Packaged-app smoke test

**Mục tiêu.** Phủ khoảng trống lớn nhất: Tauri invoke/event bridge + sidecar binary compiled.

**Thiết kế.**
- Build sidecar (`scripts/build-sidecar.ts`) → binary có Rust target triple.
- Chạy app Tauri ở chế độ test (WebDriver/tauri-driver hoặc harness tối thiểu) khởi
  `start_engine`, gửi vài `send_rpc`, xác nhận nhận `rpc://frame` và `stop_engine` dọn sạch.
- Phủ: resolve sidecar path trên kênh cài đặt, invoke/event round-trip, graceful shutdown.

**Rủi ro.** tauri-driver có ràng buộc nền tảng (Webview2 trên Windows). Nếu chi phí CI cao,
chạy packaged smoke ở job riêng, không chặn PR thường mà chặn release.

### 1.4 — Test crash / restart / workspace-switch

**Mục tiêu.** Xác nhận vòng đời process bền: giết engine giữa chừng → UI phục hồi (dựa GĐ0.4);
đổi workspace → client cũ `stop()` dọn sạch, client mới khởi đúng; không rò process-tree.

## Thứ tự triển khai

1.2 (mở rộng từ GĐ0) → 1.1 (B trước) → 1.3 → 1.4. 1.3 là hạng mục nặng nhất, tách job CI.

## Điều kiện ra GĐ1

- CI chặn drift protocol (ít nhất mức B).
- Integration client phủ mọi nhánh correlation/lifecycle.
- Packaged smoke chạy binary compiled qua bridge Tauri thật, xanh trên ít nhất một nền tảng.
- Test crash/restart/switch xanh; không rò process.

## Trạng thái triển khai

- **Leftover GĐ0 / 1.2** `tsconfig.test.json` (thêm `bun` types, include `src`/`test`/`scripts`);
  `check` chạy cả `tsconfig.json` + `tsconfig.test.json` — test nay được typecheck trong CI.
- **1.1 (mức B — static)** `test/protocol-drift.test.ts` parse desktop `rpc-protocol.ts` và
  engine `rpc-types.ts`, assert **desktop ⊆ engine** (mọi command desktop tồn tại + có
  response arm engine), liệt kê 22 command engine chưa mirror (informational). Đã xác minh
  bắt drift bằng cách inject command giả → fail đúng. Tiến lên mức A (codegen) để sau.
- **1.2** `test/rpc-client.test.ts` mở rộng: session event → onEvent, subagent → onSubagentUpdate,
  extension UI → onExtensionUI, stderr, JSON rác bị bỏ qua, request song song resolve theo id,
  unlisten sau stop. 15 ca.
- **1.3** Thay full WebDriver smoke (phụ thuộc Webview2/tauri-driver, tách job release) bằng
  **Rust unit test** cho seam quan trọng nhất — `engine_argv()` (override `OMP_ENGINE_ARGV`,
  JSON rác/empty fallthrough) và `resolve_engine_program()` (tên binary theo nền tảng) trong
  `src-tauri/src/rpc.rs`. Full packaged-app WebDriver smoke vẫn là việc còn lại của job release.
- **1.4** `test/rpc-client.test.ts` nhóm lifecycle: double-start bị chặn, crash mid-request →
  status stopped + reject, workspace switch (stop cũ → start mới), stop idempotent. 4 ca.
- **Script** `test` (bun), `test:rust` (cargo), `smoke` (bun) thêm vào package.json.
- **Verify** bun 32 pass, cargo 2 pass, smoke 16 OK, check + lint sạch.
- **Còn lại:** mức A codegen protocol; full WebDriver packaged smoke (job release); reaping
  process-tree đầy đủ (GĐ3.5, `stop_engine` hiện chỉ kill child trực tiếp).
