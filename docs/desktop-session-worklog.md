# Desktop UX Worklog — Phiên 2026-07-14

Ghi lại các hạng mục đã hoàn thành trong phiên làm việc trên nhánh `CustomDesktop`.
Tất cả tập trung vào việc loại bỏ độ trễ/treo cảm nhận được ở OMP Desktop.

## 1. Cửa sổ console phụ khi chọn project (đã xong)

- **Triệu chứng:** Sau khi chọn project, một cửa sổ console đen "Windows PowerShell"
  hiện lên cạnh OMP Desktop.
- **Nguyên nhân:** Tiến trình engine sidecar được spawn trên Windows mà thiếu cờ
  `CREATE_NO_WINDOW`, nên Windows tự tạo cửa sổ console cho tiến trình con.
- **Fix:** Thêm cờ `CREATE_NO_WINDOW` (0x0800_0000) vào lệnh spawn engine.
  - `packages/desktop/src-tauri/src/rpc.rs`
- stdin/stdout vẫn được pipe nên transport NDJSON không bị ảnh hưởng.

## 2. UI/UX phản hồi tức thì (đã xong)

- **Triệu chứng:** Bật/tắt plan bị delay lâu; khi hỏi không phân biệt được agent
  có đang chạy hay không vì mọi thao tác cảm giác trễ.
- **Fix (chỉ frontend, mẫu optimistic UI):**
  - **Plan toggle optimistic:** lật state ngay khi click, revert nếu RPC lỗi.
    - `packages/desktop/src/app.tsx` (`onTogglePlanMode`, `planModeRef`)
  - **Cờ streaming optimistic:** bật `streaming` ngay khi gửi để UI báo agent đang
    làm việc trước khi `agent_start` của engine về. `agent_start`/`agent_end`
    (và `interrupted`) vẫn là nguồn sự thật sau đó.
    - `packages/desktop/src/app.tsx` (`onSend`, action `streaming` trong `rootReducer`)
    - `packages/desktop/src/lib/rpc-client.ts` (`prompt` trả về `{ agentInvoked }`)
  - **Chỉ báo "OMP is working…":** hiển thị khi đang streaming và chưa có phản hồi.
    - `packages/desktop/src/components/Transcript.tsx`
    - `packages/desktop/src/components/AppShell.tsx` (truyền `streaming`)
    - `packages/desktop/src/styles/02-thread.css` (`.thinking-indicator`, dots animation,
      fallback `prefers-reduced-motion`)

## 3. Treo khi chuyển session (new task / mở task lịch sử) (đã xong)

- **Triệu chứng:** Đang ở project vừa hỏi → bấm "new task" không phản hồi ngay
  (hiện trễ); mở task lịch sử → UI treo rồi mới hiện lịch sử.
- **Nguyên nhân (2 tầng):**
  1. Engine dispatch **tuần tự**; `new_session`/`switch_session` gọi
     `await abort()` → bên trong `await waitForIdle()` chặn khi turn LLM đang tháo,
     làm mọi lệnh xếp sau (list_sessions, get_messages…) bị kẹt.
  2. Frontend chờ trọn round-trip mới cập nhật UI, không có loading state.
- **Fix (engine — chạy nền lệnh đọc thuần an toàn):**
  - Cho 6 lệnh đọc **độc lập với session-state** chạy nền như `bash`:
    `list_sessions`, `get_workspace_diff`, `get_available_models`,
    `get_available_commands`, `get_login_providers`, `get_session_stats`.
    Cố ý **loại** `get_messages`/`get_state` (đọc session hiện tại — phải serialize
    sau switch để không đọc session nửa vời).
    - `packages/coding-agent/src/modes/rpc/rpc-mode.ts` (`dispatchRpcInputFrame`)
  - An toàn vì client khớp response theo `id` (không phụ thuộc thứ tự FIFO).
- **Fix (frontend — optimistic + loading):**
  - `onNewSession`: reset về home tức thì trước round-trip; refresh chạy nền.
  - `onSelectSession`: reset + cờ `switching` + chỉ báo "Opening task…" ngay khi
    click; xử lý case `cancelled` (hook chặn switch → re-seed transcript cũ).
  - Truyền prop `switching` qua AppShell; CSS `.switching-indicator`.
    - `packages/desktop/src/app.tsx`
    - `packages/desktop/src/components/AppShell.tsx`
    - `packages/desktop/src/styles/02-thread.css`

## 4. Nút Stop trơ khi bấm (hardening) (đã xong)

- **Triệu chứng:** Bấm Stop khi agent đang chạy không thấy phản hồi ngay, dễ
  bấm lại nhiều lần.
- **Nguyên nhân:** Engine `session.abort()` `await waitForIdle()` chặn vài giây
  trong lúc tháo turn LLM; nút Stop chỉ đổi khi `agent_end`/`interrupted` về nên
  trong khoảng đó nút không thay đổi.
- **Fix (frontend-only, mẫu optimistic):**
  - Cờ `aborting` bật ngay khi click → nút chuyển "Stopping…", disabled (chống
    double-click), pulse báo "đang xử lý".
  - Effect reset cờ khi `vm.streaming` về `false` — bao cả lối graceful
    (`agent_end`) lẫn transport (`engine stopped`), tự lành nếu không có terminal event.
    - `packages/desktop/src/app.tsx` (state `aborting`, `onAbort`, effect, prop)
    - `packages/desktop/src/components/AppShell.tsx` (truyền prop)
    - `packages/desktop/src/components/Composer.tsx` (nút Stop → "Stopping…")
    - `packages/desktop/src/styles/03-composer.css` (`.composer-send--stopping` pulse,
      fallback `prefers-reduced-motion`)

## 5. Branch session picker modal (đã xong)

- **Triệu chứng:** Chọn nhánh của một session vẫn chưa có bề mặt chọn rõ ràng theo nội dung message.
- **Fix:** Thêm local dialog `kind: "branch"` trong `packages/desktop/src/components/DialogHost.tsx`.
  - Hiển thị 20 message branchable gần nhất.
  - Có ô filter, danh sách cuộn, và chọn theo `entryId` thay vì chỉ số.
  - `packages/desktop/src/app.tsx` mở dialog từ `onBranchSession`.
  - `packages/desktop/test/ui-polish.test.tsx` có test cho branch picker.
- **Validation:** `bun run check`, `bun run test`, và browser preview của dialog scaffold đều pass.

## Validation

- Desktop typecheck (`bun run check`): sạch.
- Biome: các file đã sửa clean.
- Test desktop: 32/32 pass.
- Build sidecar + `tauri build`: exit 0, tạo đủ `omp-desktop.exe`, `.msi`, NSIS setup.
  (Lỗi `TAURI_SIGNING_PRIVATE_KEY` ở bước ký updater cuối là vô hại — bundle đã tạo xong trước đó.)
- Chạy trực tiếp `omp-desktop.exe`: khởi động sạch, không có cửa sổ console phụ.
