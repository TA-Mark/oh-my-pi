/**
 * RpcClient — talks to a per-session omp child via the desktop bridge's
 * NDJSON-over-WebSocket proxy at `ws://<bridge>/api/v1/chat/sessions/{id}/rpc`.
 *
 * Mirrors the public surface of {@link GuestClient} (subscribe / getSnapshot /
 * sendPrompt / sendAbort / close) so the existing MainChatPage, Transcript,
 * ChatComposer, Banners, and Toasts render an RPC session without changes.
 *
 * Mapping AgentSessionEvent → GuestSnapshot:
 *   agent_start/end                  → working
 *   message_start/update (assistant) → stream
 *   message_end (assistant)          → append entry + clear stream + streamDone
 *   message_end (user/tool)          → append entry
 *   tool_execution_start/update/end  → activeTools map
 *   notice                           → notices ring (cap 50)
 *
 * Fields not derivable from the RPC stream (subagents, lifecycle, header) stay
 * empty — the UI tolerates that. They can be wired later if needed.
 */

import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	ImageContent,
	SessionEntry,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import type {
	ActiveTool,
	ConnectionPhase,
	GuestSnapshot,
	LogLine,
	Notice,
	PendingDialog,
	SessionExtras,
	SlashCommandInfo,
	TodoPhase,
	WidgetState,
} from "./client";

const MAX_LOGS = 500;

// Mirror of RpcExtensionUIRequest from packages/coding-agent/src/modes/rpc/rpc-types.ts:329.
// Kept local because that module is not exported through pi-wire and would pull
// the whole coding-agent surface area in.
type ExtensionUiRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };

/** Response shape sent back over the WS (subset of RpcExtensionUIResponse). */
export type DialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true; timedOut?: boolean };

/** Shape returned by `get_login_providers`. */
export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

/** Subset of omp's Model the UI cares about. */
export interface AvailableModel {
	id: string;
	provider: string;
	displayName?: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Aggregate stats omp tracks per session. */
export interface SessionStats {
	totalCost?: number;
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	turnCount?: number;
	messageCount?: number;
	toolCallCount?: number;
	[key: string]: unknown;
}

export type SteeringMode = "all" | "one-at-a-time";
export type FollowUpMode = "all" | "one-at-a-time";
export type InterruptMode = "immediate" | "wait";

const MAX_NOTICES = 50;

const STATE_REFRESH_COMMANDS = new Set([
	"set_model",
	"set_thinking_level",
	"cycle_model",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"compact",
	"set_session_name",
	"handoff",
]);

// ─── Bridge envelope shape (matches packages/desktop-bridge/src/lib/omp-manager.ts) ──

interface BridgeEnvelope {
	type: "frame" | "log" | "exit";
	frame?: unknown;
	line?: string;
	stream?: "stdout" | "stderr";
	code?: number | null;
	ts: string;
}

// ─── RPC frame types ─────────────────────────────────────────────────────────
// AgentEvent from pi-wire covers agent/message/tool/notice events.
// RpcSpecificFrame covers frames unique to the omp RPC protocol.

type RpcSpecificFrame =
	| { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
	| { type: "subagent_progress"; payload: SubagentProgressPayload }
	| { type: "subagent_event"; payload: { agentId: string; [key: string]: unknown } }
	| { type: "available_commands_update"; commands: SlashCommandInfo[] }
	| { type: "config_update"; model?: SessionState["model"]; thinkingLevel?: SessionState["thinkingLevel"] }
	| ExtensionUiRequest
	| { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };

type RpcFrame = AgentEvent | RpcSpecificFrame;

export interface RpcClientOpts {
	/** UUID of the chat session — used in the WS path. */
	sessionId: string;
	/** Bridge base URL, e.g. `ws://127.0.0.1:8787/api/v1`. */
	wsBase?: string;
}

const DEFAULT_BASE = "ws://127.0.0.1:8787/api/v1";

export class RpcClient {
	readonly #sessionId: string;
	readonly #wsBase: string;
	readonly #listeners = new Set<() => void>();
	#ws: WebSocket | null = null;
	#reqSeq = 0;
	#noticeSeq = 0;
	#entrySeq = 0;
	#closing = false;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempt = 0;

	// ─── Snapshot fields (private mirror; published via getSnapshot) ─────────
	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#entries: SessionEntry[] = [];
	#state: SessionState | null = null;
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools = new Map<string, ActiveTool>();
	#working = false;
	#notices: Notice[] = [];
	#agents = new Map<string, AgentSnapshot>();
	#progress = new Map<string, SubagentProgressPayload>();
	#lifecycle = new Map<string, SubagentLifecyclePayload>();
	#commands: SlashCommandInfo[] = [];
	/** Tracks optimistic user entries waiting for prompt response. Map<reqId, entryId>. */
	#pendingPrompts = new Map<string, string>();
	/** Generic request/response correlator for typed RPC reads. */
	#pendingResponses = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	#pendingDialog: PendingDialog | null = null;
	#dialogTimer: ReturnType<typeof setTimeout> | null = null;
	#syntheticDialogHandler: ((payload: DialogResponse) => void) | null = null;
	#statusEntries = new Map<string, string>();
	#widgets = new Map<string, WidgetState>();
	#titleOverride: string | null = null;
	#todoPhases: TodoPhase[] = [];
	#sessionExtras: SessionExtras = {};
	#logs: LogLine[] = [];
	#logSeq = 0;
	#editorTextSetter: ((text: string) => void) | null = null;
	#snapshot: GuestSnapshot;

	constructor(opts: RpcClientOpts) {
		this.#sessionId = opts.sessionId;
		this.#wsBase = opts.wsBase ?? DEFAULT_BASE;
		this.#snapshot = this.#buildSnapshot();
	}

	// ─── Public surface ──────────────────────────────────────────────────────

	connect(): void {
		this.#closing = false;
		this.#openSocket();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		const trimmed = text.trim();
		if (!trimmed && (!images || images.length === 0)) return;
		const reqId = this.#nextReqId();
		const entryId = this.#appendUserEntry(trimmed, images);
		this.#pendingPrompts.set(reqId, entryId);
		const body: Record<string, unknown> = { id: reqId, type: "prompt", message: trimmed };
		if (images && images.length > 0) body.images = images;
		this.#send(body);
	}

	sendAbort(): void {
		this.#send({ id: this.#nextReqId(), type: "abort" });
	}

	sendRegenerate(): void {
		const lastUser = this.#entries.findLast(
			(e): e is SessionEntry & { type: "message"; message: WireMessage } =>
				e.type === "message" && "message" in e && (e.message as WireMessage).role === "user",
		);
		if (!lastUser) {
			this.sendAbort();
			return;
		}
		const content = lastUser.message.content;
		const text =
			typeof content === "string"
				? content
				: ((content as Array<{ type: string; text?: string }>).find(p => p.type === "text")?.text ?? "");
		if (!text) {
			this.sendAbort();
			return;
		}
		this.#send({ id: this.#nextReqId(), type: "abort_and_prompt", message: text });
	}

	sendSetModel(provider: string, modelId: string): void {
		this.#send({ id: this.#nextReqId(), type: "set_model", provider, modelId });
	}

	sendSetThinkingLevel(level: string): void {
		this.#send({ id: this.#nextReqId(), type: "set_thinking_level", level });
	}

	async sendBash(command: string): Promise<{ output?: string; exitCode?: number }> {
		const data = (await this.#request("bash", { type: "bash", command }, 60000)) as {
			output?: string;
			exitCode?: number;
		};
		return data;
	}

	sendBashStreaming(
		command: string,
		hidden: boolean,
		onChunk: (chunk: string) => void,
	): Promise<{ exitCode: number | null; cancelled: boolean }> {
		return new Promise((resolve, reject) => {
			const wsUrl = `${this.#wsBase}/chat/sessions/${this.#sessionId}/shell`;
			let ws: WebSocket;
			try {
				ws = new WebSocket(wsUrl);
			} catch (err) {
				reject(err);
				return;
			}
			ws.addEventListener("open", () => {
				ws.send(JSON.stringify({ command, hidden }));
			});
			ws.addEventListener("message", evt => {
				try {
					const frame = JSON.parse(typeof evt.data === "string" ? evt.data : "") as Record<string, unknown>;
					if (frame.type === "chunk" && typeof frame.data === "string") {
						onChunk(frame.data);
					} else if (frame.type === "exit") {
						resolve({
							exitCode: typeof frame.exitCode === "number" ? frame.exitCode : null,
							cancelled: frame.cancelled === true,
						});
					}
				} catch {
					/* ignore malformed */
				}
			});
			ws.addEventListener("error", () => reject(new Error("Shell WS error")));
			ws.addEventListener("close", () => resolve({ exitCode: null, cancelled: false }));
		});
	}

	/** Fetch the list of OAuth/login providers from omp. */
	async sendGetLoginProviders(): Promise<LoginProvider[]> {
		const data = (await this.#request("get_login_providers", { type: "get_login_providers" })) as {
			providers?: LoginProvider[];
		};
		return Array.isArray(data.providers) ? data.providers : [];
	}

	/** Start an OAuth/API-key flow for `providerId`. Browser opens via extension_ui_request. */
	sendLogin(providerId: string): void {
		this.#send({ id: this.#nextReqId(), type: "login", providerId });
	}

	/** Fetch every model omp knows about right now. */
	async sendGetAvailableModels(): Promise<AvailableModel[]> {
		const data = (await this.#request("get_available_models", { type: "get_available_models" })) as {
			models?: AvailableModel[];
		};
		return Array.isArray(data.models) ? data.models : [];
	}

	/** Cycle model role (next in configured order). */
	sendCycleModel(): void {
		this.#send({ id: this.#nextReqId(), type: "cycle_model" });
	}

	/** Cycle thinking level (next in configured order). */
	sendCycleThinkingLevel(): void {
		this.#send({ id: this.#nextReqId(), type: "cycle_thinking_level" });
	}

	// ─── Session control ────────────────────────────────────────────────────

	/** Interrupt the current turn with a new instruction (mid-stream). */
	sendSteer(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.#send({ id: this.#nextReqId(), type: "steer", message: trimmed });
	}

	/** Queue a message to run after the current turn finishes. */
	sendFollowUp(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.#send({ id: this.#nextReqId(), type: "follow_up", message: trimmed });
	}

	/** Pull aggregate stats (token/cost/turn counts). */
	async sendGetSessionStats(): Promise<SessionStats> {
		return (await this.#request("get_session_stats", { type: "get_session_stats" })) as SessionStats;
	}

	/** Trigger manual compaction; pass instructions to bias the summary. */
	sendCompact(customInstructions?: string): void {
		const body: Record<string, unknown> = { type: "compact" };
		if (customInstructions) body.customInstructions = customInstructions;
		this.#send({ id: this.#nextReqId(), ...body });
	}

	/** Toggle auto-compaction on the active session. */
	sendSetAutoCompaction(enabled: boolean): void {
		this.#send({ id: this.#nextReqId(), type: "set_auto_compaction", enabled });
	}

	/** Toggle auto-retry on provider errors. */
	sendSetAutoRetry(enabled: boolean): void {
		this.#send({ id: this.#nextReqId(), type: "set_auto_retry", enabled });
	}

	/** Abort the active retry loop. */
	sendAbortRetry(): void {
		this.#send({ id: this.#nextReqId(), type: "abort_retry" });
	}

	/** Rename the active session in omp's records. */
	sendSetSessionName(name: string): void {
		this.#send({ id: this.#nextReqId(), type: "set_session_name", name });
	}

	/** Export the current transcript as HTML; resolves to the written file path. */
	async sendExportHtml(outputPath?: string): Promise<{ path: string }> {
		const body: Record<string, unknown> = { type: "export_html" };
		if (outputPath) body.outputPath = outputPath;
		const data = (await this.#request("export_html", body, 30000)) as { path?: string };
		return { path: data.path ?? "" };
	}

	sendHandoff(customInstructions?: string): void {
		const body: Record<string, unknown> = { type: "handoff" };
		if (customInstructions) body.customInstructions = customInstructions;
		this.#send({ id: this.#nextReqId(), ...body });
	}

	sendSetSteeringMode(mode: SteeringMode): void {
		this.#send({ id: this.#nextReqId(), type: "set_steering_mode", mode });
	}

	sendSetFollowUpMode(mode: FollowUpMode): void {
		this.#send({ id: this.#nextReqId(), type: "set_follow_up_mode", mode });
	}

	sendSetInterruptMode(mode: InterruptMode): void {
		this.#send({ id: this.#nextReqId(), type: "set_interrupt_mode", mode });
	}

	/** Get branch siblings — alternative messages at branch points. */
	async sendGetBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const data = (await this.#request("get_branch_messages", { type: "get_branch_messages" })) as {
			messages?: Array<{ entryId: string; text: string }>;
		};
		return Array.isArray(data.messages) ? data.messages : [];
	}

	/** Switch to a different branch. omp opens an extension_ui dialog with the text options. */
	sendBranch(entryId: string): void {
		this.#send({ id: this.#nextReqId(), type: "branch", entryId });
	}

	/** Respond to the currently pending extension dialog and dismiss it. */
	respondToDialog(payload: DialogResponse): void {
		const dialog = this.#pendingDialog;
		if (!dialog) return;
		if (this.#syntheticDialogHandler) {
			const handler = this.#syntheticDialogHandler;
			this.#syntheticDialogHandler = null;
			this.#clearDialog();
			this.#publish();
			handler(payload);
			return;
		}
		this.#send({ type: "extension_ui_response", id: dialog.id, ...payload });
		this.#clearDialog();
		this.#publish();
	}

	showSyntheticDialog(dialog: PendingDialog, onRespond: (payload: DialogResponse) => void): void {
		this.#clearDialog();
		this.#syntheticDialogHandler = onRespond;
		this.#pendingDialog = dialog;
		this.#publish();
	}

	/**
	 * Register a callback used by `set_editor_text` extension UI requests.
	 * ChatComposer wires its setter on mount, unregisters on unmount.
	 */
	registerEditorTextSetter(fn: ((text: string) => void) | null): void {
		this.#editorTextSetter = fn;
	}

	close(): void {
		this.#closing = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		try {
			this.#ws?.close(1000, "client close");
		} catch {
			/* already closed */
		}
		this.#ws = null;
		this.#setPhase("ended", "closed by user");
	}

	// ─── WebSocket plumbing ──────────────────────────────────────────────────

	#openSocket(): void {
		if (this.#closing) return;
		// Pending requests opened on the previous socket will never receive a
		// response — drop their tracking so the optimistic entries stay visible
		// (a refreshed get_state/get_messages will reconcile if omp persisted them).
		this.#pendingPrompts.clear();
		// Reject any in-flight typed requests — their response will never arrive.
		for (const pending of this.#pendingResponses.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("WS reconnected before response arrived"));
		}
		this.#pendingResponses.clear();
		// Extension UI state belongs to the previous omp process; drop it so
		// stale modals/widgets don't linger after reconnect.
		this.#clearDialog();
		this.#statusEntries.clear();
		this.#widgets.clear();
		this.#titleOverride = null;
		this.#todoPhases = [];
		this.#sessionExtras = {};
		this.#logs = [];
		const url = `${this.#wsBase}/chat/sessions/${this.#sessionId}/rpc`;
		try {
			this.#ws = new WebSocket(url);
		} catch (err) {
			this.#setPhase("reconnecting", err instanceof Error ? err.message : String(err));
			this.#scheduleReconnect();
			return;
		}

		this.#ws.addEventListener("open", () => {
			this.#reconnectAttempt = 0;
			this.#setPhase("live");
			// Ask omp for current state so we have an initial SessionState to render.
			this.#send({ id: this.#nextReqId(), type: "get_state" });
			// Subscribe to subagent lifecycle + progress events so the AgentsPanel
			// renders. "events" is the highest verbosity; "progress" would still
			// drive the panel but skip subagent_event frames.
			this.#send({ id: this.#nextReqId(), type: "set_subagent_subscription", level: "events" });
		});

		this.#ws.addEventListener("message", evt => {
			const text = typeof evt.data === "string" ? evt.data : "";
			if (!text) return;
			let env: BridgeEnvelope;
			try {
				env = JSON.parse(text) as BridgeEnvelope;
			} catch {
				return;
			}
			this.#applyEnvelope(env);
		});

		this.#ws.addEventListener("close", evt => {
			this.#ws = null;
			if (this.#closing) return;
			if (evt.code === 4404) {
				this.#setPhase("ended", "session not started — call /start first");
				return;
			}
			this.#setPhase("reconnecting", `socket closed (${evt.code})`);
			this.#scheduleReconnect();
		});

		this.#ws.addEventListener("error", () => {
			// onclose will follow — let it own the reconnect logic.
		});
	}

	#scheduleReconnect(): void {
		if (this.#closing) return;
		const delay = Math.min(1000 * 2 ** this.#reconnectAttempt, 15000);
		this.#reconnectAttempt++;
		this.#reconnectTimer = setTimeout(() => this.#openSocket(), delay);
	}

	#send(frame: unknown): void {
		if (this.#ws?.readyState !== WebSocket.OPEN) return;
		this.#ws.send(JSON.stringify(frame));
	}

	#nextReqId(): string {
		this.#reqSeq++;
		return `r${this.#reqSeq}`;
	}

	/**
	 * Send a request frame and resolve when the matching `response` arrives.
	 * The response is routed by reqId in the central frame handler — so this
	 * works for any command that returns a `data` payload (get_*, set_* with data).
	 *
	 * Fails fast when the socket is not OPEN — otherwise #send would drop the
	 * frame silently and the caller would wait the full timeout for a response
	 * that can never come.
	 */
	#request(command: string, body: object, timeoutMs = 10000): Promise<unknown> {
		if (this.#ws?.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(`RPC ${command} failed: not connected (phase=${this.#phase})`));
		}
		const id = this.#nextReqId();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pendingResponses.delete(id);
				reject(new Error(`RPC ${command} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.#pendingResponses.set(id, { resolve, reject, timer });
			this.#send({ id, ...body });
		});
	}

	// ─── Envelope reducer ────────────────────────────────────────────────────

	#applyEnvelope(env: BridgeEnvelope): void {
		if (env.type === "exit") {
			this.#setPhase("ended", `omp exited (code=${env.code ?? "null"})`);
			return;
		}
		if (env.type === "log") {
			if (env.line) this.#pushLog(env.stream ?? "stdout", env.line);
			// stderr also surfaces as a warning toast so users notice runtime issues
			if (env.stream === "stderr") {
				this.#pushNotice({ level: "warning", message: env.line!.slice(0, 240) });
			}
			return;
		}
		if (env.type !== "frame" || !env.frame) return;
		this.#applyFrame(env.frame as RpcFrame);
	}

	#applyFrame(frame: RpcFrame): void {
		switch (frame.type) {
			case "agent_start":
				this.#working = true;
				this.#streamDone = false;
				this.#publish();
				return;
			case "agent_end":
				this.#working = false;
				this.#stream = null;
				this.#streamDone = true;
				this.#publish();
				return;
			case "message_start":
				if (frame.message.role === "assistant") {
					this.#stream = frame.message;
					this.#streamDone = false;
				}
				this.#publish();
				return;
			case "message_update":
				if (frame.message.role === "assistant") this.#stream = frame.message;
				this.#publish();
				return;
			case "message_end":
				// User messages may already be appended optimistically by sendPrompt
				// (matched by content); skip the echo to avoid duplicates. omp's echo
				// arrives without a synthetic flag, so an exact text match against the
				// last user entry is the cheapest discriminator that doesn't require
				// threading reqId through the AgentEvent stream.
				if (frame.message.role === "user" && this.#hasMatchingOptimisticEntry(frame.message)) {
					this.#publish();
					return;
				}
				this.#appendMessageEntry(frame.message);
				if (frame.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = true;
				}
				this.#publish();
				return;
			case "tool_execution_start": {
				const next = new Map(this.#activeTools);
				next.set(frame.toolCallId, {
					toolCallId: frame.toolCallId,
					toolName: frame.toolName,
					args: frame.args,
					intent: frame.intent,
					startedAt: Date.now(),
				});
				this.#activeTools = next;
				this.#publish();
				return;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(frame.toolCallId);
				if (!existing) return;
				const next = new Map(this.#activeTools);
				next.set(frame.toolCallId, { ...existing, partialResult: frame.partialResult });
				this.#activeTools = next;
				this.#publish();
				return;
			}
			case "tool_execution_end": {
				if (!this.#activeTools.has(frame.toolCallId)) return;
				const next = new Map(this.#activeTools);
				next.delete(frame.toolCallId);
				this.#activeTools = next;
				this.#publish();
				return;
			}
			case "notice":
				this.#pushNotice({
					level: frame.level === "warning" ? "warning" : frame.level === "error" ? "error" : "info",
					message: frame.message,
				});
				return;
			case "subagent_lifecycle": {
				const p = frame.payload;
				const lifecycle = new Map(this.#lifecycle);
				lifecycle.set(p.id, p);
				this.#lifecycle = lifecycle;

				const agents = new Map(this.#agents);
				const prev = agents.get(p.id);
				const now = Date.now();
				const status: AgentSnapshot["status"] =
					p.status === "started" ? "running" : p.status === "aborted" ? "aborted" : "idle";
				agents.set(p.id, {
					id: p.id,
					displayName: p.description ?? p.agent,
					kind: "sub",
					status,
					hasSessionFile: Boolean(p.sessionFile),
					createdAt: prev?.createdAt ?? now,
					lastActivity: now,
				});
				this.#agents = agents;
				this.#publish();
				return;
			}
			case "subagent_progress": {
				const p = frame.payload;
				const progress = new Map(this.#progress);
				progress.set(p.progress.id, p);
				this.#progress = progress;

				// Bubble status changes from progress.status into the AgentSnapshot.
				const agents = new Map(this.#agents);
				const existing = agents.get(p.progress.id);
				if (existing) {
					const status: AgentSnapshot["status"] =
						p.progress.status === "running" ? "running" : p.progress.status === "aborted" ? "aborted" : "idle";
					agents.set(p.progress.id, { ...existing, status, lastActivity: Date.now() });
					this.#agents = agents;
				}
				this.#publish();
				return;
			}
			case "subagent_event": {
				return;
			}
			case "available_commands_update": {
				this.#commands = (frame.commands ?? []).map(c => ({
					name: c.name,
					description: c.description,
					source: c.source,
				}));
				this.#publish();
				return;
			}
			case "config_update": {
				if (this.#state) {
					this.#state = {
						...this.#state,
						...(frame.model !== undefined ? { model: frame.model } : {}),
						...(frame.thinkingLevel !== undefined ? { thinkingLevel: frame.thinkingLevel } : {}),
					};
					this.#publish();
				}
				return;
			}
			case "extension_ui_request": {
				this.#handleExtensionUiRequest(frame);
				return;
			}
			case "response": {
				// Prompt rollback path (special-cased because the entry id mapping
				// lives in #pendingPrompts, not #pendingResponses).
				if (frame.command === "prompt" && frame.id) {
					const entryId = this.#pendingPrompts.get(frame.id);
					this.#pendingPrompts.delete(frame.id);
					if (entryId && !frame.success) {
						this.#removeEntry(entryId);
						this.#pushNotice({
							level: "error",
							message: frame.error || "Prompt was rejected by the agent.",
						});
					}
					return;
				}
				// Generic correlator path: resolve / reject the pending request.
				if (frame.id) {
					const pending = this.#pendingResponses.get(frame.id);
					if (pending) {
						clearTimeout(pending.timer);
						this.#pendingResponses.delete(frame.id);
						if (frame.success) pending.resolve(frame.data ?? {});
						else pending.reject(new Error(frame.error || `RPC ${frame.command} failed`));
					}
				}
				// Side-effects on specific responses (state hydration, transcript seed).
				if (frame.success && STATE_REFRESH_COMMANDS.has(frame.command)) {
					this.#send({ id: this.#nextReqId(), type: "get_state" });
				}
				if (frame.command === "get_state" && frame.success && frame.data) {
					this.#state = this.#buildState(frame.data);
					const r = frame.data as {
						messageCount?: number;
						todoPhases?: TodoPhase[];
						steeringMode?: SessionExtras["steeringMode"];
						followUpMode?: SessionExtras["followUpMode"];
						interruptMode?: SessionExtras["interruptMode"];
						autoCompactionEnabled?: boolean;
						isCompacting?: boolean;
					};
					if (Array.isArray(r.todoPhases)) this.#todoPhases = r.todoPhases;
					this.#sessionExtras = {
						steeringMode: r.steeringMode,
						followUpMode: r.followUpMode,
						interruptMode: r.interruptMode,
						autoCompactionEnabled: r.autoCompactionEnabled,
						isCompacting: r.isCompacting,
					};
					if (typeof r.messageCount === "number" && r.messageCount > 0 && this.#entries.length === 0) {
						this.#send({ id: this.#nextReqId(), type: "get_messages" });
					}
					this.#publish();
				} else if (frame.command === "get_messages" && frame.success && frame.data) {
					const d = frame.data as { messages?: WireMessage[] };
					if (Array.isArray(d.messages)) this.#seedEntriesFromMessages(d.messages);
				}
				return;
			}
		}
	}

	// ─── Extension UI request handling ──────────────────────────────────────

	#handleExtensionUiRequest(frame: ExtensionUiRequest): void {
		switch (frame.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor": {
				// New dialog supersedes any previous one — host expects single modal.
				if (this.#pendingDialog && this.#dialogTimer) {
					clearTimeout(this.#dialogTimer);
					this.#dialogTimer = null;
				}
				this.#pendingDialog =
					frame.method === "select"
						? {
								id: frame.id,
								method: "select",
								title: frame.title,
								options: frame.options,
								timeout: frame.timeout,
							}
						: frame.method === "confirm"
							? {
									id: frame.id,
									method: "confirm",
									title: frame.title,
									message: frame.message,
									timeout: frame.timeout,
								}
							: frame.method === "input"
								? {
										id: frame.id,
										method: "input",
										title: frame.title,
										placeholder: frame.placeholder,
										timeout: frame.timeout,
									}
								: {
										id: frame.id,
										method: "editor",
										title: frame.title,
										prefill: frame.prefill,
										promptStyle: frame.promptStyle,
									};
				const timeout =
					frame.method === "select" || frame.method === "confirm" || frame.method === "input"
						? frame.timeout
						: undefined;
				if (timeout !== undefined && timeout > 0) {
					const dialogId = frame.id;
					this.#dialogTimer = setTimeout(() => {
						if (this.#pendingDialog?.id === dialogId) {
							this.respondToDialog({ cancelled: true, timedOut: true });
						}
					}, timeout);
				}
				this.#publish();
				return;
			}
			case "cancel": {
				if (this.#pendingDialog?.id === frame.targetId) {
					this.#clearDialog();
					this.#publish();
				}
				return;
			}
			case "notify": {
				this.#pushNotice({
					level: frame.notifyType === "warning" ? "warning" : frame.notifyType === "error" ? "error" : "info",
					message: frame.message,
				});
				return;
			}
			case "setStatus": {
				if (frame.statusText === undefined || frame.statusText === "") {
					this.#statusEntries.delete(frame.statusKey);
				} else {
					this.#statusEntries.set(frame.statusKey, frame.statusText);
				}
				this.#publish();
				return;
			}
			case "setWidget": {
				if (frame.widgetLines === undefined || frame.widgetLines.length === 0) {
					this.#widgets.delete(frame.widgetKey);
				} else {
					this.#widgets.set(frame.widgetKey, {
						key: frame.widgetKey,
						lines: frame.widgetLines,
						placement: frame.widgetPlacement ?? "aboveEditor",
					});
				}
				this.#publish();
				return;
			}
			case "setTitle": {
				this.#titleOverride = frame.title || null;
				this.#publish();
				return;
			}
			case "set_editor_text": {
				this.#editorTextSetter?.(frame.text);
				return;
			}
			case "open_url": {
				try {
					if (typeof window !== "undefined") {
						window.open(frame.url, "_blank", "noopener,noreferrer");
					}
				} catch {
					/* popup blocked — surface as notice */
				}
				this.#pushNotice({
					level: "info",
					message: frame.instructions ? `${frame.instructions} → ${frame.url}` : `Opened ${frame.url}`,
				});
				return;
			}
		}
	}

	#clearDialog(): void {
		if (this.#dialogTimer) {
			clearTimeout(this.#dialogTimer);
			this.#dialogTimer = null;
		}
		this.#pendingDialog = null;
	}

	/** Replace entries with a freshly-rebuilt list from omp's get_messages dump. */
	#seedEntriesFromMessages(messages: WireMessage[]): void {
		const seeded: SessionEntry[] = [];
		let prevId: string | null = null;
		for (const message of messages) {
			this.#entrySeq++;
			const entry: SessionEntry = {
				id: `rpc-${this.#entrySeq}`,
				parentId: prevId,
				timestamp: new Date().toISOString(),
				type: "message",
				message,
			};
			seeded.push(entry);
			prevId = entry.id;
		}
		this.#entries = seeded;
		this.#publish();
	}

	// ─── Mutators ────────────────────────────────────────────────────────────

	#appendUserEntry(text: string, images?: ImageContent[]): string {
		const content: string | Array<{ type: "text"; text: string } | ImageContent> =
			images && images.length > 0
				? [
						...(text ? [{ type: "text" as const, text }] : []),
						...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
					]
				: text;
		const entry: SessionEntry = {
			id: this.#nextEntryId(),
			parentId: this.#entries.length > 0 ? this.#entries[this.#entries.length - 1]!.id : null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "user",
				content,
				timestamp: Date.now(),
			},
		};
		this.#entries = [...this.#entries, entry];
		this.#publish();
		return entry.id;
	}

	#removeEntry(entryId: string): void {
		const next = this.#entries.filter(e => e.id !== entryId);
		if (next.length === this.#entries.length) return;
		this.#entries = next;
		this.#publish();
	}

	/** True when one of the last few entries already holds this user message text. */
	#hasMatchingOptimisticEntry(message: WireMessage): boolean {
		if (message.role !== "user") return false;
		const incomingText =
			typeof message.content === "string"
				? message.content
				: (message.content.find(p => p.type === "text") as { text?: string } | undefined)?.text;
		if (!incomingText) return false;
		// Only inspect a short tail — older identical user texts are unrelated.
		const tail = this.#entries.slice(-4);
		for (const entry of tail) {
			if (entry.type !== "message" || !("message" in entry)) continue;
			const m = entry.message as WireMessage;
			if (m.role !== "user") continue;
			const existing =
				typeof m.content === "string"
					? m.content
					: (m.content.find(p => p.type === "text") as { text?: string } | undefined)?.text;
			if (existing === incomingText) return true;
		}
		return false;
	}

	#appendMessageEntry(message: WireMessage): void {
		const entry: SessionEntry = {
			id: this.#nextEntryId(),
			parentId: this.#entries.length > 0 ? this.#entries[this.#entries.length - 1]!.id : null,
			timestamp: new Date().toISOString(),
			type: "message",
			message,
		};
		this.#entries = [...this.#entries, entry];
	}

	#pushLog(stream: "stdout" | "stderr", line: string): void {
		this.#logSeq++;
		const entry: LogLine = { id: this.#logSeq, at: Date.now(), stream, line };
		const next = [...this.#logs, entry];
		if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
		this.#logs = next;
		this.#publish();
	}

	#pushNotice(part: { level: "info" | "warning" | "error"; message: string }): void {
		this.#noticeSeq++;
		const next: Notice = { id: this.#noticeSeq, at: Date.now(), ...part };
		const list = [...this.#notices, next];
		if (list.length > MAX_NOTICES) list.splice(0, list.length - MAX_NOTICES);
		this.#notices = list;
		this.#publish();
	}

	#nextEntryId(): string {
		this.#entrySeq++;
		return `rpc-${this.#entrySeq}`;
	}

	#setPhase(phase: ConnectionPhase, reason: string | null = null): void {
		this.#phase = phase;
		if (reason !== null) this.#endedReason = phase === "ended" ? reason : null;
		this.#publish();
	}

	// ─── State mapping ───────────────────────────────────────────────────────

	#buildState(raw: unknown): SessionState {
		const r = (raw ?? {}) as Record<string, unknown>;
		return {
			isStreaming: (r.isStreaming as boolean) ?? false,
			queuedMessageCount: (r.queuedMessageCount as number) ?? 0,
			sessionName: (r.sessionName as string | undefined) ?? undefined,
			cwd: (r.cwd as string | undefined) ?? "",
			model: r.model as SessionState["model"],
			thinkingLevel: r.thinkingLevel as SessionState["thinkingLevel"],
			contextUsage: r.contextUsage as SessionState["contextUsage"],
			participants: [],
		};
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: null,
			entries: this.#entries,
			state: this.#state,
			agents: Array.from(this.#agents.values()),
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			readOnly: false,
			notices: this.#notices,
			commands: this.#commands,
			pendingDialog: this.#pendingDialog,
			statusEntries: Array.from(this.#statusEntries.entries()).map(([key, text]) => ({ key, text })),
			widgets: Array.from(this.#widgets.values()),
			titleOverride: this.#titleOverride,
			todoPhases: this.#todoPhases,
			sessionExtras: this.#sessionExtras,
			logs: this.#logs,
		};
	}

	#publish(): void {
		this.#snapshot = this.#buildSnapshot();
		for (const l of this.#listeners) {
			try {
				l();
			} catch {
				/* ignore */
			}
		}
	}
}
