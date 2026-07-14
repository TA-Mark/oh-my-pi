# Giai đoạn 2 — Hoàn thiện UX coding agent

Sau khi nền đúng (GĐ0) và bền (GĐ1), nâng tương tác lên ngang Codex / Claude. Chủ yếu
frontend; command engine bổ sung phải additive (ghi `core-touchpoints.md`).

## Các thay đổi

### 2.1 — Diff/patch review inline

**Mục tiêu.** Xem thay đổi file như Codex: chấp nhận/từ chối từng hunk trước khi ghi.

**Nền có sẵn.** Workspace diff đã có payload + refresh bất đồng bộ
(`rpc-protocol.ts` diff types; `app.tsx` refresh). Cần lớp UI review + kênh approve/reject.

**Thiết kế.**
- Panel diff: render per-file, per-hunk, syntax-highlight, đánh dấu add/del.
- Nếu engine đã hỗ trợ approval theo hunk → nối vào approval hiện có; nếu chưa → command
  additive `apply_hunks`/`reject_hunks` (kiểm engine trước, ghi core-touchpoints).
- Gắn với tool card file-edit (2.2) để review ngay trong luồng.

### 2.2 — Tool card giàu ngữ nghĩa

**Mục tiêu.** Card theo loại tool, không phải hộp text chung.

**Thiết kế.**
- Nhận diện loại từ `toolName`/`toolArgs` (đã có ở reducer): file edit, terminal/bash,
  search/grep, web, subagent.
- Mỗi loại có view riêng: file edit → diff preview; terminal → output cuộn + exit code;
  search → danh sách match. Trạng thái running/done/error rõ (dựa GĐ0.2–0.4).
- Có thể mở rộng/thu gọn; giữ raw fallback cho loại chưa nhận diện.

### 2.3 — Streaming mượt

**Mục tiêu.** Cảm giác token-level như Claude/Codex.

**Thiết kế.**
- Render incremental theo `message_update` (đúng nhờ GĐ0.1); tránh reflow toàn transcript.
- Cancel tức thời: nút stop nối `abort` hiện có, phản hồi UI ngay không chờ engine.
- Hiển thị thinking khi model bật (thinking mode đã có ở protocol); có thể ẩn/hiện.

### 2.4 — Session UX

**Mục tiêu.** Quản lý phiên đầy đủ như app trưởng thành.

**Nền có sẵn.** AppShell đã có search/pin/archive/sort + persist localStorage; switch lấy
lại authoritative messages rồi reseed transcript (`reducer.ts:199-264`).

**Thiết kế.**
- Tinh chỉnh reseed cho chính xác pairing toolCall↔toolResult (đã có nền, kiểm ca lỗi).
- Resume phiên đang chạy dở; hiển thị trạng thái phiên (active/idle).
- Đồng bộ title tự sinh (AppShell đã derive từ prompt đầu) với engine rename.

## Thứ tự triển khai

2.2 (nền cho 2.1) → 2.1 → 2.3 → 2.4. 2.1 và 2.2 gắn chặt: card file-edit là chỗ diff
review xuất hiện.

## Điều kiện ra GĐ2

- Diff review per-hunk hoạt động end-to-end.
- Tool card phân loại đúng cho các loại phổ biến, có raw fallback.
- Streaming incremental không reflow; cancel tức thời.
- Session resume/switch chính xác, không mất/lệch transcript.

## Đối chiếu thực tế mã nguồn (đọc lại trước khi triển khai)

Phần lớn GĐ2 **đã tồn tại** — kế hoạch gốc ở trên viết trước khi đọc sâu `ChangesPanel.tsx`
và `collab-web/tool-render`. Trạng thái thực:

- **2.2 — ĐÃ CÓ.** `collab-web/src/tool-render` có 30+ renderer chuyên biệt (bash, edit,
  apply_patch, grep, read, write, task, lsp, web-search…) + generic fallback; desktop dùng
  qua `<ToolView>` trong `Transcript.tsx`. Running/done/error đã đúng nhờ GĐ0.
- **2.1 — GẦN ĐỦ.** `ChangesPanel.tsx` đã có unified/split diff, virtualization, file tree,
  hunk gaps, jump-to-file, collapse/expand. **Thiếu:** accept/reject per-hunk (nút Revert/
  Stage/Commit/PR đang `disabled`) — cần engine RPC command (additive).
- **2.3 — GẦN ĐỦ.** Token-level render đúng nhờ GĐ0.1. Cancel nối `abort` đã có. **Thiếu:**
  scroll polish — `scrollIntoView("smooth")` chạy mỗi lần messages đổi, giật khi user cuộn
  lên đọc giữa lúc streaming.
- **2.4 — ĐÃ CÓ.** AppShell có pin/archive/search/sort + persist localStorage; switch reseed
  transcript (xác minh GĐ0). Không cần làm thêm ở giai đoạn này.

## Phạm vi triển khai thực tế (đã chốt với user)

1. **Scroll polish (2.3)** — auto-scroll chỉ khi user đang ở đáy; thuần frontend.
2. **Stage/unstage (2.1, scope an toàn)** — engine RPC command additive + nối UI ChangesPanel.
   Revert (ghi đè worktree) **cố ý để ngoài scope** — nút Revert giữ disabled.

## Trạng thái triển khai (đã xong)

- **2.3 Scroll polish** — `Transcript.tsx` theo dõi vị trí cuộn của container `.app-content`
  (`findScrollParent` + listener), chỉ `scrollIntoView` khi user ở trong `NEAR_BOTTOM_PX=120`
  của đáy → cuộn lên đọc giữa lúc streaming không bị kéo xuống.
- **2.1 Stage/unstage (engine)** — thêm command additive `stage_hunks` (git.stage.hunks) +
  `unstage` (git.stage.reset) vào `rpc-types.ts` + `rpc-mode.ts`; interface `RpcHunkSelection`.
  **Non-destructive:** chỉ đụng git index, không đụng worktree. Ghi `core-touchpoints.md`.
- **2.1 Stage/unstage (desktop)** — mirror command trong `rpc-protocol.ts` (interface
  `HunkSelection`) + method `stageHunks`/`unstage` trong `rpc-client.ts`; handler
  `onStageHunks`/`onUnstage` trong `app.tsx` (refresh diff sau mỗi thao tác, reportError
  phân loại). Nối UI: nút "Stage file" (per-file), "Stage all" (floating), "Unstage all"
  (review menu) qua chuỗi AppShell → WorkspaceToolsPanel → ChangesPanel.
- **Drift guard** — smoke-rpc thêm bước 17 (unstage) + 18 (stage_hunks empty → guard);
  protocol-drift test xác nhận 2 command mới mirror đúng (desktop ⊆ engine).
- **Verify** — desktop: check + lint sạch, 32 bun test pass, smoke 18 OK; engine: types +
  biome sạch.

## Đã có sẵn, không cần làm

- **2.2 Tool card theo loại** — `collab-web/tool-render` (30+ renderer) dùng qua `<ToolView>`.
- **2.4 Session UX** — AppShell pin/archive/search/sort + persist; switch reseed transcript.
- **2.3 Token-level streaming** — đúng nhờ GĐ0.1; cancel nối `abort` đã có.

## Còn lại (ngoài scope đã chốt)

- **Revert per-hunk/file** — cần command ghi worktree (`patch.applyText reverse` /
  `git.restore`); đụng dữ liệu user, cần xác nhận UI. Để giai đoạn sau nếu cần.
- **Commit/Create PR** — nút vẫn disabled; cần command commit/push additive.
- **Phân biệt staged/unstaged trong diff** — hiện `get_workspace_diff` gộp; muốn hiển thị
  trạng thái staged per-file cần mở rộng payload diff (additive).
