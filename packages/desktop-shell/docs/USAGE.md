# Oh-My-Pi Desktop — User Guide

Oh-My-Pi Desktop wraps the full OMP coding agent in a native desktop app (Tauri + React).
All 32 OMP tools, 63+ providers, and 20+ slash commands work out of the box.

## Architecture

```
Tauri Shell (Rust)  → launches desktop-bridge sidecar
Desktop Bridge (Bun) → spawns OMP child processes per session, HTTP + WS on :8787
WebUI (React)        → renders in Tauri WebView, talks to bridge
```

Three packages, all under `packages/`:
- `desktop-shell/` — Tauri Rust wrapper (window, sidecar lifecycle)
- `desktop-bridge/` — Bun HTTP/WS server (session mgmt, shell exec, file search, provider catalog)
- `collab-web/` — React UI (transcript, composer, sidebar, dialogs)

**Rule:** never modify OMP upstream packages. All desktop features are implemented via the bridge layer or client-side intercepts.

---

## Getting Started

### Build

```sh
cd packages/desktop-shell
bun run build
```

Output:
- `src-tauri/target/release/omp-desktop-shell.exe` (direct run)
- `src-tauri/target/release/bundle/nsis/Oh-My-Pi Desktop_0.1.0_x64-setup.exe` (installer)

### Dev mode

```sh
cd packages/desktop-shell
bun run dev
```

### Requirements

- Bun >= 1.3.14
- Rust toolchain (for Tauri)
- `omp` installed and on PATH (or in `~/.bun/bin/`)

---

## App Flow

1. **Installer** — first launch checks/installs OMP CLI
2. **Launcher** — runtime health check, workspace selection, update management
3. **Main Chat** — the coding agent session

---

## Editor (Chat Composer)

### Input

| Action | Key / Gesture | What it does |
|---|---|---|
| Send prompt | **Enter** | Sends to OMP agent |
| Newline | **Shift+Enter** | Inserts newline (multi-line prompts) |
| Steer (mid-turn) | **Enter** (while agent busy) | Course-correct the running turn |
| Follow-up (queue) | **Ctrl+Enter** (while agent busy) | Queue message for after current turn |
| Abort | **Escape** (while agent busy) | Stop current agent turn |
| History previous | **ArrowUp** (empty editor) | Cycle through prompt history |
| History next | **ArrowDown** (in history mode) | Cycle forward |

### File References

Type `@` followed by a filename — a dropdown appears with fuzzy-matched project files.
Press **Tab** or **Enter** to accept. OMP automatically reads the file content and inlines it into the prompt context.

Example: `@src/server.ts explain this file`

### Image Attachments

| Method | How |
|---|---|
| **Ctrl+V** | Paste image from clipboard |
| **Drag & drop** | Drag image file from OS file manager into the composer |
| **File picker** | Click the 📎 button |

Non-image files dropped into the composer are inserted as `@filename` references.

### Shell Escapes

| Prefix | Behavior |
|---|---|
| `!command` | Run shell command. Output streams to chat AND is added to OMP context (agent sees it). |
| `!!command` | Run shell command silently. Output shown to you but NOT added to agent context. |

The bridge spawns a real shell process (PowerShell on Windows, bash on Linux/macOS).

### Python Escapes

| Prefix | Behavior |
|---|---|
| `$code` | Run Python code via `python3 -c`. Output shown and added to context. |
| `$$code` | Run Python code silently. Output NOT added to context. |

### Slash Commands

Type `/` to open the command palette. All OMP slash commands work:

**Intercepted by desktop (interactive UI):**

| Command | What it does |
|---|---|
| `/model` | Interactive model picker dialog |
| `/switch` | Switch to a different provider's model |
| `/login` | Provider login selector |
| `/logout` | Provider logout (opens Providers tab) |
| `/branch` `/fork` `/tree` | Branch navigation picker |
| `/new` `/drop` | Create new session (drop deletes current first) |
| `/resume` | Open Sessions tab |
| `/settings` | Open Controls tab |
| `/extensions` `/status` `/agents` | Open Controls tab |
| `/retry` | Regenerate last response |
| `/handoff [focus]` | Hand off session context |
| `/collab` `/join` `/share (collab)` `/leave` | Redirect to OMP CLI (collab requires terminal) |

**Native OMP (text-mode, passed through to agent):**

| Command | What it does |
|---|---|
| `/model <provider/id>` | Set model directly by ID |
| `/fast [on\|off]` | Toggle fast/priority mode |
| `/compact [focus]` | Compact session context |
| `/goal [subcommand]` | Goal mode (set/show/pause/resume/drop/budget) |
| `/plan [prompt]` | Plan mode |
| `/loop [count\|duration] [prompt]` | Loop mode |
| `/force <tool> [prompt]` | Force next turn to use specific tool |
| `/usage` | Provider usage and rate-limit headroom |
| `/context` | Token-budget breakdown |
| `/todo [subcommand]` | Todo list (edit/copy/export/import/append/start/done/drop) |
| `/mcp [subcommand]` | MCP server management |
| `/ssh [subcommand]` | SSH host management |
| `/rename <title>` | Rename session |
| `/move <path>` | Move session to different working directory |
| `/shake [mode]` | Prune conversation |
| `/export [path]` | Export transcript as HTML |
| `/dump` | Copy session transcript to clipboard |
| `/share` | Upload session as encrypted link or gist |
| `/memory [subcommand]` | Hindsight memory (view/clear/rebuild/enqueue) |
| `/advisor [on\|off\|status]` | Advisor model mode |
| `/browser [headless\|visible]` | Browser tool mode |
| `/marketplace [subcommand]` | Plugin marketplace management |
| `/plugins [list\|enable\|disable]` | View and manage installed plugins |
| `/reload-plugins` | Reload all plugins |
| `/jobs` | Background jobs status |
| `/tools` | Show tools visible to agent |
| `/changelog [full]` | Show changelog entries |
| `/session [info\|delete]` | Session info or delete |
| `/btw <question>` | Ephemeral side question (pass-through) |
| `/tan <work>` | Background agent work (pass-through) |
| `/omfg <complaint>` | Forge TTSR rule (pass-through) |
| `/memory [view\|clear\|enqueue\|mm ...]` | Memory management (local/Hindsight) |

### Controls tab — Model Roles

OMP uses **model roles** (default/smol/slow/plan/commit/advisor/...) to route different
types of work to different models. The Controls tab provides:

- **Model picker** — select any authenticated model
- **Cycle Model** button — cycles through configured role models (equivalent to Ctrl+P in TUI)
- **Cycle Thinking** button — cycles thinking level (equivalent to Shift+Tab in TUI)

Configure roles in `~/.omp/agent/config.yml`:
```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol:    anthropic/claude-haiku-4-5
  slow:    anthropic/claude-opus-4-6:high
  plan:    openai/gpt-5.3-codex:high
  commit:  anthropic/claude-haiku-4-5
```

### Memory & Compaction

All memory features work via OMP:

- `/memory view` — show injected memory payload
- `/memory clear` — delete project memory
- `/memory enqueue` — force consolidation
- `/memory mm list|show|refresh|seed|delete` — manage Hindsight mental models
- `/compact [focus]` — manual context compaction
- Header **Compact** button — same as `/compact`
- Controls tab **Auto-compaction** toggle — automatic compaction on overflow

---

## Sidebar Tabs

### Controls

Runtime settings — all changes take effect immediately:

- **Model picker** — dropdown grouped by provider, shows context window + cost
- **Thinking level** — off / minimal / low / medium / high / xhigh
- **Queue behaviour** — steering mode, follow-up mode, interrupt mode
- **Auto-compaction** — toggle automatic context compaction
- **Auto-retry** — toggle retry on provider errors

### Providers

Full catalog of 63+ LLM providers, grouped by type:

- **OAuth** — sign in with provider account (Anthropic, Google, xAI, etc.)
- **API Key** — paste an API key (OpenAI, DeepSeek, Groq, etc.)
- **Coding Plans** — subscription login (Cursor, GitHub Copilot, Kimi, etc.)
- **Local** — self-hosted (Ollama, LM Studio, vLLM, llama.cpp)

Each provider shows: current auth status, env var name(s), Sign In button and/or Paste API Key form.

**Search bar** at the top filters by name, ID, or description.

After saving an API key, running sessions restart automatically so OMP picks up the new credentials.

### Todos

Read-only view of the session's todo phases. Populated by the agent via `/todo` commands. Shows: phase name, task status icons (pending/in_progress/completed/abandoned), and progress counts.

### Sessions

Create, switch, rename, and delete chat sessions. Each session runs its own OMP child process with independent context.

---

## Header Bar

- **Session title** — click to rename inline
- **Stats chips** — total tokens, cost, turn count (polls every 10s)
- **Branches** — view and switch branch points
- **Compact** — trigger manual context compaction
- **Export** — export transcript as HTML
- **Logs** — toggle log drawer (OMP stdout/stderr)

---

## Mode Banners

When plan mode, loop mode, goal mode, or compaction is active, a colored banner appears above the connection bar showing the current mode status.

---

## Connection & Health

- **Runtime OK** — OMP binary found, bridge healthy
- **Runtime warning** — transient health check failure (self-recovers)
- **Reconnect** — button appears when WS disconnects; click to restart session

Health gate requires 8 consecutive failures (160+ seconds) before bouncing to launcher. Single transient failures are tolerated.

---

## Known Limitations

| Feature | Limitation | Reason |
|---|---|---|
| `@file` autocomplete | No fuzzy scoring, simple substring match | Bridge uses Bun.Glob (fast but basic) |
| `!cmd` streaming | Output shown after completion, not real-time | Bridge HTTP endpoint is request/response |
| `$code` Python | Wraps as `python3 -c`, no persistent kernel | OMP RPC doesn't expose eval endpoint |
| `!!`/`$$` hidden | Output excluded by not sending to OMP, not by excludeFromContext flag | RPC bash command lacks the flag |
| `/collab` sharing | Not available | Requires relay server infrastructure |
| `/aside` ephemeral agent | Not available | Needs dedicated sub-session UI |

---

## File Map

```
packages/
  desktop-shell/              Tauri wrapper
    src-tauri/
      src/lib.rs              App entry — spawn bridge, show window
      src/bridge.rs           Sidecar/script spawn + health probe
      tauri.conf.json         Window config, CSP, bundle targets

  desktop-bridge/             Bun HTTP + WS server
    src/server.ts             Main server — HTTP routes + WS dispatch
    src/routes/chat.ts        Sessions, keys, providers, bash, file search, history
    src/routes/launcher.ts    Health check, update, diagnostics
    src/routes/installer.ts   Install wizard
    src/lib/provider-catalog.ts  63+ provider entries (synced from OMP upstream)
    src/lib/omp-process.ts    OMP child process spawn + NDJSON protocol
    src/lib/omp-manager.ts    Per-session OMP process lifecycle
    src/lib/omp-detect.ts     Find omp binary (sync PATH + known locations)
    src/lib/shell-exec.ts     Shell command spawn for ! escapes
    src/lib/prompt-history.ts Capped prompt history persistence
    src/lib/api-keys.ts       API key storage (encrypted at rest)

  collab-web/                 React WebUI
    src/app.tsx               Top-level router (Installer → Launcher → Chat)
    src/lib/rpc-client.ts     RPC over WS — maps OMP events to React state
    src/lib/chat-client.ts    Shared interface for RPC/collab transports
    src/lib/slash-intercept.ts Client-side TUI command reimplementation
    src/features/chat/
      pages/MainChatPage.tsx  Chat orchestrator
      components/
        ChatComposer.tsx      Editor — input, @autocomplete, paste, drag-drop, history
        ConnectionStatusBar.tsx Health + mode banner
        ProviderSettings.tsx  Provider catalog with search
        UserControlsPanel.tsx Model picker, thinking, queue settings
        SessionList.tsx       Session management
        TodosPanel.tsx        Todo phases view
        LeftSidebar.tsx       Tab navigation
        ExtensionDialog.tsx   Select/confirm/input/editor modals
        SessionHeaderActions.tsx Rename, stats, branches, compact, export
    src/components/transcript/
      Transcript.tsx          Message + tool card rendering
      ToolCard.tsx            Per-tool expand/collapse cards
```
