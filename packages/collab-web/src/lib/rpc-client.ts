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
	AgentSnapshot,
	AssistantMessage,
	SessionEntry,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-pi/pi-wire";
import type { ActiveTool, ConnectionPhase, GuestSnapshot, Notice } from "./client";

const MAX_NOTICES = 50;

// ─── Bridge envelope shape (matches packages/desktop-bridge/src/lib/omp-manager.ts) ──

interface BridgeEnvelope {
	type: "frame" | "log" | "exit";
	frame?: unknown;
	line?: string;
	stream?: "stdout" | "stderr";
	code?: number | null;
	ts: string;
}

// Subset of AgentEvent we care about — kept narrow so type errors stay local.
type AgentLikeFrame =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "message_start"; message: WireMessage }
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError?: boolean;
	  }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
	| { type: "subagent_progress"; payload: SubagentProgressPayload }
	| { type: "subagent_event"; payload: { agentId: string; [key: string]: unknown } }
	| { type: "response"; command: string; success: boolean; data?: unknown; error?: string };

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

	sendPrompt(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Optimistic: append user entry immediately so the message renders
		// without waiting for omp's echo (matches GuestClient behaviour).
		this.#appendUserEntry(trimmed);
		this.#send({ id: this.#nextReqId(), type: "prompt", message: trimmed });
	}

	sendAbort(): void {
		this.#send({ id: this.#nextReqId(), type: "abort" });
	}

	/** RPC has no native regenerate — abort and let the user resend. */
	sendRegenerate(): void {
		this.sendAbort();
	}

	sendSetModel(provider: string, modelId: string): void {
		this.#send({ id: this.#nextReqId(), type: "set_model", provider, modelId });
	}

	sendSetThinkingLevel(level: string): void {
		this.#send({ id: this.#nextReqId(), type: "set_thinking_level", level });
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

	// ─── Envelope reducer ────────────────────────────────────────────────────

	#applyEnvelope(env: BridgeEnvelope): void {
		if (env.type === "exit") {
			this.#setPhase("ended", `omp exited (code=${env.code ?? "null"})`);
			return;
		}
		if (env.type === "log") {
			if (env.stream === "stderr" && env.line) {
				this.#pushNotice({ level: "warning", message: env.line.slice(0, 240) });
			}
			return;
		}
		if (env.type !== "frame" || !env.frame) return;
		this.#applyFrame(env.frame as AgentLikeFrame);
	}

	#applyFrame(frame: AgentLikeFrame): void {
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
				// We don't reconstruct subagent transcripts in this client; the bridge
				// has the data and the AgentDrawer can fetch it later if needed.
				return;
			}
			case "response":
				if (frame.command === "get_state" && frame.success && frame.data) {
					this.#state = this.#buildState(frame.data);
					// If omp resumed from a saved sessionFile, pull the existing
					// transcript so the UI seeds with prior turns instead of empty.
					const r = frame.data as { messageCount?: number };
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

	#appendUserEntry(text: string): void {
		const entry: SessionEntry = {
			id: this.#nextEntryId(),
			parentId: this.#entries.length > 0 ? this.#entries[this.#entries.length - 1]!.id : null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "user",
				content: text,
				timestamp: Date.now(),
			},
		};
		this.#entries = [...this.#entries, entry];
		this.#publish();
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
