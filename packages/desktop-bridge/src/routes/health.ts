/**
 * GET /api/v1/health — bridge liveness + light system info.
 */

import type { BridgeContext } from "../lib/context";
import { jsonResponse } from "../lib/http";

export function handleHealth(ctx: BridgeContext, _req: Request): Response {
	return jsonResponse({
		ok: true,
		bridge: "@oh-my-pi/desktop-bridge",
		version: "0.1.0",
		installDir: ctx.config.installDir,
		port: ctx.config.port,
		relayPort: ctx.config.relayPort,
		platform: process.platform,
		nodeVersion: process.version,
		uptimeMs: Math.round(process.uptime() * 1000),
		ts: new Date().toISOString(),
	});
}
