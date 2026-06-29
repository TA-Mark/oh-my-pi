# Oh-My-Pi Desktop WebUI — Roadmap (synthesized from 6-agent survey, 2026-06-29)

## 1. Product North Star
Một cửa sổ Tauri desktop bọc `omp` CLI chính thống. Cài đặt qua đúng 5 one-liner README (không có installer tự chế giữa chừng). Sau cài, app spawn `omp --mode rpc-ui` và mirror toàn bộ trải nghiệm TUI trong WebView: chat streaming, 32 tool cards, slash palette, model picker, MCP, skills, plan mode, advisor. Wrapper **không bao giờ sửa source oh-my-pi** — update đi qua `omp update` hoặc user re-run installer.

## 2. Executive Summary
- Round 1 & 2 đã làm xong **bề mặt UX của installer** (5 method đúng, default path chuẩn, method-aware preflight, textbox installPath chỉ hiện cho `windows-irm`, `findOmp` dùng `where omp` + mise + linuxbrew).
- 6 surveyor (87 gap, 75 đề xuất action) chỉ ra còn **4 mảng vỡ lớn** trước khi sản phẩm dùng được:
  1. **p1-install**: bundled Bun (~98MB) + MinGit (~30MB) hiện là DEAD WEIGHT — bridge không đọc `OMP_BUNDLED_BUN`/`OMP_BUNDLED_GIT_DIR` mà Rust shell forward. Cần wire để installer .exe **thật sự self-contained** trên máy clean.
  2. **p2-launcher**: BLOCKER — `LauncherSupervisor` đang spawn `packages/collab-web/scripts/local-relay.ts` (collab feature) thay vì `omp` agent. Health probe dò port 8765 = collab relay, không phải omp. UI chưa gọi `detectOmp` để gate routing.
  3. **p3-chat-core**: Chat đang spawn `omp --mode rpc` (basic), không phải `--mode rpc-ui`. Thiếu extension_ui_request handler (= không có model picker, login dialog, MCP wizard từ omp), thiếu slash palette, Regenerate là fake (= abort). Tool view registry đã có 32 tool nhưng chưa được drive bởi đúng frame stream.
  4. **p4-features**: MCP registry KHÔNG TỒN TẠI trong codebase. Skills KHÔNG TỒN TẠI. Model picker hardcoded. Plan mode / advisor / hindsight chưa surface.

## 3. Target User Flow (end-to-end)
1. User tải `Oh-My-Pi Desktop_0.1.0_x64-setup.exe` (~99MB) → chạy → NSIS cài vào `%LOCALAPPDATA%\Programs\Oh-My-Pi Desktop\` (currentUser).
2. Mở app → Tauri main spawn `omp-bridge.exe` sidecar @127.0.0.1:8787 với env `OMP_BUNDLED_BUN/GIT_DIR/NATIVE`.
3. WebView load `tauri://localhost/index.html` → app.tsx gọi `/launcher/detect-omp`.
4. Lần đầu: `detect-omp.found = false` → route **InstallerPage**.
5. InstallerPage gọi `/installer/methods` → recommended = `bun-global` vì bundled Bun có trên PATH (sau khi p1 wire xong).
6. User click **Install** → bridge spawn `bun install -g @oh-my-pi/pi-coding-agent` dùng BUNDLED Bun → log stream → done. Card success hiển thị đúng `~/.bun/bin/omp.exe`.
7. User click **Continue** → route **LauncherPage** → `detect-omp.found = true` (omp version `3.20.1`).
8. LauncherPage hiển thị **Start chat** → bridge spawn `omp --mode rpc-ui` → handshake → ready.
9. Route **MainChatPage** → SessionList có 1 default session.
10. User gõ `"Hello"` + Ctrl+Enter → assistant text stream token-by-token vào 1 card.
11. User gõ `/mod` → command palette mở (từ `get_available_commands`) → chọn `/model` → omp emit extension_ui_request `select` → app hiển thị model picker dialog → user chọn → omp apply.
12. User mở **MCP** tab → thêm server `github` → bridge ghi `state/mcp.json` → omp reload-plugins.
13. App đóng → mở lại → session restore qua session-binding.
14. Sau khi omp release v3.20.2: Launcher's UpdateMaintenanceCard hiển thị badge → click **Update now** → bridge spawn `omp update` → restart sidecar.

## 4. Phases

### p1-install — Self-contained installer (effort: **L**)
**Goal**: Trên máy clean (không Bun, không Git), user cài được omp qua bất kỳ method nào KHÔNG phải re-download deps.

**Current state**:
- ✅ Round 1+2 done: UI 5 method, recommended từ `hasBun()`, default path `%LOCALAPPDATA%\omp`, method-aware preflight, textbox conditional.
- ❌ `installer.ts` route KHÔNG đọc `OMP_BUNDLED_BUN`/`OMP_BUNDLED_GIT_DIR` → child process chỉ thấy `process.env.PATH` của bridge → bundled deps vô dụng.
- ❌ `preflight.ts:checkBun/checkMise/checkBrew` shell-out với bare command name → không aware bundled.
- ❌ `checkGit` đã viết nhưng chưa từng được gọi (dead code) — `install.ps1 -Source` mode cần git.
- ⚠ `STEP_MARKERS` regex cuối có `|installed` bare alternation → match sai sớm (vd `bun is already installed`).
- ⚠ logFile được persist nhưng UI không show.
- ⚠ `/installer/jobs/:id/repair` là stub.

**Actions**:
1. **A1** `server.ts` startup: nếu `OMP_BUNDLED_BUN` set → prepend `dirname(OMP_BUNDLED_BUN)` vào `process.env.PATH`. Tương tự cho `OMP_BUNDLED_GIT_DIR`.
2. **A2** `preflight.ts:checkBun/checkGit/checkMise`: thử bundled path từ env vars trước, fallback PATH.
3. **A3** `checksForMethod(windows-irm, …)` → thêm `checkGit` (cần cho `Configure-BashShell` trong install.ps1).
4. **A4** Sửa `STEP_MARKERS` regex cuối: drop bare `installed`, đặt `bun\.exe|@oh-my-pi\/.*installed|omp installed`.
5. **A5** Plumb `logFile` qua state machine → render trong `InstallProgressCard` footer (`Copy path` + `Reveal in Explorer` qua Tauri shell.open).
6. **A6** Implement `/installer/jobs/:id/repair` thật: rerun job với cùng method + flag (vd `bun install -g --force`).
7. **Decision D1**: Drop MinGit (0 consumer), giữ hay drop bundled Bun.

**Acceptance**:
- Trên VM Windows clean (no Bun, no Git): chạy installer.exe → chọn `Bun (recommended)` → resolve Bun từ bundled → `bun install -g` → done.
- Chọn `Windows (PowerShell)`: install.ps1 thấy Bun trên PATH (bundled) → đi Bun branch → done KHÔNG re-download Bun.
- Chọn `mise` không cài mise → preflight fail trong <2s với fixHint.
- Log file path hiển thị; Copy + Reveal hoạt động.

---

### p2-launcher — Real omp launcher (effort: **L**)
**Goal**: Launcher detect omp, start/stop đáng tin cậy, route gate trên sự hiện diện của omp, workspace thật.

**Current state**:
- ✅ UI shell đầy đủ (RuntimeStatusCard, LaunchControlCard, WorkspaceCard, UpdateMaintenanceCard, DiagnosticsCard, LauncherLogDrawer).
- ❌ BLOCKER: `LauncherSupervisor.locateLaunchScript` spawn `collab-web/scripts/local-relay.ts` (collab feature) — không phải omp.
- ❌ BLOCKER: health probe = TCP port 8765 (collab relay), không phải omp.
- ❌ `LauncherPage` không gọi `detectOmp` trên mount → user thấy launcher kể cả khi omp chưa cài.
- ❌ Routing app.tsx dùng localStorage flag, không gate omp presence → user click `Continue` mở MainChat dù omp đã uninstall.
- ⚠ WorkspaceCard stub (1 entry cứng `default`).
- ⚠ UpdateMaintenanceCard stub (luôn `available:false`).

**Actions**:
1. **A1** Viết lại `LauncherSupervisor.locateLaunchScript` → dùng `findOmp()` resolve binary → spawn `omp <subcommand>` (subcommand quyết bởi **D3**).
2. **A2** Health probe: thay TCP-port bằng readiness check của omp (HTTP endpoint khi omp serve, hoặc periodic `omp --version`, hoặc thành công của RPC handshake).
3. **A3** `LauncherPage.tsx` on mount: gọi `detectOmp()`. Nếu `!found` → render recovery card "omp missing — Return to Installer".
4. **A4** `app.tsx` routing 2→3: re-verify `detectOmp + getRuntimeStatus.healthy` trước khi mount MainChat. Nếu fail → bounce về Launcher.
5. **A5** Workspace concept: persist `state.json` `workspaces` array `{id, name, path, lastOpenedAt, isActive}`. UI: add via Tauri dialog plugin folder picker; switch active.
6. **A6** DiagnosticsCard: real checks (omp version, bridge port free, disk space ≥1GB, write perm to omp.config dir).
7. **A7** UpdateMaintenanceCard: tích hợp với p5 actions.

**Acceptance**:
- Launcher hiển thị real `omp 3.20.1` từ `where omp`.
- Stop → omp process exits sạch; Start → spawn mới + health pass.
- Xóa omp khỏi PATH → Launcher tự cập nhật "omp missing" với CTA.
- Click MainChat khi omp đã xóa → bounce về Launcher (không crash).
- Add workspace từ folder dialog → list cập nhật với path tuyệt đối.

---

### p3-chat-core — Real RPC-UI chat (effort: **XL**)
**Goal**: WebUI là TUI replacement: render đúng mọi frame omp emit (text + thinking + tool calls + extension_ui_request).

**Current state**:
- ✅ Pipeline wired end-to-end: ChatComposer → RpcClient → WS `/chat/sessions/:id/rpc` → OmpSessionManager → OmpProcess(child) → omp child.
- ✅ Tool view registry maps đủ 32 tool (impressive!).
- ❌ BLOCKER: Spawn `omp --mode rpc` (basic NDJSON), KHÔNG phải `--mode rpc-ui` → mất extension_ui_request frames (model picker, login dialog, MCP wizard).
- ❌ Slash command palette KHÔNG TỒN TẠI (composer chỉ trim text + sendPrompt).
- ❌ `RpcClient.sendRegenerate = sendAbort` (fake) — Regen button gửi abort cho child idle (no-op).
- ❌ Plan mode + advisor không có UI (grep ra rỗng).
- ❌ `messageCount` của session không bao giờ tăng → UI hiển thị 0.
- ⚠ Optimistic user append trước khi `#send` confirm → khi WS rớt, user message lưu trữ sai.
- ⚠ Reconnect: replay buffer 64 envelope không đủ cho long stream.

**Actions**:
1. **A1** Đổi spawn args: `--mode rpc` → `--mode rpc-ui` (omp-process.ts).
2. **A2** Share TS types: copy `packages/coding-agent/src/modes/rpc/rpc-types.ts` → `collab-web/src/types/rpc-types.ts` qua build script (`scripts/sync-rpc-types.ts`).
3. **A3** Transcript renderer: AgentMessage render với content blocks (text, thinking, redactedThinking, toolCall + ToolResult, usage, stopReason badge).
4. **A4** Slash command palette: ChatComposer detect leading `/` → popup từ `get_available_commands` RPC response.
5. **A5** Implement Regenerate đúng: track `lastUserPrompt` trong RpcClient; on Regen → `abort_and_prompt` command.
6. **A6** Implement `extension_ui_request` handlers: select/confirm/input/editor/cancel — route response qua `extension_ui_response` frame.
7. **A7** Fix optimistic append: append chỉ sau khi `#send` returns true; show toast "Reconnecting…" nếu WS chưa OPEN; queue prompt.
8. **A8** Bridge listen frame `message_end` từ omp-manager → mutate sessions store (`messageCount++`, `lastActiveAt`).
9. **A9** Reconnect: bump replay buffer (256?) hoặc auto `get_state` on reconnect.

**Acceptance**:
- Verify omp spawn với `--mode rpc-ui` (Task Manager command line / Bridge log).
- Gõ `/he` → palette show `/help`, `/exit`, …
- Gõ `Hello` → text stream char-by-char vào card.
- Tool call `read README.md` → Read card với summary.
- `/model` → omp emit extension_ui_request `select` → app hiển thị picker → chọn → apply + persist.
- Tool long-running → click Stop → omp abort, status update.

---

### p4-features — MCP, Skills, Model picker, Plan mode, Advisor, Hindsight (effort: **L**)
**Goal**: Full feature surface mirror omp.

**Current state**:
- ✅ Tool views done (32 tool).
- ⚠ Model picker partial: `<select>` over hardcoded `AVAILABLE_MODELS` static array.
- ❌ MCP: 0 reference trong code (collab-web + bridge).
- ❌ Skills: 0 reference.
- ❌ Plan mode: 0 reference.
- ❌ Advisor pair: 0 reference.
- ❌ Hindsight (retain/recall/reflect): 0 reference.
- ⚠ DataSourcesPanel: decorative (chỉ render refresh button).
- ⚠ Sessions: không show messageCount/lastActiveAt, không rename inline.

**Actions**:
1. **A1** Model picker: bridge call omp `/model --json` hoặc đọc model manifest → group theo provider + auth status. Replace hardcoded array.
2. **A2** MCP registry:
   - Bridge: `GET/POST/DELETE /api/v1/mcp/servers` backed by `state/mcp.json`
   - UI: sidebar tab 'MCP' + add-server dialog (name, command, args, env)
   - On change: trigger omp `/reload-plugins` (via RPC command).
3. **A3** Skill registry:
   - Bridge: `GET /api/v1/skills` scan cwd cho `.omp/agent`, `.claude/skills`, `.cursor/rules`, `.windsurf/rules`, `.codex/AGENTS.md`, `.cline/.clinerules`
   - UI: sidebar tab 'Skills' với enable/disable + inheritance source.
4. **A4** Plan mode: extend `RuntimeConfig.mode` → `'plan'`. UserControlsPanel toggle. Plan card renderer mới trong tool-render.
5. **A5** Advisor pair: settings UI enable + chọn model. Transcript inline note card.
6. **A6** Hindsight: panel view retain/recall, manual `Save fact` button → omp `retain` command.
7. **A7** Sessions: inline rename, hiển thị messageCount/lastActiveAt (đã có A8 ở p3).

**Acceptance**:
- Model picker show full provider list (Anthropic, OpenAI, …) với auth badge.
- Add MCP `github` (command `npx mcp-server-github`) → `state/mcp.json` cập nhật → omp reload.
- Skills tab: list merged từ `.omp/agent` + `.claude/skills` với checkbox.
- Plan mode toggle → composer badge "Plan" → assistant emit Plan card.
- Advisor "concern" note hiện amber inline.

---

### p5-update — Update strategy (effort: **S**)
**Goal**: Update path nhất quán mà không "own" lifecycle của omp.

**Current state**:
- ✅ Round 1+2: Tauri updater plugin set `active:false` (vô hiệu hoá vì pubkey REPLACE_ME).
- ✅ `omp update` CLI đã tồn tại.
- ❌ `/update/check` route stub: luôn `available:false`.
- ❌ `/update/apply` route stub.

**Actions**:
1. **A1** Giữ Tauri updater disabled cho v0.1 (đã làm). Quyết định **D2** ảnh hưởng tới v0.2+.
2. **A2** `/update/check`: fetch `https://api.github.com/repos/can1357/oh-my-pi/releases/latest` → compare với `omp --version` từ `findOmp`. Cache 1 giờ.
3. **A3** `/update/apply`: spawn `omp update` → stream log qua WS giống installer job.
4. **A4** UpdateMaintenanceCard: badge "Update available: v3.20.1" với [Update now] / [Release notes] (link GitHub).
5. **A5** Sau khi update xong: restart omp child process (graceful stop + respawn với `--mode rpc-ui`).

**Acceptance**:
- Launcher hiển thị update badge khi GitHub latest > installed.
- Click Update now → bridge run `omp update` → log stream → success → restart → version mới.
- Skip update → badge persist, không nag.

---

### p6-polish — Productionize (effort: **M**)
**Goal**: Build shippable.

**Actions**:
1. **A1** Tauri updater signing key (nếu D2 chọn Tauri updater): generate + safeguard + CI sign.
2. **A2** Windows code sign (EV cert) → tránh SmartScreen.
3. **A3** macOS notarization (signing identity + provider).
4. **A4** Error boundary: bridge crash, omp crash, WebView2 crash — recovery UI + auto-restart.
5. **A5** Telemetry opt-in (anonymous error/crash reports).
6. **A6** Documentation: `docs/USER.md` setup, `docs/TROUBLESHOOTING.md`, `docs/FAQ.md`.
7. **A7** AV-friendly: code sign all bundled binaries.

**Acceptance**:
- Windows SmartScreen không warn trên signed .exe.
- macOS Gatekeeper pass notarized .dmg.
- Bridge crash → UI "Bridge crashed, restarting…" + auto-restart trong 3s.

---

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Bundled Bun (~98MB) vô dụng → installer dội size mà clean machine vẫn fail | p1 A1+A2: prepend vào PATH + checkBun aware bundled |
| R2 | Tauri updater pubkey REPLACE_ME → bật sẽ crash | Round 1+2 đã disabled; p6 A1 sinh key hoặc giữ disabled tài liệu hoá |
| R3 | Windows SmartScreen warning trên unsigned .exe | p6 A2 EV code sign |
| R4 | AV false positive trên bundled bun.exe | p6 A7 sign hoặc D1 drop bundled bun |
| R5 | RPC protocol drift giữa các version omp | p3 A2 share types qua sync script; lock omp version trong package.json catalog `@oh-my-pi/pi-coding-agent: 16.x` |
| R6 | macOS notarization phức tạp | p6 A3 setup pipeline; cho đến đó leave macOS unsupported (chỉ build Windows) |
| R7 | Session restore sau crash mất data | p3 A9 bump replay buffer + session-binding store sessionFile |
| R8 | WebView2 không có trên LTSC / old Win10 | tauri.conf.json đã set `webviewInstallMode: downloadBootstrapper` — verify trên VM clean |
| R9 | Bun version skew (bundled 1.3.14 vs system Bun cũ hơn) | p1 A1 prepend nên bundled win; document MIN_BUN_VERSION |
| R10 | Installer phồng size nếu giữ bundle | Đo lại sau D1; nếu giữ bundle, cân nhắc compressed installer (Lzma2) |

---

## 6. Open Decisions (cần quyết trước khi code)

### D1 — Bundled Bun + MinGit: keep hay drop?
- **A**: Drop cả 2 (~30MB installer, cần internet).
- **B**: Keep Bun, drop MinGit (~100MB installer, internet ưu tiên cho MinGit nếu cần).
- **C** ★: **Keep Bun, drop MinGit, wire Bun đúng (p1 A1+A2)**. Rationale: Bun có consumer rõ (bun-global + install.ps1 detect); MinGit 0 consumer (`OMP_BUNDLED_GIT_DIR` không được đọc bởi ai); `install.ps1 -Source` cần git nhưng kịch bản hiếm — user có thể tự cài Git for Windows nếu cần.

### D2 — Update strategy cho Tauri shell và omp
- **A**: Tauri updater (cần key + endpoint server).
- **B**: Re-run installer manual.
- **C** ★: **`omp update` cho omp + GitHub Releases link cho Tauri shell** (v0.1 ship). Rationale: rẻ, không phải maintain key + server; v0.2 cân nhắc Tauri updater.

### D3 — omp invocation mode
- **A**: Giữ `--mode rpc` (basic).
- **B** ★: **Đổi sang `--mode rpc-ui`** (extension frames). Rationale: BẮT BUỘC để có model picker, login, MCP wizard từ omp's own dialogs.

### D4 — Window model
- **A** ★: **Single window, SessionList trong sidebar** (như hiện tại). Rationale: clean, match TUI.
- **B**: Multi-window, mỗi session 1 Tauri webview. Rationale phụ: phức tạp, không match.

### D5 — Routing gate
- **A** ★: **Gate cứng — không vào chat nếu omp chưa detect**. Rationale: clean UX, recovery card rõ.
- **B**: Show degraded chat với inline install prompt. Rationale phụ: confusing.

### D6 — Local collab relay (`local-relay.ts`)
- **A**: Drop hẳn (chỉ chat features).
- **B** ★: **Keep as opt-in cho /collab feature tương lai**. Move out of LauncherSupervisor; start chỉ khi `/collab` được dùng. Rationale: vẫn có giá trị cho live session sharing nhưng không nên là default supervised process.

### D7 — Phase ordering
- **A**: Strict serial p1→p2→p3→p4→p5→p6 (low risk).
- **B** ★: **Parallel p1 + p3 (không phụ thuộc nhau), sau đó p2 (cần `detectOmp` chuẩn từ p1) → p4 → p5 → p6**. Rationale: tiết kiệm thời gian; p1 và p3 thao tác trên 2 area khác hẳn.

### D8 — Lock omp version
- **A**: Latest always (re-fetch).
- **B** ★: **Pin major (`16.x`) trong root package.json catalog**. Rationale: tránh RPC type drift; cho upgrade chủ động qua PR.

---

## 7. Effort Tổng
- p1: L (1-2 tuần)
- p2: L (1-2 tuần)
- p3: XL (2-4 tuần — RPC-UI rewrite + 32 tool view consolidation)
- p4: L (1-2 tuần)
- p5: S (3-5 ngày)
- p6: M (1 tuần)
- **Tổng**: 7-12 tuần FT, có thể parallel p1+p3 để rút xuống 6-10 tuần.

---

## 8. Source data
- `.plan-research/surveys-raw.jsonl` — 6 raw survey results (JSON)
- `.plan-research/survey-{installer,launcher,chat,features-mockup,omp-cli-surface,update-bundle}.json` — split per area
- `.plan-research/all-surveys.json` — gộp 6 surveys (82KB)
- Workflow ID: `wf_c2ee2cc0-838` (synth agent stall vì prompt+schema quá lớn — đã synthesize tay từ cached survey results)
