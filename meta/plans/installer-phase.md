---
SECTION_ID: plans.installer-phase
TYPE: note
---

# Installer Phase Plan (Windows-first, collab-web wrapper)

## Scope guard
- Do **not** modify `oh-my-pi` core logic.
- Implement wrapper-only installer orchestration in desktop WebUI layer.
- Target frontend module: `packages/collab-web`.

## Day 1 goals
1. Establish installer domain contracts (TS types + OpenAPI draft).
2. Scaffold installer feature structure in `packages/collab-web/src/features/installer`.
3. Prepare state model for next integration step.

## Deliverables (Day 1)
- `packages/collab-web/src/features/installer/types/installer.ts`
- `packages/collab-web/src/features/installer/api/openapi.installer.json`
- Initial plan/progress tracking in this file.

## Contract boundaries
- Preflight checks: git, source validation, disk, deps, port.
- Install lifecycle: idle → checking → ready → installing → success → failed → cancelled.
- Progress + log streaming compatible payloads.
- Retry/cancel/repair action contracts.

## Progress log
- [x] Audit frontend module path (`packages/collab-web`)
- [x] Create installer phase plan
- [x] Create TS contracts skeleton
- [x] Add OpenAPI installer contract draft
- [x] Wire contracts into UI state machine (useInstallerStateMachine.ts)
- [x] Wire contracts into API client (installerApi.ts — REST + WS)
- [x] Build UI blocks (SourceSetupCard, PreflightChecklistCard, InstallProgressCard, InstallerActionBar, installer.css)
- [x] Build InstallerPage orchestration
- [x] Wire InstallerPage into app.tsx routing

## Risks / notes
- Desktop runtime command bridge might vary by host shell (PowerShell / CMD) — Windows-first.
- Source validation policy (official remote) should be configurable, not hardcoded.
- Log streaming via WS or SSE — to be decided in Day 2 based on collab-web transport layer.

## State machine
```
IDLE -> CHECKING -> CHECK_FAIL | READY
READY -> INSTALLING -> SUCCESS | FAILED | CANCELLED
FAILED -> INSTALLING (retry)
CANCELLED -> IDLE
```

## Next (Day 2)
- Implement useInstallerStateMachine hook.
- Implement installerApi.ts (REST + WS/SSE adapter).
- Build UI blocks: SourceSetupCard, PreflightChecklistCard, InstallProgressCard, InstallerActionBar.
- Connect InstallerPage into app routing.

## Launcher Phase ✅ DONE (all on disk, unstaged)

### Files created
- packages/collab-web/src/features/launcher/types/launcher.ts
- packages/collab-web/src/features/launcher/api/launcherApi.ts
- packages/collab-web/src/features/launcher/hooks/useServiceStateMachine.ts
- packages/collab-web/src/features/launcher/components/launcher.css
- packages/collab-web/src/features/launcher/components/RuntimeStatusCard.tsx
- packages/collab-web/src/features/launcher/components/LaunchControlCard.tsx
- packages/collab-web/src/features/launcher/components/WorkspaceCard.tsx
- packages/collab-web/src/features/launcher/components/UpdateMaintenanceCard.tsx
- packages/collab-web/src/features/launcher/components/DiagnosticsCard.tsx
- packages/collab-web/src/features/launcher/components/LauncherLogDrawer.tsx
- packages/collab-web/src/features/launcher/pages/LauncherPage.tsx
- packages/collab-web/src/app.tsx (modified — wired routing step 2: Installer → Launcher → Chat)

### Routing flow (gated)
Installer → Launcher (start/stop/diag) → Main Chat (only when running_healthy)

NEXT: Main Chat phase
