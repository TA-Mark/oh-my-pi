# Core touch-points

Changes the desktop app makes **outside** `packages/desktop/`. Keep this list short —
each entry is a merge-conflict risk during upstream sync (`upstream-sync.md`). Re-check
these after every sync.

## `packages/coding-agent/src/modes/rpc/` — `logout` RPC command

The RPC layer shipped `get_login_providers` + `login` but no `logout` (the TUI `/logout`
is a selector-based command with no text-mode handle, so it can't be driven headlessly).
The desktop Accounts UI needs sign-out, so we added a small, additive command:

- `rpc-types.ts`: `RpcCommand` gains `{ type: "logout"; providerId: string }`; `RpcResponse`
  gains the matching `command: "logout"` success variant.
- `rpc-mode.ts`: a `case "logout"` in `handleCommand` calls
  `authStorage.logout(providerId)` (the public AuthStorage sign-out method), then
  `modelRegistry.refresh()`.

Additive only (new union arm + new case); no existing behavior changed. If upstream adds
its own logout command, drop this in favor of theirs during the next sync. Verified by the
runtime probe in `scripts/smoke-rpc.ts` (logout step).
