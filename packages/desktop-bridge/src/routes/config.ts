/**
 * Config routes — CRUD over `~/.omp/agent/config.yml`.
 *
 * Mirrors the surface of `omp config get|set|reset|list` so the desktop UI
 * and the CLI agree on a single persisted store. Read endpoints return the
 * typed projection (unknown keys dropped); write endpoints accept a dot-path
 * and a JSON-encoded value.
 */

import { errorResponse, jsonResponse } from "../lib/http";
import { getKey, readConfig, resetKey, setKey } from "../lib/omp-config";

export async function handleConfig(req: Request, url: URL): Promise<Response> {
	const p = url.pathname;

	// GET /api/v1/config → entire tree (typed projection)
	if (p === "/api/v1/config" && req.method === "GET") {
		try {
			return jsonResponse({ config: readConfig() });
		} catch (err) {
			return errorResponse("CONFIG_READ_FAILED", err instanceof Error ? err.message : String(err), 500);
		}
	}

	// /api/v1/config/<key>
	const keyMatch = /^\/api\/v1\/config\/(.+)$/.exec(p);
	if (keyMatch) {
		const key = decodeURIComponent(keyMatch[1]!);
		if (!key) return errorResponse("BAD_KEY", "empty config key", 400);

		if (req.method === "GET") {
			try {
				const value = getKey(key);
				return jsonResponse({ key, value });
			} catch (err) {
				return errorResponse("CONFIG_READ_FAILED", err instanceof Error ? err.message : String(err), 500);
			}
		}

		if (req.method === "PUT") {
			const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
			if (!body || !("value" in body)) {
				return errorResponse("BAD_BODY", "expected JSON { value: ... }", 400);
			}
			try {
				const config = await setKey(key, body.value as never);
				return jsonResponse({ ok: true, key, config });
			} catch (err) {
				return errorResponse("CONFIG_WRITE_FAILED", err instanceof Error ? err.message : String(err), 400);
			}
		}

		if (req.method === "DELETE") {
			try {
				const config = await resetKey(key);
				return jsonResponse({ ok: true, key, config });
			} catch (err) {
				return errorResponse("CONFIG_WRITE_FAILED", err instanceof Error ? err.message : String(err), 500);
			}
		}

		return errorResponse("METHOD_NOT_ALLOWED", `Method ${req.method} not allowed for ${p}`, 405);
	}

	return errorResponse("NOT_FOUND", `No config route for ${req.method} ${p}`, 404);
}
