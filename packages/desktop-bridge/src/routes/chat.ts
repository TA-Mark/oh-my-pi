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
import { getLoopState, startLoop, stopLoop } from "../lib/loop-mode";
import { getKey as getConfigKey, resetKey as resetConfigKey, setKey as setConfigKey } from "../lib/omp-config";
import {
	buildGoalContinuation,
	buildPlanPromptPrefix,
	getGoalState,
	getPlanState,
	readModelRoles,
	setGoalState,
	setPlanState,
} from "../lib/plan-mode";
import { PromptHistory } from "../lib/prompt-history";
import { PROVIDER_CATALOG, type ProviderType } from "../lib/provider-catalog";
import { getKernel } from "../lib/python-kernel";
import { execShell } from "../lib/shell-exec";
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

let historyInstance: PromptHistory | null = null;
function getHistory(stateDir: string): PromptHistory {
	if (!historyInstance) historyInstance = new PromptHistory(stateDir);
	return historyInstance;
}

export async function handleChat(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	const p = url.pathname;
	const sessions = makeStore<SessionsFile>(ctx.config.stateDir, "sessions", { sessions: [] });
	const sources = makeStore<SourcesFile>(ctx.config.stateDir, "data-sources", { sources: [] });
	const config = makeStore<RuntimeConfig>(ctx.config.stateDir, "runtime-config", DEFAULT_CONFIG);
	const history = getHistory(ctx.config.stateDir);

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
		const runningSessions = ctx.omp.list().filter(s => s.running);
		for (const s of runningSessions) {
			await ctx.omp.stop(s.id);
		}
		return jsonResponse({ ok: true, name, sessionsRestarted: runningSessions.length });
	}
	const keyDeleteMatch = /^\/api\/v1\/chat\/keys\/([^/]+)$/.exec(p);
	if (keyDeleteMatch && req.method === "DELETE") {
		const name = decodeURIComponent(keyDeleteMatch[1]!);
		const ok = ctx.apiKeys.delete(name);
		return jsonResponse({ ok, name });
	}

	// ─── Provider catalog ───────────────────────────────────────────────────
	// Returns the FULL 70+ provider list (OAuth + API-key + local + coding
	// plans). omp's RPC `get_login_providers` only returns OAuth providers
	// (~53), which leaves the UI blind to the rest. This endpoint complements
	// it with metadata + per-provider status so the Providers tab can render
	// every authentication path the user has.
	if (p === "/api/v1/chat/providers/catalog" && req.method === "GET") {
		const storedKeys = ctx.apiKeys.all();
		const enriched = PROVIDER_CATALOG.map(entry => {
			let configured = false;
			let configuredVia: "stored-key" | "process-env" | null = null;
			if (entry.envVars && entry.envVars.length > 0) {
				for (const name of entry.envVars) {
					if (storedKeys[name]) {
						configured = true;
						configuredVia = "stored-key";
						break;
					}
					if (process.env[name]) {
						configured = true;
						configuredVia = "process-env";
						break;
					}
				}
			}
			return {
				...entry,
				configured,
				configuredVia,
			};
		});
		const byType: Record<ProviderType, number> = {
			oauth: 0,
			"api-key": 0,
			"coding-plan": 0,
			local: 0,
			discovery: 0,
		};
		for (const p of enriched) byType[p.type]++;
		return jsonResponse({ providers: enriched, total: enriched.length, byType });
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

	// ─── Shell execution (bridge-owned, not OMP RPC) ────────────────────────
	const bashMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/bash$/.exec(p);
	if (bashMatch && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { command?: string; hidden?: boolean };
		const command = body.command?.trim();
		if (!command) return errorResponse("BAD_REQUEST", "command is required", 400);

		const sessionId = bashMatch[1]!;
		const result = await execShell(command, {
			cwd: ctx.config.installDir,
			timeout: 60_000,
		});

		if (!body.hidden && result.output) {
			const contextMsg = `User ran shell command: \`${command}\`\nOutput:\n\`\`\`\n${result.output.slice(0, 8000)}\n\`\`\`\nExit code: ${result.exitCode ?? "unknown"}`;
			ctx.omp.send(sessionId, { id: `bridge-bash-${Date.now()}`, type: "prompt", message: contextMsg });
		}

		return jsonResponse({
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
		});
	}

	// ─── Python execution (persistent kernel) ───────────────────────────────
	const pythonMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/python$/.exec(p);
	if (pythonMatch && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { code?: string; hidden?: boolean };
		const code = body.code?.trim();
		if (!code) return errorResponse("BAD_REQUEST", "code is required", 400);

		const sessionId = pythonMatch[1]!;
		const kernel = getKernel(sessionId);
		try {
			const result = await kernel.execute(code);

			if (!body.hidden && result.output) {
				const contextMsg = `User ran Python:\n\`\`\`python\n${code}\n\`\`\`\nOutput:\n\`\`\`\n${result.output.slice(0, 8000)}\n\`\`\``;
				ctx.omp.send(sessionId, { id: `bridge-py-${Date.now()}`, type: "prompt", message: contextMsg });
			}

			return jsonResponse({ output: result.output, error: result.error, exitCode: result.exitCode });
		} catch (err) {
			return errorResponse("PYTHON_ERROR", err instanceof Error ? err.message : String(err), 500);
		}
	}

	// ─── File search (for @file autocomplete) ───────────────────────────────
	if (p === "/api/v1/chat/files/search" && req.method === "GET") {
		const query = url.searchParams.get("q") ?? "";
		const cwd = url.searchParams.get("cwd") ?? ctx.config.installDir;
		const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);

		try {
			const glob = new Bun.Glob("**/*");
			const matches: string[] = [];
			const q = query.toLowerCase();
			for await (const path of glob.scan({ cwd, onlyFiles: true })) {
				if (path.includes("node_modules") || path.includes(".git/")) continue;
				if (!q || path.toLowerCase().includes(q)) {
					matches.push(path);
					if (matches.length >= limit) break;
				}
			}
			return jsonResponse({ files: matches });
		} catch {
			return jsonResponse({ files: [] });
		}
	}

	// ─── OMP config (model roles, settings) ─────────────────────────────────
	// modelRoles persist to ~/.omp/agent/config.yml — same store the omp CLI
	// reads/writes via `omp config set modelRoles.<role>`.
	if (p === "/api/v1/chat/config/roles" && req.method === "GET") {
		const roles = readModelRoles();
		return jsonResponse({ roles });
	}
	const roleMatch = /^\/api\/v1\/chat\/config\/roles\/([^/]+)$/.exec(p);
	if (roleMatch && req.method === "PUT") {
		const role = roleMatch[1]!;
		const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
		if (!body || typeof body.model !== "string") {
			return errorResponse("BAD_BODY", "expected JSON { model: 'provider/id' }", 400);
		}
		try {
			await setConfigKey(`modelRoles.${role}`, body.model);
			return jsonResponse({ ok: true, roles: readModelRoles() });
		} catch (err) {
			return errorResponse("CONFIG_WRITE_FAILED", err instanceof Error ? err.message : String(err), 400);
		}
	}
	if (roleMatch && req.method === "DELETE") {
		const role = roleMatch[1]!;
		try {
			await resetConfigKey(`modelRoles.${role}`);
			return jsonResponse({ ok: true, roles: readModelRoles() });
		} catch (err) {
			return errorResponse("CONFIG_WRITE_FAILED", err instanceof Error ? err.message : String(err), 400);
		}
	}

	// ─── Plan mode ──────────────────────────────────────────────────────────
	const planMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/plan$/.exec(p);
	if (planMatch && req.method === "POST") {
		const sessionId = planMatch[1]!;
		const body = (await req.json().catch(() => ({}))) as { action: string; objective?: string };

		if (body.action === "start" && body.objective) {
			const state = getPlanState(sessionId);
			const planPrefix = buildPlanPromptPrefix(body.objective);
			setPlanState(sessionId, {
				active: true,
				originalModel: state.originalModel,
				planModel: state.planModel,
				objective: body.objective,
			});
			ctx.omp.send(sessionId, {
				id: `bridge-plan-${Date.now()}`,
				type: "prompt",
				message: planPrefix,
			});
			return jsonResponse({ ok: true, state: getPlanState(sessionId) });
		}

		if (body.action === "exit") {
			const state = getPlanState(sessionId);
			if (state.originalModel) {
				ctx.omp.send(sessionId, {
					id: `bridge-plan-restore-${Date.now()}`,
					type: "set_model",
					provider: state.originalModel.provider,
					modelId: state.originalModel.id,
				});
			}
			setPlanState(sessionId, { active: false, originalModel: null, planModel: null, objective: null });
			return jsonResponse({ ok: true });
		}

		if (body.action === "status") {
			return jsonResponse(getPlanState(sessionId));
		}

		return errorResponse("BAD_REQUEST", "action must be start|exit|status", 400);
	}

	// ─── Goal mode ──────────────────────────────────────────────────────────
	const goalMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/goal$/.exec(p);
	if (goalMatch && req.method === "POST") {
		const sessionId = goalMatch[1]!;
		const body = (await req.json().catch(() => ({}))) as { action: string; objective?: string; budget?: number };

		if (body.action === "set" && body.objective) {
			setGoalState(sessionId, {
				active: true,
				objective: body.objective,
				turnCount: 0,
				paused: false,
			});
			ctx.omp.send(sessionId, {
				id: `bridge-goal-${Date.now()}`,
				type: "prompt",
				message: `<goal_context>\n<objective>${body.objective}</objective>\n</goal_context>\n\nYou have been given a persistent goal. Work toward completing it step by step. After each step, evaluate progress and continue until all deliverables are met.`,
			});
			return jsonResponse({ ok: true, state: getGoalState(sessionId) });
		}

		if (body.action === "show") {
			return jsonResponse({ state: getGoalState(sessionId) });
		}

		if (body.action === "pause") {
			const state = getGoalState(sessionId);
			if (state) {
				state.paused = true;
				setGoalState(sessionId, state);
			}
			return jsonResponse({ ok: true, state: getGoalState(sessionId) });
		}

		if (body.action === "resume") {
			const state = getGoalState(sessionId);
			if (state) {
				state.paused = false;
				setGoalState(sessionId, state);
				const continuation = buildGoalContinuation(state);
				ctx.omp.send(sessionId, { id: `bridge-goal-cont-${Date.now()}`, type: "prompt", message: continuation });
			}
			return jsonResponse({ ok: true, state: getGoalState(sessionId) });
		}

		if (body.action === "drop") {
			setGoalState(sessionId, null);
			return jsonResponse({ ok: true });
		}

		return errorResponse("BAD_REQUEST", "action must be set|show|pause|resume|drop", 400);
	}

	// ─── Loop mode ──────────────────────────────────────────────────────────
	const loopMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/loop$/.exec(p);
	if (loopMatch && req.method === "POST") {
		const sessionId = loopMatch[1]!;
		const body = (await req.json().catch(() => ({}))) as { action: string; args?: string; prompt?: string };

		if (body.action === "start") {
			const result = startLoop(sessionId, body.args ?? "", body.prompt, ctx.omp);
			if (!result.ok) {
				return errorResponse("BAD_REQUEST", result.error, 400);
			}
			return jsonResponse({ ok: true, state: getLoopState(sessionId) });
		}

		if (body.action === "stop") {
			stopLoop(sessionId);
			return jsonResponse({ ok: true });
		}

		if (body.action === "status") {
			return jsonResponse({ state: getLoopState(sessionId) });
		}

		return errorResponse("BAD_REQUEST", "action must be start|stop|status", 400);
	}

	// ─── Prompt history ─────────────────────────────────────────────────────
	if (p === "/api/v1/chat/history" && req.method === "GET") {
		const query = url.searchParams.get("q") ?? "";
		return jsonResponse({ entries: query ? history.search(query) : history.list() });
	}
	if (p === "/api/v1/chat/history" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { text?: string };
		if (body.text) history.push(body.text);
		return jsonResponse({ ok: true });
	}

	// ─── Memory config read ─────────────────────────────────────────────────
	if (p === "/api/v1/chat/memory" && req.method === "GET") {
		const backend = getConfigKey("memory.backend");
		return jsonResponse({ backend: typeof backend === "string" ? backend : null });
	}

	// ─── Memory session actions ──────────────────────────────────────────────
	const memoryMatch = /^\/api\/v1\/chat\/sessions\/([^/]+)\/memory$/.exec(p);
	if (memoryMatch && req.method === "POST") {
		const sessionId = memoryMatch[1]!;
		const body = (await req.json().catch(() => ({}))) as { action?: string };
		const allowed = ["view", "clear", "reset", "enqueue", "rebuild", "stats", "diagnose", "mm"];
		if (!body.action || !allowed.includes(body.action)) {
			return errorResponse("BAD_REQUEST", `action must be one of: ${allowed.join(", ")}`, 400);
		}
		ctx.omp.send(sessionId, {
			id: `bridge-memory-${Date.now()}`,
			type: "prompt",
			message: `/memory ${body.action}`,
		});
		return jsonResponse({ ok: true });
	}

	return errorResponse("NOT_FOUND", `No chat route for ${req.method} ${p}`, 404);
}
