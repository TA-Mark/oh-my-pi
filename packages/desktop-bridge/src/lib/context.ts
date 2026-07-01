/**
 * Shared bridge context — passed to every route handler.
 * Kept in lib/ to break the routes ↔ server.ts import cycle.
 */

import type { LauncherSupervisor } from "../routes/launcher";
import type { ApiKeyStore } from "./api-keys";
import type { BridgeConfig } from "./config";
import type { JobManager } from "./jobs";
import type { LocalRelay } from "./local-relay";
import type { OmpSessionManager } from "./omp-manager";
import type { OmpPtyManager } from "./omp-pty-manager";

export interface BridgeContext {
	config: BridgeConfig;
	jobs: JobManager;
	launcher: LauncherSupervisor;
	/** Legacy NDJSON-over-stdio omp child supervisor — kept until PTY rollout completes. */
	omp: OmpSessionManager;
	/** PTY-backed omp TUI supervisor (new path, Phase 0+). */
	ompPty: OmpPtyManager;
	/** Embedded collab relay shared by every PTY session's CollabHost. */
	relay: LocalRelay;
	apiKeys: ApiKeyStore;
}
