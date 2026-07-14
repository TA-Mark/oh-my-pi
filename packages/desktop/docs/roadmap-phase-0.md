# Giai đoạn 0 — Ổn định correlation & lifecycle

**Ưu tiên cao nhất.** Đây là các lỗi đúng-sai đã xác minh trong reducer/transport. Sửa
xong nhóm này mới có nền để làm UX và refactor. Toàn bộ nằm trong `packages/desktop/src`,
không đụng engine RPC.

## Bối cảnh: các lỗi đã xác minh

| # | Lỗi | Bằng chứng | Hệ quả |
|---|-----|-----------|--------|
| 0.1 | Streaming assistant chỉ gắn "assistant cuối" (`updateLastAssistant` quét ngược, thay message assistant đầu tiên tìm thấy) | `reducer.ts:87-97,118-122` | Stream xen kẽ (subagent + main, hoặc nhiều turn) ghi đè nhau |
| 0.2 | Tool update/end với `toolCallId` lạ bị bỏ im (`patchTool` chỉ map message có sẵn) — khác đường replay có fallback card | `reducer.ts:99-102,139-155` vs `245-259` | Mất tool card nếu `start` đến trễ/thiếu |
| 0.3 | `tool_execution_start` trùng tạo card trùng cùng UI id (`Array.map` không chặn trùng) | `reducer.ts:99-102,123-138` | Card nhân đôi, patch cập nhật cả hai |
| 0.4 | Streaming flag kẹt `true` nếu transport exit/error không kèm `agent_end` | `reducer.ts:104-110,161-163` | UI kẹt "đang chạy" khi engine chết |
| 0.5 | Lỗi request không phân loại: timeout / send-fail / engine-error trộn chung | `rpc-client.ts:239-247,270-289` | UI khó phục hồi/hiển thị đúng nguyên nhân |

## Các thay đổi

### 0.1 — Correlation streaming theo message id

**Vấn đề.** `updateLastAssistant` gắn mọi `message_update` vào assistant cuối cùng trong
mảng, không theo id. Khi có hai luồng assistant xen kẽ (ví dụ subagent panel + main thread,
hoặc snapshot đến sau khi user đã gửi turn mới), luồng này ghi đè luồng kia.

**Thiết kế.**
- Reducer giữ `Map<messageId, index>` cho assistant đang stream (song song với map tool
  card `t_${toolCallId}` đã có ở `reducer.ts:99-102`).
- `message_start` tạo row với `messageId` từ frame; `message_update`/`message_end` tra map
  theo id, không quét "cuối cùng".
- Nếu `message_update` đến với id chưa thấy → tạo fallback row (đối xứng với xử lý tool 0.2),
  không bỏ im.
- Giữ hành vi cũ khi frame không có id (fallback về "assistant cuối") để không vỡ luồng
  hiện tại — nhưng log cảnh báo để phát hiện frame thiếu id.

**Rủi ro/kiểm.** Cần xác nhận `rpc-protocol.ts` có `messageId` trên frame
`message_start/update/end`; nếu chưa, đây là tiền đề additive cho engine (ghi core-touchpoints).

### 0.2 — Fallback tool card cho `toolCallId` lạ (đường live)

**Vấn đề.** Đường live `patchTool` bỏ qua update/end nếu chưa có card; đường replay
(`reducer.ts:245-259`) lại tạo fallback. Bất đối xứng → mất card khi `start` thiếu/trễ.

**Thiết kế.** `patchTool` khi không tìm thấy `t_${toolCallId}` → tạo card mới ở trạng thái
suy ra từ event (running nếu update, done/error nếu end), giống đường replay. Dùng chung
một helper `ensureToolCard(state, toolCallId, seed)` cho cả hai đường.

### 0.3 — Chống trùng `tool_execution_start`

**Vấn đề.** Hai `start` cùng `toolCallId` tạo hai card cùng UI id; patch sau cập nhật cả hai.

**Thiết kế.** Trước khi append card, kiểm tra map id: nếu đã tồn tại → cập nhật tại chỗ
thay vì append. `ensureToolCard` (0.2) xử lý luôn ca này.

### 0.4 — Clear streaming flag khi transport exit/error

**Vấn đề.** Reducer chỉ clear `streaming` ở `agent_end`; không có action cho
`rpc://exit`/`rpc://stderr`-fatal. Engine chết giữa chừng → UI kẹt spinner.

**Thiết kế.**
- Thêm action reducer `engine_exit` / `engine_error`: set `streaming=false`, chốt mọi tool
  card đang running thành trạng thái "interrupted", thêm system message "engine dừng".
- `DesktopRpcClient` dịch `rpc://exit` và lỗi fatal thành callback engine-status; `app.tsx`
  dispatch action tương ứng vào reducer.
- Pending request đang chờ bị reject với lỗi phân loại (nối 0.5).

### 0.5 — Phân loại lỗi request

**Vấn đề.** Timeout, send-fail, và engine-error (`response.success === false`) cùng ném
chuỗi lỗi thô — UI không phân biệt để phục hồi.

**Thiết kế.**
- Định nghĩa kiểu lỗi rõ: `RpcTimeoutError`, `RpcTransportError`, `RpcEngineError` (mang
  `command`, `requestId`, message engine).
- `rpc-client.ts` ném đúng loại ở mỗi nhánh cleanup (`270-289`).
- `app.tsx` bắt và hiển thị khác nhau: timeout → cho retry; transport → gợi ý restart engine;
  engine-error → hiện message + giữ transcript.

## Kế hoạch test (GĐ0)

1. **Unit reducer** (mới, `src/lib/reducer.test.ts`):
   - stream hai assistant id xen kẽ → không ghi đè (0.1).
   - tool end không có start → tạo fallback card (0.2).
   - hai start trùng id → một card (0.3).
   - action `engine_exit` khi đang stream → `streaming=false`, tool card → interrupted (0.4).
2. **Integration client** (mới, `src/lib/rpc-client.test.ts`): mock Tauri bridge, bắn
   frame giả / response lỗi / im lặng tới timeout → xác nhận đúng loại lỗi (0.5) và dọn
   pending.
3. **Smoke RPC hiện có** (`scripts/smoke-rpc.ts`): giữ xanh; thêm bước nếu phát sinh command.

## Thứ tự triển khai

0.1 → 0.2 → 0.3 (cùng chạm reducer streaming/tool, gộp một nhánh) → 0.4 → 0.5
(chạm transport, nhánh riêng). Viết test song song từng mục, không gộp cuối.

## Điều kiện ra GĐ0

- 4 nhóm test reducer + integration client xanh.
- Không còn đường mã nào để streaming flag kẹt hoặc tool card mất/nhân đôi.
- Lỗi request phân loại rõ và UI phục hồi được từng loại.

## Trạng thái triển khai (đã xong)

- **0.1** `ViewModel.streamingAssistantId` + `updateAssistantById`; `message_start` mở id,
  `message_update/end` target theo id, `message_end`/`agent_end` đóng — `src/lib/reducer.ts`.
- **0.2 + 0.3** `patchTool(…, seed)` tạo fallback card cho `toolCallId` lạ và dedupe
  `tool_execution_start` (update tại chỗ) — `src/lib/reducer.ts`.
- **0.4** `engineInterrupted()` clear streaming + chốt tool card running → interrupted +
  system notice; app.tsx dispatch khi `onStatus` → stopped/error — `src/lib/reducer.ts`,
  `src/app.tsx`.
- **0.5** `RpcError`/`RpcTimeoutError`/`RpcTransportError`/`RpcEngineError`; `#send` throw
  engine-error cho cả void command; `#rejectPending` reject khi stop/exit; `reportError`
  hiển thị theo `kind` — `src/lib/rpc-client.ts`, `src/app.tsx`.
- **Test** `test/reducer.test.ts` (12 ca) + `test/rpc-client.test.ts` (6 ca), 18 pass.
  Smoke RPC xanh (không drift). Lint + typecheck app sạch.
- **Còn lại cho GĐ1:** test chưa nằm trong `tsconfig` include (thiếu `types: ["bun"]`);
  đưa test vào CI typecheck là hạng mục GĐ1.2.
