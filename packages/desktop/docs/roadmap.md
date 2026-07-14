# OMP Desktop — Roadmap tới trải nghiệm Codex/Claude

Kế hoạch phát triển theo giai đoạn để đưa OMP Desktop đạt trải nghiệm coding-agent
tương đương Codex / Claude. Tài liệu này là **kế hoạch, chưa triển khai**.

Nguyên tắc thứ tự: **đúng trước → bền vững → rồi mới đẹp và nhanh.**

## Nền tảng hiện tại (đã xác minh từ mã nguồn)

Kiến trúc: **thin Tauri shell + RPC sidecar + React reducer**.

- React WebView ⇄ sidecar `omp --mode rpc-ui` qua NDJSON stdin/stdout.
- Rust bridge phơi 3 command (`start_engine`, `send_rpc`, `stop_engine`) và 3 event
  (`rpc://frame`, `rpc://stderr`, `rpc://exit`) — `src/lib/tauri-bridge.ts:24-49`.
- `DesktopRpcClient`: handshake `ready` (timeout 30s), correlation `req_N`, phân loại
  frame → response / session event / subagent / extension UI; giữ và dọn cả 3 listener
  trong `stop()` — `src/lib/rpc-client.ts:70-115,224-293`. React tạo một client mỗi
  workspace, `client.stop()` khi cleanup — `src/app.tsx:237-288`.
- Reducer thuần: transcript + streaming + 200 dòng stderr; tool card khóa `t_${toolCallId}`
  — `src/lib/reducer.ts:27,99-102,104-163`.
- Protocol Desktop **viết tay** (`src/lib/rpc-protocol.ts:1-14`); drift guard là
  `scripts/smoke-rpc.ts` (chạy source engine qua Bun, **không** chạy app Tauri đã đóng gói).

Tính năng đã có đường mã: prompt+ảnh, abort, model/thinking/approval, session
(new/rename/list/switch), subagent, workspace diff, OAuth/API-key/logout, plan mode,
extension UI (select/confirm/input/editor, notify/status/widget/title/open-url).

**Kết luận:** phân lớp đúng và đủ tính năng RPC lõi. Khoảng cách tới Codex/Claude nằm ở
**độ tin cậy protocol/lifecycle** và **độ hoàn thiện UX** — không phải thiếu tính năng nền.

## Bản đồ giai đoạn

| GĐ | Chủ đề | Mục tiêu | Điều kiện ra |
|----|--------|----------|--------------|
| 0 | Correlation & lifecycle | Streaming/tool/lifecycle đúng dưới tải song song và lỗi | Không còn ghi đè stream, không kẹt trạng thái |
| 1 | Contract & test | Protocol không drift, test phủ bridge + binary thật | CI chặn drift; packaged smoke xanh |
| 2 | UX coding agent | Diff review, tool card, streaming mượt, session UX | Ngang Codex/Claude về tương tác |
| 3 | Đóng gói & bảo mật | CSP, signing, auto-update, sidecar bền | Cài đặt/cập nhật an toàn mọi nền tảng |

Chi tiết từng giai đoạn: `roadmap-phase-0.md` … `roadmap-phase-3.md`.

## Ràng buộc xuyên suốt

- **Additive-only với engine RPC.** Mọi thay đổi trong `packages/coding-agent/src/modes/rpc/`
  phải là additive (union arm + case mới), ghi vào `core-touchpoints.md`, và bỏ khi upstream
  có bản riêng (theo `upstream-sync.md`).
- **Refactor sau khi đúng.** Không tách `app.tsx` thành controller hook cho tới khi GĐ0 xong
  — refactor sớm chỉ khuếch đại bug correlation/lifecycle hiện có.
- **Giữ kiến trúc nền.** Thin shell + sidecar + reducer là phù hợp; không thay.
- **Mỗi thay đổi có test.** Ưu tiên smoke RPC hiện có + integration test client + packaged smoke.
