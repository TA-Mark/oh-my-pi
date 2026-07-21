# OMP v17.0.1 → Electron Desktop parity audit

Ngày rà soát: 2026-07-18

## Kết luận

Electron Desktop đã nối được phần lớn luồng làm việc chính của OMP v17.0.1, nhưng **chưa đạt
feature parity đầy đủ**. Cần phân biệt ba lớp:

1. **Protocol parity:** đạt; `rpc-protocol.ts` mirror toàn bộ command core.
2. **Client parity:** đạt; `DesktopRpcClient` mirror toàn bộ command core.
3. **Product parity:** thấp hơn client parity — một số method đã tồn tại nhưng chưa có UI hoặc chỉ có
   UI tối giản.

Runtime hiện tại khỏe ở phạm vi đã được kiểm thử:

- Electron sidecar báo `omp/17.0.1`.
- Không còn `packages/desktop/src-tauri` và không còn dependency/config Tauri trong desktop.
- Desktop typecheck: pass.
- Desktop unit tests: 108 pass, 0 fail.
- Sidecar RPC smoke: pass toàn bộ probe hiện có, gồm guided-goal guard, vibe toggle, and branch picker UI.

## Ma trận parity

| Nhóm | Trạng thái | Đã có | Còn thiếu hoặc chưa chính xác |
| --- | --- | --- | --- |
| Electron architecture | Gần đủ | Main/preload/context isolation, main engine, side engine, packaged sidecar, bounded crash recovery, engine-per-window routing | Renderer E2E cho nhiều cửa sổ chưa có trong release gate |
| Prompt và streaming | Gần đủ | Prompt, image, streaming text, tool lifecycle, Stop, steer/follow-up queue, command palette, queue policy controls | Interrupt behavior còn cần test E2E trên nhiều cửa sổ |
| Session events | Đủ ở protocol | Core agent/session events, retry, compaction, TTSR, todo, IRC, goal, notice, plan | Một số event chỉ thành system text; chưa có timeline/diagnostics chuyên biệt |
| Models/auth | Gần đủ | Provider login, API key, logout, model picker, thinking, approval, OAuth `launchUrl` | Cycle model/thinking chưa nối UI |
| Sessions | Gần đủ | New/list/switch/rename/reseed transcript; Branch theo user message, Export HTML và Handoff đều có menu UI và gọi RPC thật | Branch picker hiện là modal list/filter theo message; cây branch trực quan |
| Queue/retry/compaction | Gần đủ | Steer/follow-up composer, queue count/modes, manual compact, auto retry/compaction và abort-retry | Còn cần renderer E2E cho interrupt/retry/compaction race |
| Plan/goal/modes | Gần đủ | Plan mode + approval; Goal snapshot/create/pause/resume/drop; Guided goal có dialog flow; Vibe toggle có RPC/UI và đồng bộ hidden goal/vibe tools | TUI-style loop còn chưa có parity riêng trong Electron |
| Workspace files | Đủ trong phạm vi GUI | Search/list/read, bounded preview, binary guard, containment, reveal, add context; Electron watcher theo từng window, debounce batch, bỏ qua `.git`/`node_modules`, tự refresh list/diff/status và file preview đang mở | Recursive watch fallback trên nền tảng không hỗ trợ chỉ theo dõi root-level; packaged E2E đa nền tảng nằm ở release gate |
| Context inspector | Gần đủ | File/selection/image/memory staging, remove trước khi gửi, staged estimate, authoritative `contextUsage` và breakdown system prompt/tools/system context/skills/messages, anchored/estimated state, compaction pressure | Quản trị record nằm trong Settings/Memory thay vì nhúng lại vào inspector |
| Git review | Gần đủ | Diff, stage/unstage, revert có confirm, commit, push, PR, worktrees | Chưa tách staged/unstaged diff rõ; auth/network diagnostics còn đơn giản; branch session chưa nối |
| Tools transcript | Đủ trong phạm vi built-in | `ToolView` chuyên biệt cho toàn bộ built-in hiện được desktop dùng, gồm checkpoint, rewind, memory_edit, learn và manage_skill; unknown extension tools vẫn có generic fallback an toàn | Không còn built-in đã biết phải dùng generic JSON card |
| Subagents | Đủ trong phạm vi GUI | Subscription + status list; transcript dạng message card, refresh tăng dần theo progress, giữ cursor, xử lý truncation reset/stale delta; phát hiện và preview `artifact://` qua bounded core RPC không lộ filesystem path | Packaged E2E cho transcript/artifact còn nằm ở release gate |
| Settings | Gần đủ | Providers/tools/MCP/plugins/skills/memory/retry/compaction; runtime-facing interaction/context/files/shell/tasks/model tabs | Expose 318/414 schema settings; secret/TUI-only settings remain intentionally hidden |
| Plugins | Đủ trong phạm vi GUI | List, install, update, uninstall, enable/disable; chọn từng manifest feature và reload runtime discovery; marketplace/source discovery, metadata, cài user/project, update/uninstall/enable theo scope; extension runtime errors vào toast/diagnostics | Thêm/xóa nguồn marketplace vẫn là thao tác quản trị CLI có chủ đích |
| MCP | Đủ trong phạm vi GUI | Status, reconnect, enable/disable, transport/tool count, credential availability; headless OAuth reauthorize qua `open_url`/manual code, managed-credential sign-out; redacted `lastError` và reconnect-breaker diagnostics | OAuth live-provider E2E cần credential thật nên nằm ở manual/release validation |
| Memory | Gần đủ | Backend health/capabilities, Hindsight API probe, search và record preview, lưu record, consolidate/clear có xác nhận, add/remove composer context; hỗ trợ đúng hành vi local/Hindsight/Mnemopi | Edit/delete từng record không phải capability chung của mọi backend; Mnemopi vẫn hỗ trợ qua `memory_edit`, Hindsight quản trị server-side qua backend UI |
| Skills | Gần đủ | Discovery details, warnings, reload, enable/disable; `learn` và `manage_skill` có renderer lifecycle chuyên biệt | Chưa có install/create/update lifecycle trực tiếp trong Settings; lifecycle hiện đi qua agent tool |
| Browser | Gần đủ | Tabs, open/navigate/back/forward/reload/close, snapshot, add context; core trả download policy `deny`; activity theo cả core tool events và Desktop RPC actions với running/done/error | Không embed page view trực tiếp vì browser core chạy headless; chưa có download approval vì policy hiện cố định deny |
| Host extensibility | Gần đủ | Wire bridge, persistent registry UI, four validated safe Electron handlers, approval dialog, cancellation, read-only `workspace://`, structured fallback errors | Chưa có arbitrary third-party handler SDK; registry intentionally limits actions to safe GUI operations |
| Extension UI | Gần đủ | select/confirm/input/editor, timeout response, notify, status, widgets, title, editor text, open URL, `launchUrl`, runtime error routing | RPC core chưa hỗ trợ header/footer/custom component/autocomplete; timeout UI còn giới hạn dialog |
| Side Chat | Gần đủ | Engine/session riêng, fork tạo session mới với `parentSession` lineage thật + bounded transcript seed, optional isolated worktree, Context Inspector riêng đã có | Multi-window/session polish vẫn còn |
| Scheduled Tasks | Một phần | CRUD, persistence, duplicate-run guard, retries, timeout, history, top-level `agent_end` outcome parsing | App phải đang chạy; chưa có cron/timezone |
| Diagnostics/release | Gần đủ | Redacted Electron log, in-app Diagnostics panel và JSON bundle export, packaged renderer/preload/diagnostics smoke, MSI extraction validation | macOS/Linux packaged release gates còn chờ CI runner |

Toàn bộ command core hiện có method trong `DesktopRpcClient`.

Composer hiện cho phép chọn `steer` hoặc `follow_up` khi session đang streaming; các queue policy
controls nâng cao vẫn nằm trong backlog.

## Settings gap

Core có 414 setting trong `SETTINGS_SCHEMA`; RPC Settings hiện expose 318 setting:

| Category Desktop | Số setting |
| --- | ---: |
| Providers | 39 |
| Tools | 205 |
| Retry | 2 |
| Compaction | 3 |
| Memory | 58 |
| MCP | 0 |
| Skills | 11 |

96 setting bị loại gồm cả ba loại:

- **Đúng khi loại:** secret/token/password và phần TUI-only như terminal cursor/status-line.
- **Cần UI Electron tương đương:** theme/display, default thinking, sampling, queue modes,
  notifications, speech, context promotion, compaction thresholds, TTSR.
- **Đã đưa vào Tools:** edit/read/LSP, bash/eval, browser/web search, async jobs,
  plan/goal, subagent/task isolation, worktree và per-tool enable flags.

`categoryFor()` hiện xếp runtime-facing UI tabs (interaction/context/files/shell/tasks/model/tools)
vào Tools; terminal-only appearance/status-line settings vẫn bị loại có chủ đích.

## Những khác biệt có chủ đích

Không cần sao chép nguyên xi các bề mặt chỉ có ý nghĩa trong terminal:

- Hardware cursor, ANSI status line, terminal image sizing và TUI keybindings.
- CLI administration như shell completions, benchmark và daemon command nội bộ.
- Header/footer React-like component của extension TUI; Electron cần API widget riêng.

Những phần này chỉ được coi là parity khi Electron có hành vi tương đương, không nhất thiết có
cùng UI hoặc cùng command.

Auto-update và installer validation vẫn để sau theo quyết định hiện tại. Chúng chỉ bắt đầu khi
các phase parity bên dưới hoàn tất.

## Backlog triển khai theo thứ tự

### P0 — Correctness và lifecycle

1. ✅ Phân biệt `aborted/cancelled` với `error` trong transcript; tool bị user hủy không render đỏ như
   lỗi nội bộ.
2. ✅ Thêm engine crash recovery có backoff và giới hạn restart loop.
3. ✅ Sửa Scheduled Tasks time type drift và chỉ ghi success khi assistant kết thúc thành công.
4. ✅ Sửa kiến trúc multi-window thành engine-per-window và route frame theo cửa sổ.
5. ✅ Đưa diagnostics snapshot vào UI và tạo diagnostics bundle có redaction.

### P1 — Core workflow surfaces

1. ✅ Nối `get_available_commands` + `available_commands_update` vào slash-command palette/autocomplete.
2. ✅ Hoàn thiện queue composer: steer/follow-up selector, queue counts và ba queue mode.
3. ✅ Nối manual compact, auto retry/compaction controls, abort retry và session stats trong Diagnostics.
4. ✅ Xây Branch/Fork, Export HTML và Handoff UI.
5. ✅ Thêm RPC/UI cho Goal lifecycle, guided goal flow và vibe toggle; loop parity còn nằm ở backlog.

### P2 — Extensibility và configuration

1. ✅ Nối host-tool/host-URI wire bridge, persistent safe host registry, approval policy, call/stream/cancel/result và structured fallback.
2. ✅ Nhận `extension_error`, hỗ trợ dialog timeout và OAuth `launchUrl`.
3. ✅ Mở rộng Settings cho các runtime setting quan trọng; tiếp tục chặn secret và TUI-only setting.
4. ✅ Hoàn thiện plugin marketplace, memory record lifecycle, plugin feature và MCP OAuth diagnostics.

### P3 — UI depth

1. ✅ Context Inspector dùng `contextUsage` và `getContextBreakdown()` authoritative theo system/tools/skills/messages.
2. ✅ Subagent drill-down, live incremental refresh và bounded artifact preview qua `get_subagent_messages` + `read_artifact`.
3. ✅ Thêm renderer chuyên biệt cho checkpoint, rewind, memory_edit, learn và manage_skill.
4. ✅ Filesystem watcher Electron và Browser activity/download-deny contract.
5. ✅ Side Chat fork có structured parent-session lineage, bounded transcript seed và worktree isolation; còn Context Inspector riêng.

### P4 — Release gate

1. ✅ Mở rộng smoke probe cho Marketplace, Memory và các RPC surface Desktop trọng yếu.
2. ✅ Thay static source-grep drift test bằng type-level contract giữa core/Desktop và runtime smoke.
3. Windows `win-unpacked` packaged E2E: ✅ renderer/preload/diagnostics/sidecar RPC; macOS/Linux còn chờ CI runner.
4. Windows NSIS/MSI build + MSI payload validation: ✅; signing và update feed vẫn để sau theo quyết định hiện tại.

## Definition of done cho mỗi feature

Một feature chỉ được đánh dấu “đã đưa vào Desktop” khi đủ tất cả:

1. Core command/event hoặc host contract tồn tại.
2. Desktop protocol mirror đúng payload.
3. `DesktopRpcClient` có method và phân loại lỗi.
4. Electron/React có UI hoặc host behavior sử dụng được.
5. State/reconnect/session switch không làm mất dữ liệu.
6. Có contract test cho hành vi quan sát được.
7. Sidecar smoke và packaged Electron smoke cùng pass.
