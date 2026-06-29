/**
 * Shared bridge context — passed to every route handler.
 * Kept in lib/ to break the routes ↔ server.ts import cycle.
 */

import type { LauncherSupervisor } from "../routes/launcher";
import type { BridgeConfig } from "./config";
import type { JobManager } from "./jobs";
import type { OmpSessionManager } from "./omp-manager";

export interface BridgeContext {
	config: BridgeConfig;
	jobs: JobManager;
	launcher: LauncherSupervisor;
	omp: OmpSessionManager;
}
