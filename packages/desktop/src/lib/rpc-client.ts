/**
 * Browser-side RPC client. Mirrors the classification logic of the canonical
 * `packages/coding-agent/src/modes/rpc/rpc-client.ts`, but instead of spawning
 * the engine itself it drives the Rust bridge over Tauri IPC:
 *   - sends commands via `send_rpc`
 *   - receives NDJSON frames via the `rpc://frame` event
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type EngineEvent,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type LoginProvider,
	type ModelInfo,
	type RpcCommand,
	type RpcResponse,
	type SessionState,
	SESSION_EVENT_TYPES,
	type SubagentSnapshot,
	SUBAGENT_FRAME_TYPES,
	type ThinkingLevel,
} from "./rpc-protocol";
import { onEngineExit, onRpcFrame, onRpcStderr, sendRpcLine, startEngine, stopEngine } from "./tauri-bridge";

const sessionEventTypes = new Set<string>(SESSION_EVENT_TYPES);
const subagentFrameTypes = new Set<string>(SUBAGENT_FRAME_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type EngineStatus = "idle" | "starting" | "ready" | "error" | "stopped";

export interface DesktopRpcClientHandlers {
	onEvent?: (event: EngineEvent) => void;
	onStatus?: (status: EngineStatus, detail?: string) => void;
	onStderr?: (line: string) => void;
	/** Fired when a subagent frame arrives; the app should refresh via getSubagents(). */
	onSubagentUpdate?: () => void;
	/** Fired for every extension UI request (dialogs, notify, open_url, …). */
	onExtensionUI?: (request: ExtensionUIRequest) => void;
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class DesktopRpcClient {
	#handlers: DesktopRpcClientHandlers;
	#pending = new Map<string, PendingRequest>();
	#reqId = 0;
	#unlisten: UnlistenFn[] = [];
	#readyResolve: (() => void) | undefined;
	#started = false;

	constructor(handlers: DesktopRpcClientHandlers = {}) {
		this.#handlers = handlers;
	}

	async start(cwd?: string): Promise<void> {
		if (this.#started) throw new Error("client already started");
		this.#started = true;

		// Attach listeners before spawning so the `ready` frame can't be missed.
		this.#unlisten.push(await onRpcFrame(line => this.#handleLine(line)));
		this.#unlisten.push(await onRpcStderr(line => this.#handlers.onStderr?.(line)));
		this.#unlisten.push(await onEngineExit(() => this.#handlers.onStatus?.("stopped")));

		const ready = new Promise<void>(resolve => {
			this.#readyResolve = resolve;
		});

		this.#handlers.onStatus?.("starting");
		try {
			await startEngine(cwd);
		} catch (err) {
			this.#handlers.onStatus?.("error", errorMessage(err));
			throw err;
		}

		let readyTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			readyTimer = setTimeout(() => reject(new Error("timeout waiting for engine ready")), READY_TIMEOUT_MS);
		});
		try {
			await Promise.race([ready, timeout]);
			this.#handlers.onStatus?.("ready");
		} catch (err) {
			this.#handlers.onStatus?.("error", errorMessage(err));
			throw err;
		} finally {
			if (readyTimer) clearTimeout(readyTimer);
		}
	}

	async stop(): Promise<void> {
		for (const unlisten of this.#unlisten) unlisten();
		this.#unlisten = [];
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("client stopped"));
		}
		this.#pending.clear();
		await stopEngine().catch(() => {});
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async prompt(message: string): Promise<void> {
		await this.#send({ type: "prompt", message });
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async newSession(): Promise<void> {
		await this.#send({ type: "new_session" });
	}

	async getState(): Promise<SessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#data<SessionState>(response);
	}

	async setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
		await this.#send({ type: "set_subagent_subscription", level });
	}

	async getSubagents(): Promise<SubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#data<{ subagents?: SubagentSnapshot[] }>(response).subagents ?? [];
	}

	async getLoginProviders(): Promise<LoginProvider[]> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#data<{ providers?: LoginProvider[] }>(response).providers ?? [];
	}

	/** Start OAuth login. The engine emits `open_url` (handled via onExtensionUI) and resolves when auth completes. */
	async login(providerId: string): Promise<void> {
		await this.#send({ type: "login", providerId }, 600_000);
	}

	/** Reply to an extension UI dialog request (select/confirm/input/editor). Side-channel frame, not a command. */
	async respondExtensionUI(response: ExtensionUIResponse): Promise<void> {
		await sendRpcLine(JSON.stringify(response));
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		const data = this.#data<{ models?: ModelInfo[] }>(response);
		return data.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#send({ type: "set_model", provider, modelId });
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	#handleLine(line: string): void {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(data)) return;

		if (data.type === "ready") {
			this.#readyResolve?.();
			this.#readyResolve = undefined;
			return;
		}

		if (data.type === "response" && typeof data.command === "string") {
			const id = typeof data.id === "string" ? data.id : undefined;
			if (id && this.#pending.has(id)) {
				const pending = this.#pending.get(id)!;
				this.#pending.delete(id);
				clearTimeout(pending.timer);
				pending.resolve(data as unknown as RpcResponse);
			}
			return;
		}

		if (typeof data.type === "string" && sessionEventTypes.has(data.type)) {
			this.#handlers.onEvent?.(data as unknown as EngineEvent);
			return;
		}

		if (typeof data.type === "string" && subagentFrameTypes.has(data.type)) {
			this.#handlers.onSubagentUpdate?.();
			return;
		}

		if (data.type === "extension_ui_request" && typeof data.id === "string" && typeof data.method === "string") {
			this.#handlers.onExtensionUI?.(data as unknown as ExtensionUIRequest);
			return;
		}

		// host_tool_call / host_uri_request are only sent when the host registers
		// custom tools/URI schemes (set_host_tools / set_host_uri_schemes); the
		// desktop app does not, so those frames never arrive.
	}

	#send(command: RpcCommand, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RpcResponse> {
		const id = `req_${++this.#reqId}`;
		const promise = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`timeout waiting for response to ${command.type}`));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
		});
		void sendRpcLine(JSON.stringify({ ...command, id })).catch((err: unknown) => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(err instanceof Error ? err : new Error(String(err)));
		});
		return promise;
	}

	#data<T>(response: RpcResponse): T {
		if (!response.success) throw new Error(response.error);
		return (response.data ?? {}) as T;
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
