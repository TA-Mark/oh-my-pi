# Desktop App Changelog

## 2026-06-30 — Feature Parity Release

### Provider System
- Synced bridge provider catalog with OMP upstream (63+ providers)
- Fixed 15 coding-plan providers missing envVars (Paste API Key now works)
- Fixed 6 wrong envVar names (nanogpt, qwen-portal, umans, etc.)
- Fixed 3 provider type classifications (wafer→oauth, ollama-cloud→oauth, qwen-portal→coding-plan)
- Added search bar to Providers tab
- After saving API key, sessions auto-restart to pick up new credentials

### Model & Controls
- `/model` now opens interactive model picker dialog
- `/switch` opens cross-provider model picker
- `set_model` / `set_thinking_level` responses now trigger state refresh
- All Controls tab settings (steering, follow-up, interrupt, auto-compaction, auto-retry) now refresh state on change
- Added `config_update` event handler for real-time model/thinking updates

### Editor (ChatComposer)
- Multi-line input: Shift+Enter inserts newline
- Clipboard image paste: Ctrl+V reads image from clipboard
- Drag-and-drop: images attach, text files insert as @reference
- `@file` fuzzy autocomplete: type @ to search project files
- `!cmd` shell escape: runs via bridge shell, injects output into OMP context
- `!!cmd` hidden shell: runs without adding to context
- `$code` / `$$code` Python escape: wraps as python3 -c
- Prompt history: ArrowUp/Down cycles saved prompts, persisted to disk
- Keyboard shortcuts: Enter=steer, Ctrl+Enter=follow-up, Escape=abort (when busy)

### Slash Command Intercepts
- `/model` — interactive model picker
- `/switch` — cross-provider model switch
- `/login` — provider login selector
- `/logout` — opens Providers tab
- `/branch` `/fork` `/tree` — branch navigation picker
- `/new` — create new session
- `/resume` — open Sessions tab
- `/settings` — open Controls tab

### Connection Stability
- Health check: sync PATH scan (no child process spawn), cached 120s
- `findOmp()` timeout added (5s for where.exe)
- LauncherSupervisor poll interval 4s → 15s
- UI health gate poll 15s → 20s, threshold 3 → 8 (160s tolerance)
- Reconnect now properly restarts OMP process (activateSession instead of client.connect)
- Mode banner: shows plan/loop/goal/compacting status from statusEntries

### Bridge Endpoints (new)
- `POST /chat/sessions/:id/bash` — shell execution with context injection
- `GET /chat/files/search?q=...` — workspace file search for @autocomplete
- `GET /chat/history` + `POST /chat/history` — prompt history persistence

### Removed
- Sources tab (stub with no backend — use /mcp in chat instead)
