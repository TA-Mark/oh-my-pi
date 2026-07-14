/**
 * Browser-side RPC client. Mirrors the classification logic of the canonical
 * `packages/coding-agent/src/modes/rpc/rpc-client.ts`, but instead of spawning
 * the engine itself it drives the Rust bridge over Tauri IPC:
 *   - sends commands via `send_rpc`
 *   - receives NDJSON frames via the `rpc://frame` event
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type ApprovalMode,
	type EngineEvent,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
	type HunkSelection,
	type ImageContent,
	type LoginProvider,
	type ModelInfo,
	type RpcCommand,
	type RpcResponse,
	SESSION_EVENT_TYPES,
	type SessionMessage,
	type SessionState,
	type SessionSummary,
	SUBAGENT_FRAME_TYPES,
	type SubagentSnapshot,
	type ThinkingLevel,
	type WorkspaceFileChange,
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
	command: string;
	requestId: string;
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
		this.#unlisten.push(
			await onEngineExit(() => {
				this.#rejectPending("engine exited");
				this.#handlers.onStatus?.("stopped");
			}),
		);

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
		this.#rejectPending("client stopped");
		await stopEngine().catch(() => {});
	}

	/** Reject and clear every in-flight request with a transport error. */
	#rejectPending(reason: string): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new RpcTransportError(reason, pending.command, pending.requestId));
		}
		this.#pending.clear();
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async prompt(message: string, images?: ImageContent[]): Promise<{ agentInvoked: boolean }> {
		const response = await this.#send(
			images && images.length > 0 ? { type: "prompt", message, images } : { type: "prompt", message },
		);
		// The engine returns `{ agentInvoked: false }` only for local-only commands
		// (slash commands that never start a turn); a real prompt returns no data.
		const data = this.#data<{ agentInvoked?: boolean }>(response);
		return { agentInvoked: data.agentInvoked !== false };
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async newSession(): Promise<void> {
		await this.#send({ type: "new_session" });
	}

	/**
	 * Re-root the live engine at a new project directory and open a fresh task,
	 * WITHOUT respawning the engine. Used when the user switches projects so the
	 * process, credentials, and RPC stream stay alive (Codex/Claude-style).
	 */
	async setWorkspace(cwd: string): Promise<{ cwd: string }> {
		const response = await this.#send({ type: "set_workspace", cwd });
		return this.#data<{ cwd: string }>(response);
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

	/** Store a provider API key in the engine credential store. */
	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		await this.#send({ type: "set_api_key", providerId, apiKey });
	}

	/** Sign out of a provider (clears stored credentials). */
	async logout(providerId: string): Promise<void> {
		await this.#send({ type: "logout", providerId });
	}

	/** Toggle plan mode. When enabling, the engine makes the working tree read-only
	 *  until the agent submits a plan for approval (surfaced via a confirm dialog). */
	async setPlanMode(enabled: boolean, workflow?: "parallel" | "iterative"): Promise<void> {
		await this.#send(workflow ? { type: "set_plan_mode", enabled, workflow } : { type: "set_plan_mode", enabled });
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

	async setApprovalMode(mode: ApprovalMode): Promise<void> {
		await this.#send({ type: "set_approval_mode", mode });
	}

	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	/** List sessions for the current workspace (newest first, `active` flags the loaded one). */
	async listSessions(): Promise<SessionSummary[]> {
		const response = await this.#send({ type: "list_sessions" });
		return this.#data<{ sessions?: SessionSummary[] }>(response).sessions ?? [];
	}

	/** Switch to a different session file. Returns `cancelled: true` if an extension blocked it. */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#data<{ cancelled: boolean }>(response);
	}

	/** Fetch the full persisted message history of the loaded session (for transcript re-seed). */
	async getMessages(): Promise<SessionMessage[]> {
		const response = await this.#send({ type: "get_messages" });
		return this.#data<{ messages?: SessionMessage[] }>(response).messages ?? [];
	}

	/** Fetch the workspace git diff (changed/untracked files vs HEAD) for the Changes panel. */
	async getWorkspaceDiff(): Promise<WorkspaceFileChange[]> {
		const response = await this.#send({ type: "get_workspace_diff" });
		return this.#data<{ files?: WorkspaceFileChange[] }>(response).files ?? [];
	}

	/** Stage whole files or specific hunks (git index only; non-destructive). */
	async stageHunks(selections: HunkSelection[]): Promise<void> {
		await this.#send({ type: "stage_hunks", selections });
	}

	/** Unstage files (empty = unstage all). Reverses {@link stageHunks} on the index. */
	async unstage(files?: string[]): Promise<void> {
		await this.#send(files && files.length > 0 ? { type: "unstage", files } : { type: "unstage" });
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
				reject(new RpcTimeoutError(`timeout waiting for response to ${command.type}`, command.type, id));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer, command: command.type, requestId: id });
		});
		void sendRpcLine(JSON.stringify({ ...command, id })).catch((err: unknown) => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(new RpcTransportError(errorMessage(err), command.type, id));
		});
		// Surface engine-side failures uniformly, so void commands (prompt, abort,
		// …) that never call #data don't swallow a success:false response.
		return promise.then(response => {
			if (!response.success) {
				throw new RpcEngineError(response.error, response.command, response.id ?? id);
			}
			return response;
		});
	}

	#data<T>(response: RpcResponse): T {
		// #send already rejected non-success responses, so `data` is present here.
		return (response.success ? (response.data ?? {}) : {}) as T;
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Base for RPC request failures. Callers branch on the subclass to recover
 * differently: timeout → offer retry, transport → suggest restarting the
 * engine, engine → surface the message and keep the transcript.
 */
export abstract class RpcError extends Error {
	abstract readonly kind: "timeout" | "transport" | "engine";
	constructor(
		message: string,
		readonly command: string,
		readonly requestId: string,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** No response arrived within the timeout window. */
export class RpcTimeoutError extends RpcError {
	readonly kind = "timeout" as const;
}

/** The command could not be delivered, or the client/engine stopped while awaiting it. */
export class RpcTransportError extends RpcError {
	readonly kind = "transport" as const;
}

/** The engine processed the command and returned `success: false`. */
export class RpcEngineError extends RpcError {
	readonly kind = "engine" as const;
}
