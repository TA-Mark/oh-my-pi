# Desktop WebUI — Runbook & Deployment Guide

> **Scope**: Desktop WebUI wrapper cho oh-my-pi. Không sửa core logic. Windows-first.

---

## Architecture tổng quan

```
[Desktop WebUI — React SPA]
        │
        ├── Installer phase   → clone + setup oh-my-pi từ GitHub
        ├── Launcher phase    → kiểm tra health runtime, start/stop service
        └── Main Chat phase   → chat UI kết nối qua GuestClient WS
                                    │
                            [oh-my-pi runtime]  ← không bị sửa
```

---

## Prerequisites (Windows)

| Tool | Version | Lệnh kiểm tra |
|------|---------|---------------|
| [Bun](https://bun.sh) | ≥ 1.3.14 | `bun --version` |
| Git | any recent | `git --version` |
| Node (optional fallback) | ≥ 20 | `node --version` |

---

## Cài đặt và chạy (Development)

```powershell
# 1. Clone repo
git clone git@github.com:myorg/oh-my-pi-desktop.git
cd oh-my-pi-desktop

# 2. Cài deps (từ root monorepo)
bun install

# 3. Dev server
cd packages/collab-web
bun run dev
# → http://localhost:5173
```

Lần đầu mở, app sẽ hiển thị **Installer screen** vì chưa có `omp.desktop.installed` trong localStorage.

---

## Routing Flow

```
localStorage.omp.desktop.installed = "1"?
    NO  → InstallerPage  (clone oh-my-pi từ GitHub)
    YES
        localStorage.omp.desktop.launcher.entered = "1"?
            NO  → LauncherPage  (start/health-check runtime)
            YES → MainChatPage  (chat UI)

Deep-link hash (#room...#key)? → bypass cả 3, vào ConnectScreen cũ
```

---

## Reset về Installer

```javascript
// Trong browser console:
localStorage.removeItem("omp.desktop.installed");
localStorage.removeItem("omp.desktop.launcher.entered");
location.reload();
```

---

## Build Production Bundle (Windows)

```powershell
cd packages/collab-web
bun run build
# Output: packages/collab-web/dist/
```

Bundle được copy vào `dist/` với asset hashing. `dist/index.html` là entry point.

---

## Chạy Tests

```powershell
cd packages/collab-web

# Chạy tất cả tests
bun test --parallel

# Chỉ desktop WebUI tests
bun test test/installer-state-machine.test.ts
bun test test/launcher-state-machine.test.ts
bun test test/chat-state-machine.test.ts
bun test test/launcher-health-gate.test.ts

# Type check
bun run check:types
```

---

## API Bridge Server (local)

Desktop WebUI giao tiếp với oh-my-pi runtime qua bridge server chạy local.

```powershell
# Start mock bridge (dev only)
cd packages/collab-web
bun run mock-host
# → WS server tại ws://localhost:8765

# Start local relay (production)
bun run relay
```

### API Endpoints (bridge server)

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/installer/preflight` | GET | Kiểm tra git, network, disk, perms |
| `/installer/install` | POST | Bắt đầu cài đặt, trả về `jobId` |
| `/installer/status/{jobId}` | GET | Tiến trình cài đặt |
| `/installer/cancel/{jobId}` | POST | Huỷ cài đặt |
| `/launcher/status` | GET | Health check runtime |
| `/launcher/start` | POST | Start oh-my-pi service |
| `/launcher/stop` | POST | Stop service |
| `/chat/sessions` | GET | Danh sách sessions |
| `/chat/sessions` | POST | Tạo session mới |
| `/chat/sessions/{id}` | DELETE | Xoá session |
| `/chat/sources` | GET | Data sources |
| `/chat/sources/{id}/refresh` | POST | Refresh data source |
| `/chat/runtime-config` | GET/PATCH | Cấu hình model, mode, thinking |

---

## WebSocket Streaming

Chat sử dụng `GuestClient` từ `packages/collab-web/src/lib/client.ts`:

```typescript
const client = new GuestClient(sessionLink, "desktop-user");
client.connect();

// Subscribe to state changes (React useSyncExternalStore pattern)
const unsubscribe = client.subscribe(() => {
  const snapshot = client.getSnapshot();
  // snapshot.phase: 'connecting' | 'live' | 'ended'
  // snapshot.stream: partial streaming message
  // snapshot.entries: full message history
});
```

### Connection States

| Phase | Màu | Mô tả |
|-------|-----|-------|
| `connecting` | 🟡 yellow | Đang kết nối WS |
| `live` | 🟢 green | Connected, có thể chat |
| `ended` | 🔴 red | WS đóng, cần reconnect |

---

## Launcher Health Gate

`useLauncherHealthGate` poll `/launcher/status` mỗi **15 giây**.

- Nếu unhealthy → `ConnectionStatusBar` hiện cảnh báo + nút "Go to Launcher"
- Không tự redirect — user chủ động quyết định

---

## CI Pipeline

File: `.github/workflows/desktop-webui-ci.yml`

| Job | Runner | Trigger |
|-----|--------|---------|
| `typecheck` | windows-latest | push/PR to features/** |
| `unit-tests` | windows-latest | sau typecheck |
| `build` | windows-latest | sau unit-tests |
| `lint` | ubuntu-latest | parallel |
| `feature-gate-check` | ubuntu-latest | smoke test routing |

---

## Folder Structure

```
packages/collab-web/src/features/
├── installer/
│   ├── api/installerApi.ts          REST adapter
│   ├── components/                  UI components
│   ├── hooks/useInstallerStateMachine.ts
│   ├── pages/InstallerPage.tsx      Entry screen
│   └── types/installer.ts           TS contracts
├── launcher/
│   ├── api/launcherApi.ts
│   ├── components/                  Health/Control/Diag/Log panels
│   ├── hooks/useServiceStateMachine.ts
│   ├── pages/LauncherPage.tsx
│   └── types/launcher.ts
└── chat/
    ├── api/chatApi.ts
    ├── components/                  Sidebar, Composer, StatusBar
    ├── hooks/useChatStateMachine.ts
    ├── hooks/useLauncherHealthGate.ts
    ├── pages/MainChatPage.tsx       Main orchestration
    └── types/chat.ts
```

---

## Ràng buộc quan trọng

> ⚠️ **Desktop WebUI là wrapper chỉ đọc/điều khiển.** Không bao giờ import hoặc sửa các packages `@oh-my-pi/pi-*` (trừ type-only từ `@oh-my-pi/pi-wire`). Mọi communication đều qua bridge server local hoặc GuestClient WS.

---

## Troubleshooting

### App kẹt ở Installer
```javascript
localStorage.setItem("omp.desktop.installed", "1");
location.reload();
```

### App kẹt ở Launcher
```javascript
localStorage.setItem("omp.desktop.launcher.entered", "1");
location.reload();
```

### WS không kết nối được
1. Kiểm tra bridge server đang chạy: `bun run mock-host`
2. Kiểm tra port 8765 không bị block bởi firewall Windows
3. Nhìn tab `ConnectionStatusBar` — phase sẽ hiển thị `connecting` hoặc `ended`

### Build lỗi TypeScript
```powershell
bun run check:types 2>&1 | head -50
```
