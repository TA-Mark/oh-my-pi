# @oh-my-pi/desktop-bridge

Local HTTP + WebSocket bridge that backs the desktop WebUI shipped in
[`packages/collab-web`](../collab-web). The React UI calls
`http://localhost:8787/api/v1/...`; this package serves those routes.

The bridge intentionally **does not import oh-my-pi core**. It is a thin
orchestration layer that:

- runs system preflight checks (git, network, disk, port, write perms),
- spawns the existing `scripts/desktop-webui-install.ps1` (Windows) /
  `scripts/desktop-webui-install.sh` (future) installer as a tracked job and
  streams its stdout over WebSocket,
- supervises the omp runtime process (start/stop/restart/health probe),
- persists chat sessions, data-source descriptors, and runtime config to a
  JSON file under `%LOCALAPPDATA%\omp-desktop\state\`.

## Run

```sh
bun run src/server.ts            # default port 8787
bun run src/server.ts --port 9000
```

## Smoke test

```sh
bun run scripts/smoke.ts
```

Hits `GET /api/v1/health` and prints the response.

## Endpoint map

See `src/routes/` — one file per feature area. The frontend type contracts
that this server must satisfy live in:

- `packages/collab-web/src/features/installer/types/installer.ts`
- `packages/collab-web/src/features/launcher/types/launcher.ts`
- `packages/collab-web/src/features/chat/types/chat.ts`

## Storage

State is kept in `<installDir>/state/`:

- `sessions.json` — chat sessions (id, name, link)
- `data-sources.json` — registered data sources
- `runtime-config.json` — model / mode / thinking / maxTokens
- `service.json` — last known omp PID + port for restart resilience
