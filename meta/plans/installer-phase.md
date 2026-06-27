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
- [ ] Wire contracts into UI state machine (Day 2)
- [ ] Wire contracts into API client (Day 2)
- [ ] Build UI blocks (Day 2)
- [ ] Build preflight + install adapter (Day 2)

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
