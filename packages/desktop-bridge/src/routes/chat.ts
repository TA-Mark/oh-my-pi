/**
 * Chat routes — sessions, data sources, runtime config.
 *
 * Sessions are persisted to state/sessions.json. A new session is given a
 * placeholder collab link pointing at the local relay so the GuestClient can
 * attempt to connect (the actual omp host process is a Phase-2 concern).
 *
 * Data sources and runtime config are simple JSON-backed surfaces; they exist
 * so the React UI's left sidebar renders correctly out of the box.
 */

import { randomBytes } from "node:crypto";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";
import { makeStore } from "../lib/store";
import type { ChatSession, DataSource, RuntimeConfig, RuntimeConfigResponse } from "../types";

interface SessionsFile {
	sessions: ChatSession[];
}

interface SourcesFile {
	sources: DataSource[];
}

const DEFAULT_CONFIG: RuntimeConfig = {
	model: "anthropic/claude-sonnet-4-6",
	mode: "normal",
	thinkingEnabled: false,
	maxTokens: 8192,
};

const AVAILABLE_MODELS = [
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-4-7",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-haiku-4-5",
	"openai/gpt-5.5",
	"google/gemini-3-flash",
	"xai/grok-4-fast",
];

function base64url(bytes: Buffer): string {
	return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function newLink(relayPort: number): string {
	const roomId = base64url(randomBytes(12)).slice(0, 16);
	const key = base64url(randomBytes(32));
	return `ws://127.0.0.1:${relayPort}/r/${roomId}.${key}`;
}

export async function handleChat(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;
	const sessions = makeStore<SessionsFile>(ctx.config.stateDir, "sessions", { sessions: [] });
	const sources = makeStore<SourcesFile>(ctx.config.stateDir, "data-sources", { sources: [] });
	const config = makeStore<RuntimeConfig>(ctx.config.stateDir, "runtime-config", DEFAULT_CONFIG);

	// ─── Sessions ────────────────────────────────────────────────────────────
	if (p === "/api/v1/chat/sessions" && req.method === "GET") {
		return jsonResponse({ sessions: sessions.get().sessions });
	}
	if (p === "/api/v1/chat/sessions" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { name?: string };
		const session: ChatSession = {
			id: crypto.randomUUID(),
			name: body.name?.trim() || `Session ${new Date().toLocaleString()}`,
			link: newLink(ctx.config.relayPort),
			createdAt: new Date().toISOString(),
			lastActiveAt: null,
			messageCount: 0,
			isActive: false,
		};
		sessions.mutate(s => s.sessions.unshift(session));
		return jsonResponse({ session });
	}

	const sessionMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)$/.exec(p);
	if (sessionMatch && req.method === "DELETE") {
		const id = sessionMatch[1]!;
		await ctx.omp.stop(id).catch(() => {});
		ctx.omp.bindings.clear(id);
		sessions.mutate(s => {
			s.sessions = s.sessions.filter(x => x.id !== id);
		});
		return jsonResponse({ ok: true });
	}

	const startMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/start$/.exec(p);
	if (startMatch && req.method === "POST") {
		const id = startMatch[1]!;
		const found = sessions.get().sessions.find(x => x.id === id);
		if (!found) return errorResponse("SESSION_NOT_FOUND", "no such session", 404);
		const binding = ctx.omp.bindings.get(id);
		const extraArgs = binding ? ["--resume", binding.sessionFile] : undefined;
		const envFromKeys = ctx.apiKeys.all();
		try {
			const snap = await ctx.omp.start(id, {
				cwd: ctx.config.installDir,
				...(extraArgs ? { extraArgs } : {}),
				...(Object.keys(envFromKeys).length > 0 ? { env: envFromKeys } : {}),
			});
			return jsonResponse({
				ok: true,
				session: snap,
				resumed: binding ? binding.sessionFile : null,
			});
		} catch (err) {
			return errorResponse("OMP_SPAWN_FAILED", err instanceof Error ? err.message : String(err), 502);
		}
	}

	// ─── API keys ────────────────────────────────────────────────────────────
	if (p === "/api/v1/chat/keys" && req.method === "GET") {
		return jsonResponse({ keys: ctx.apiKeys.list() });
	}
	if (p === "/api/v1/chat/keys" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { name?: string; value?: string };
		const name = body.name?.trim();
		const value = body.value;
		if (!name || typeof value !== "string" || value.length === 0) {
			return errorResponse("BAD_REQUEST", "name and value are required", 400);
		}
		ctx.apiKeys.set(name, value);
		return jsonResponse({ ok: true, name });
	}
	const keyDeleteMatch = /^\/api\/v1\/chat\/keys\/([^/]+)$/.exec(p);
	if (keyDeleteMatch && req.method === "DELETE") {
		const name = decodeURIComponent(keyDeleteMatch[1]!);
		const ok = ctx.apiKeys.delete(name);
		return jsonResponse({ ok, name });
	}

	const stopMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/stop$/.exec(p);
	if (stopMatch && req.method === "POST") {
		const ok = await ctx.omp.stop(stopMatch[1]!);
		return jsonResponse({ ok });
	}

	const stateMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/state$/.exec(p);
	if (stateMatch && req.method === "GET") {
		const snap = ctx.omp.get(stateMatch[1]!);
		if (!snap) return errorResponse("SESSION_NOT_STARTED", "session not running", 404);
		return jsonResponse(snap);
	}

	const renameMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/rename$/.exec(p);
	if (renameMatch && req.method === "POST") {
		const id = renameMatch[1]!;
		const body = (await req.json().catch(() => ({}))) as { name?: string };
		if (!body.name?.trim()) return errorResponse("BAD_REQUEST", "name is required", 400);
		sessions.mutate(s => {
			const found = s.sessions.find(x => x.id === id);
			if (found) found.name = body.name!.trim();
		});
		return jsonResponse({ ok: true });
	}

	// ─── Data sources ────────────────────────────────────────────────────────
	if (p === "/api/v1/chat/data-sources" && req.method === "GET") {
		return jsonResponse({ sources: sources.get().sources });
	}
	const refreshMatch = /^\/api\/v1\/chat\/data-sources\/([^/]+)\/refresh$/.exec(p);
	if (refreshMatch && req.method === "POST") {
		const id = refreshMatch[1]!;
		sources.mutate(s => {
			const found = s.sources.find(x => x.id === id);
			if (found) found.status = "connected";
		});
		return jsonResponse({ ok: true });
	}

	// ─── Runtime config ──────────────────────────────────────────────────────
	if (p === "/api/v1/chat/runtime-config" && req.method === "GET") {
		const response: RuntimeConfigResponse = {
			...config.get(),
			availableModels: AVAILABLE_MODELS,
		};
		return jsonResponse(response);
	}
	if (p === "/api/v1/chat/runtime-config" && req.method === "POST") {
		const patch = (await req.json().catch(() => ({}))) as Partial<RuntimeConfig>;
		const next = config.mutate(c => {
			if (patch.model !== undefined) c.model = patch.model;
			if (patch.mode !== undefined) c.mode = patch.mode;
			if (patch.thinkingEnabled !== undefined) c.thinkingEnabled = patch.thinkingEnabled;
			if (patch.maxTokens !== undefined) c.maxTokens = patch.maxTokens;
		});
		const response: RuntimeConfigResponse = { ...next, availableModels: AVAILABLE_MODELS };
		return jsonResponse(response);
	}

	return errorResponse("NOT_FOUND", `No chat route for ${req.method} ${p}`, 404);
}
