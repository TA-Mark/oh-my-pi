# Thiết kế: OMP Desktop App

Trạng thái: bản nháp (v1) · Nền tảng đích: **Windows 10/11 (x64)** và **macOS (Intel + Apple Silicon)** · Linux: best-effort.

## 1. Mục tiêu & phi mục tiêu

**Mục tiêu**

- Một ứng dụng desktop có GUI cho OMP, chạy đầy đủ trên Windows và macOS.
- Giữ **trọn vẹn** năng lực engine gốc: chat streaming, 32 tool, sessions/branching,
  subagents, đổi model/thinking, LSP/DAP, eval, web search... — không fork lại engine.
- Cô lập trong `packages/desktop/` để **sync upstream dễ** (xem `upstream-sync.md`).

**Phi mục tiêu (giai đoạn đầu)**

- Không viết lại engine bằng ngôn ngữ khác. Engine vẫn là Bun + TypeScript + native `.node`.
- Không thay thế TUI. Desktop là bề mặt thứ hai, song song TUI.
- Không hỗ trợ mobile (dù Tauri có thể) trong phạm vi v1.

## 2. Nguyên tắc thiết kế

1. **Additive** — gần như 100% code nằm trong `packages/desktop/`.
2. **Protocol-first** — GUI nói chuyện với engine qua **RPC mode** (`omp --mode rpc-ui`) và
   `@oh-my-pi/pi-wire`, **không** import sâu module nội bộ của `coding-agent`. Ranh giới này
   ổn định trước thay đổi upstream.
3. **Shell mỏng** — phần Rust (Tauri) chỉ làm 3 việc: spawn sidecar, bắc cầu stdio, giữ secret.
   Toàn bộ "logic sản phẩm" nằm ở frontend.
4. **Tái dùng, không vẽ lại** — mượn bộ tool renderer của `collab-web` thay vì dựng lại từ đầu.

## 3. Kiến trúc tổng thể

```
┌───────────────────────────────────────────────────────────────┐
│ Tauri App (1 process)                                          │
│                                                                │
│  ┌──────────────────────────┐        ┌──────────────────────┐ │
│  │ WebView (WebView2/WKWeb)  │        │ Rust core (src-tauri) │ │
│  │  React + Vite frontend    │        │                      │ │
│  │                           │        │  rpc.rs:              │ │
│  │  RpcClient ──send_rpc()──►│──IPC──►│   - spawn sidecar     │ │
│  │           ◄──event"rpc"───│◄──IPC──│   - đọc stdout (NDJSON)│ │
│  │  reducer(frame)→viewModel │        │   - ghi stdin (NDJSON) │ │
│  │  components (transcript,   │        │  keychain.rs (sau)    │ │
│  │  composer, tool cards…)    │        └───────────┬──────────┘ │
│  └──────────────────────────┘                    │ stdio       │
└───────────────────────────────────────────────────┼───────────┘
                                                     ▼
                                       ┌──────────────────────────┐
                                       │ omp sidecar               │
                                       │ `--mode rpc-ui`           │
                                       │ (bun binary + pi_natives) │
                                       │ = engine đầy đủ           │
                                       └──────────────────────────┘
```

Luồng dữ liệu:

- **Frontend → engine**: người dùng thao tác → `RpcClient` tạo `RpcCommand` (JSON) →
  Tauri command `send_rpc` → Rust ghi **một dòng JSON** vào stdin sidecar.
- **Engine → frontend**: sidecar phát **một dòng JSON** trên stdout (response / event /
  extension_ui / host_tool…) → Rust đọc theo dòng → emit Tauri event `rpc://frame` →
  `RpcClient` nhận → `reducer` cập nhật view model → React re-render.

## 4. Lựa chọn công nghệ

| Thành phần | Chọn | Lý do | Trade-off |
| ---------- | ---- | ----- | --------- |
| Shell | **Tauri v2** (cli 2.11.x) | Nhẹ, dùng WebView OS, đúng "gu" Rust của repo, binary nhỏ | WebView2 (Win) ≠ WKWebView (mac) → cần test render 2 bên |
| Frontend | **React 19 + Vite** | Đồng bộ `collab-web` để tái dùng `src/tool-render/` | Không dùng lại code SolidJS của nhánh desktop cũ (đã bỏ theo yêu cầu) |
| Bundler FE | Vite 8 (catalog) | Đã có trong workspace | — |
| Engine liên kết | **RPC sidecar** (`--mode rpc-ui`) | Cô lập tiến trình, protocol có sẵn & đã typed | Cần đóng gói binary engine theo từng nền tảng |
| Runtime build | Bun 1.3.14 | Chuẩn của repo; `bun build --compile` ra binary engine | — |

> Vì sao **không** nhúng engine bằng SDK (`createAgentSession`)? Vì shell Tauri chạy Rust,
> còn engine cần runtime Bun + addon `.node`. Chạy engine như **sidecar** là cách sạch nhất,
> đồng thời tách crash/đời sống tiến trình khỏi UI.

## 5. Sidecar & cầu nối (bridge)

### 5.1 Cách khởi chạy

- **Dev**: spawn engine từ source để nóng theo repo:
  `bun --cwd <repo>/packages/coding-agent src/cli.ts --mode rpc-ui` (đặt cwd = workspace người dùng chọn).
- **Prod**: spawn **sidecar binary** đóng kèm app (`omp`/`omp.exe`, đã `--compile` kèm `pi_natives`).
  Dùng cơ chế `externalBin` của Tauri (đặt tên theo target triple, ví dụ `omp-x86_64-pc-windows-msvc.exe`).

Cả hai dùng chung một hợp đồng, chỉ khác lệnh spawn → gói trong một hàm `resolve_sidecar_cmd()`.

### 5.2 Hợp đồng stdio (đã xác minh trong `modes/rpc/rpc-mode.ts`)

- Engine đọc **NDJSON** trên **stdin** (mỗi lệnh một dòng, có `type`, `id` tùy chọn để tương quan).
- Engine phát trên **stdout**: `{type:"response", command, success, data|error}`, các
  `AgentSessionEvent`, và frame tương tác `extension_ui_request` / `host_tool_call` / `host_uri_request`.
- `--mode rpc-ui` = như `rpc` nhưng bật thêm tool card, selector, dialog (đúng thứ GUI cần).
- Không dùng `--no-session` (ta muốn phiên được lưu như bình thường dưới `~/.omp`).

### 5.3 Vòng đời

- Mỗi **cửa sổ workspace** = một sidecar. Chọn/đổi thư mục làm việc = spawn lại (hoặc gửi `switch_session`).
- Đóng cửa sổ / thoát app → kill sidecar (và cây tiến trình con của nó).
- Sidecar chết bất thường → hiện banner, cho phép "khởi động lại engine".

## 6. Tầng protocol ở frontend

- `src/lib/rpc-protocol.ts`: type **local, standalone** mô phỏng
  `packages/coding-agent/src/modes/rpc/rpc-types.ts` (`RpcCommand`, `RpcResponse`) và
  `AgentEvent`. Giữ DOM-safe, type-check nhanh, không kéo engine vào bundle.
- **Chống drift (đã chốt qua thực nghiệm)**: phương án re-export `.ts` gốc bị **loại bỏ** —
  nó lôi toàn bộ đồ thị source `agent/` + `ai/` vào typecheck của desktop dưới `lib`/`module`
  không tương thích (hàng trăm lỗi giả: import `.md`, `toWellFormed`/es2024, DOM `MessageEvent`).
  Thay vào đó, hợp đồng protocol được kiểm ở **runtime** bởi `scripts/smoke-rpc.ts`: probe chạy
  engine thật, chờ `ready`, gửi `get_state` và assert shape response. Đúng triết lý AGENTS.md
  (runtime probe cho wiring không exercise được in-process, không grep/không couple source).
  Khi sync upstream, chạy smoke này để phát hiện đổi protocol.
- `src/lib/rpc-client.ts`: quản lý gửi command (kèm `id` tương quan qua `Promise`), nhận
  frame, phân loại response vs event vs UI-request.
- Ánh xạ tính năng → lệnh:

  | UI | RpcCommand |
  | --- | --- |
  | Composer gửi | `prompt` / `steer` / `follow_up` / `abort_and_prompt` |
  | Dừng | `abort` |
  | Chọn model | `get_available_models`, `set_model`, `cycle_model` |
  | Thinking | `set_thinking_level`, `cycle_thinking_level` |
  | Phiên | `new_session`, `switch_session`, `branch`, `set_session_name`, `export_html` |
  | Subagents | `set_subagent_subscription`, `get_subagents`, `get_subagent_messages` |
  | Bash nhanh | `bash`, `abort_bash` |
  | Đăng nhập | `get_login_providers`, `login` (+ `open_url` từ `extension_ui`) |
  | Slash command | `get_available_commands` |

## 7. Kiến trúc frontend

- **Tái dùng `collab-web` (đã làm ở Phase 3)**: import trực tiếp `ToolView` từ
  `@oh-my-pi/collab-web/src/tool-render` (40+ renderer, theme token `tv-`). Khảo sát cho thấy
  `ToolView` **host-agnostic** — nhận thẳng `{ name, args, result: {content, details, isError},
  running, intent, partial }`, và tool-render chỉ import `@oh-my-pi/pi-wire` + `react`
  (không node/Bun, không API ES2024 lạ). **Ẩn số adapter đã được hoá giải**: RPC phát
  `tool_execution_start/update/end` với `result` là `AgentToolResult` — đúng shape `ToolResultLike`
  của `ToolView`, nên chỉ cần map trường (reducer gom args/result/partial theo `toolCallId`),
  KHÔNG cần lớp dịch collab-frame. Điều kiện: `tsconfig` desktop dùng `lib ES2024` (khớp collab-web);
  re-export từ `coding-agent` vẫn cấm (làm ô nhiễm typecheck — xem §6).
- **Subagent panel (Phase 3)**: `set_subagent_subscription("progress")` khi ready; mỗi frame
  `subagent_lifecycle`/`subagent_progress` kích hoạt `get_subagents` (snapshot `RpcSubagentSnapshot`),
  render danh sách trạng thái. Cùng mẫu "frame → refresh get_X" như session state.
- **State**: `reducer(state, frame)` thuần (dễ test) → `viewModel` bất biến; React đọc qua
  `useSyncExternalStore` (giống pattern `GuestClient` của collab-web).
- **Components** (đặt trong `src/components/`): `AppShell`, `Transcript`, `Composer`,
  `ModelPicker`, `SessionHistory`, `SubagentPanel`, `CommandPalette`, `StatusBar`.

## 8. Xác thực & bí mật

- Engine đã tự quản credential qua `AuthStorage` (SQLite `~/.omp/agent/agent.db`) — desktop
  **không** cần lưu key. Với OAuth, engine phát `extension_ui_request { method: "open_url" }`;
  frontend mở URL bằng shell của Tauri.
- Luồng đăng nhập (**Phase 4: đã làm**): `LoginMenu` gọi `get_login_providers` → chọn provider →
  `login`; engine phát `open_url` (qua `extension_ui_request`) → desktop mở browser bằng
  `tauri-plugin-opener`. `login` giữ pending tới 600s, resolve khi OAuth callback xong → refresh
  providers/models/state. Provider cần nhập tay (API key…) sẽ báo lỗi (RPC không hỗ trợ headless).
- (Tùy chọn về sau) `keychain.rs`: lưu secret cấp app ở Keychain (mac) / Credential Manager (Win).

## 9. Đóng gói đa nền tảng (**Phase 5: đã làm** — chi tiết ở `packaging.md`)

- **Sidecar binary theo target**: `scripts/build-sidecar.ts` gọi `coding-agent` `build`
  (`bun build --compile`, embed `pi_natives`/mupdf/tool-views) rồi copy `dist/omp[.exe]` →
  `src-tauri/binaries/omp-<RUST_TRIPLE>[.exe]`. Hỗ trợ `CROSS_TARGET` + `SKIP_BUILD` (chỉ stage).
- `tauri.conf.json` khai báo `bundle.externalBin: ["binaries/omp"]`. Tauri **strip triple** khi
  bundle → đặt `omp[.exe]` cạnh app binary; `rpc.rs::resolve_engine_program` resolve `omp[.exe]`
  cạnh `current_exe` lúc runtime (fallback PATH; `OMP_ENGINE_ARGV` override cho dev).
- **Windows**: MSI (WiX) + NSIS. **Đã verify**: `tauri build --debug` tạo được cả hai
  (`OMP Desktop_0.1.0_x64_en-US.msi` 69MB, `..._x64-setup.exe` 54MB) với `omp.exe` (147MB) nhúng
  cạnh `omp-desktop.exe`. Ký Authenticode qua `bundle.windows` (cần chứng chỉ).
- **macOS**: `.app`/`.dmg`; `codesign` + **notarize** qua env `APPLE_*` (cần Apple Developer ID),
  build riêng `aarch64`/`x86_64` trên runner mac. (Không verify được trên máy Windows.)
- **CI**: `.github/workflows/desktop-release.yml` (matrix win/mac, tag `desktop-v*`).
- **Auto-update** (tùy chọn, chưa bật): Tauri updater + endpoint riêng — xem `packaging.md`.

## 10. Bảo mật

- **Capabilities Tauri tối thiểu**: chỉ cấp quyền cần (spawn sidecar đã khai báo, event, mở URL,
  đọc/ghi file khi cần). Không bật `shell:allow-execute` mở.
- Sidecar chạy **cục bộ qua stdio**, không mở cổng mạng → không lộ bề mặt tấn công qua socket.
- Engine có `bash`/`eval`/`browser`. `--mode rpc-ui` phát `extension_ui_request` cho các thao tác
  cần xác nhận; frontend **phải** hiện prompt phê duyệt (approval) thay vì auto-approve.
  Tôn trọng `tools.approvalMode` — đây là hàng rào an toàn, không được bỏ qua.
- **Phase 4: đã làm** — approval + prompt tool (`ask`) đều đi qua `ExtensionUIContext` (cùng
  `rpcUiContext` phía engine) dưới dạng `confirm`/`select`/`input`/`editor`. `DialogHost` render
  chúng thành modal và gửi `extension_ui_response` đúng shape (`{value}`/`{confirmed}`/`{cancelled}`).
  Không auto-approve: người dùng phải bấm. Frame `cancel` (engine hết chờ) → đóng modal, không phản hồi.

## 11. Cấu trúc thư mục package

```
packages/desktop/
├── package.json                # @oh-my-pi/desktop (private)
├── index.html
├── vite.config.ts
├── tsconfig.json
├── docs/
│   ├── upstream-sync.md
│   └── design.md               # (tài liệu này)
├── src/                        # frontend React
│   ├── main.tsx
│   ├── app.tsx
│   ├── styles.css
│   ├── env.d.ts
│   ├── lib/
│   │   ├── rpc-protocol.ts     # mirror rpc-types.ts (chống drift)
│   │   ├── rpc-client.ts       # gửi/nhận frame qua Tauri IPC
│   │   ├── tauri-bridge.ts     # bọc invoke/listen của Tauri
│   │   └── reducer.ts          # frame → viewModel
│   └── components/
│       ├── AppShell.tsx
│       ├── Transcript.tsx
│       └── Composer.tsx
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── binaries/               # (prod) sidecar theo target, gitignore
    ├── icons/
    └── src/
        ├── main.rs
        ├── lib.rs
        └── rpc.rs              # spawn + bridge stdio
```

## 12. Lộ trình theo phase

- **Phase 0 — Scaffold + bridge** *(đang làm ở Task 3)*: khung Tauri + React chạy được, bridge
  stdio thông, gửi `prompt` và nhận stream về hiển thị thô.
- **Phase 1 — Chat cơ bản**: transcript + markdown, streaming token, `abort`, trạng thái đang chạy.
- **Phase 2 — Model/Session**: model picker (`get_available_models`/`set_model`/`cycle`),
  thinking level, lịch sử phiên + `switch_session`/`branch`/rename.
- **Phase 3 — Tool cards & subagents**: adapter `AgentSessionEvent → tool-view`, dùng renderer
  của `collab-web`; panel subagent + transcript con.
- **Phase 4 — Tương tác & phê duyệt**: `extension_ui_request` (select/confirm/input/editor/notify),
  `host_tool`/`host_uri`, prompt phê duyệt tool nguy hiểm, đăng nhập OAuth.
- **Phase 5 — Đóng gói & phát hành ✅**: sidecar theo target + `externalBin`, MSI/NSIS (verified
  trên Windows) + DMG (CI mac), CI release workflow, tài liệu ký & notarize; auto-update để ngỏ.

## 13. Rủi ro & quyết định còn mở

- **Khác biệt WebView** giữa Windows/macOS: cần test sớm, tránh CSS/JS lệ thuộc engine trình duyệt.
- **Protocol chưa phủ 100% TUI**: một số bề mặt (plan mode chi tiết, panel DAP, một số slash cục bộ)
  có thể cần mở rộng RPC ở lõi — nếu bắt buộc, giữ thay đổi nhỏ và ghi vào `core-touchpoints.md`.
- **Render terminal (PTY)**: `bash` PTY hiển thị trong WebView cần `xterm`/`ghostty-web`
  (đã có trong catalog) — quyết định ở Phase 3/4.
- **Adapter event**: `collab-web` dựng theo frame collab, RPC theo `AgentSessionEvent`. Chi phí
  adapter là ẩn số lớn nhất về khối lượng — cần spike ở đầu Phase 3.
- **Universal vs 2 binary trên macOS**: chọn theo nhu cầu phát hành.
