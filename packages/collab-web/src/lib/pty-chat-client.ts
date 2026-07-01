/**
 * PtyChatClient — `ChatClient` over the PTY-backed omp TUI.
 *
 * Two transports, one identity:
 *   - Read path: a {@link GuestClient} subscribed to OMP's collab broadcast
 *     (transcript, agents, state, dialogs). Joined with a *view link* (no
 *     write token) so the host rejects any mutating frame we send by mistake
 *     — single-writer is enforced at the protocol layer, not by convention.
 *   - Write path: REST `POST /input` to the bridge's `PtySession`. Composer
 *     sends become `synthText(text + "\r")`; Ctrl+C and slash commands flow
 *     through {@link PtyInputClient} too.
 *
 * Why split read/write transports:
 *   The collab path could in theory carry guest prompts (it does for native
 *   guests), but routing the desktop wrapper's prompts through the relay
 *   creates two writers to the same session file (TUI + a synthetic guest)
 *   and ruins the single-writer invariant we rely on for not corrupting the
 *   transcript. Pushing keystrokes into PTY stdin makes the React composer
 *   indistinguishable from someone typing at the terminal, which is the
 *   correct mental model for a "100% CLI fidelity" wrapper.
 *
 * Lifecycle:
 *   - `collabLink` is optional at construction. When unset (the typical
 *     Phase 0.2 case, before auto-/collab lands in Phase 0.3) the snapshot
 *     stays in a synthetic "waiting" phase: terminal still renders fine,
 *     side panels show "waiting for host to start collab".
 *   - `setCollabLink(link)` attaches the GuestClient lazily once the bridge
 *     learns the link (e.g. by scraping `/collab start` output).
 *   - `close()` tears down both transports.
 */

import type { ImageContent } from "@oh-my-pi/pi-wire";
import { setConfigKey } from "../features/chat/api/configApi";
import type { ChatClient, DialogResponsePayload } from "./chat-client";
import { type ConnectionPhase, GuestClient, type GuestSnapshot } from "./client";
import { KEY_INTERRUPT, PtyInputClient } from "./pty-input-client";
import type { FollowUpMode, InterruptMode, LoginProvider, SteeringMode } from "./rpc-client";

/**
 * Keybind byte sequences for actions the TUI exposes only via hotkeys.
 * Defaults from `packages/coding-agent/src/config/keybindings.ts` — bump these
 * if OMP changes the default binding (kept together so the diff is a single
 * find-and-replace).
 */
const KEY_CYCLE_MODEL_FORWARD = "\x10"; // Ctrl+P → app.model.cycleForward
const KEY_CYCLE_THINKING = "\x1b[Z"; // Shift+Tab → app.thinking.cycle

const BRIDGE_PROVIDERS_CATALOG = "http://127.0.0.1:8787/api/v1/chat/providers/catalog";

const DEFAULT_BRIDGE_HTTP = "http://127.0.0.1:8787/api/v1";
/** How often to ask the bridge whether it has scraped the collab link yet. */
const COLLAB_POLL_INTERVAL_MS = 500;
/** Cap on collab link polls before we give up and stay in "waiting". */
const COLLAB_POLL_MAX_ATTEMPTS = 60; // ~30 seconds

export interface PtyChatClientOptions {
	sessionId: string;
	/** Display name advertised to the collab host. Defaults to "desktop". */
	displayName?: string;
	/** Bridge HTTP base; defaults to the local desktop bridge. */
	httpBase?: string;
	/** Collab link from `/collab start`; may be set later via {@link PtyChatClient.setCollabLink}. */
	collabLink?: string;
}

/**
 * Empty snapshot shown before the GuestClient attaches. Mirrors the shape
 * `GuestClient.#buildSnapshot` produces on first construction so React
 * components can render the same skeleton state both before and during
 * `phase === "connecting"`.
 */
function emptySnapshot(phase: ConnectionPhase): GuestSnapshot {
	return {
		phase,
		endedReason: null,
		header: null,
		entries: [],
		state: null,
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: false,
		readOnly: true,
		notices: [],
		commands: [],
		pendingDialog: null,
		statusEntries: [],
		widgets: [],
		titleOverride: null,
		todoPhases: [],
		sessionExtras: {},
		logs: [],
	};
}

export class PtyChatClient implements ChatClient {
	private readonly input: PtyInputClient;
	private readonly displayName: string;
	private readonly httpBase: string;
	private readonly sessionId: string;
	private guest: GuestClient | null = null;
	private guestUnsub: (() => void) | null = null;
	private collabLink: string | null;
	private readonly listeners = new Set<() => void>();
	private currentSnapshot: GuestSnapshot;
	private closed = false;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private pollAttempts = 0;

	constructor(opts: PtyChatClientOptions) {
		this.sessionId = opts.sessionId;
		this.httpBase = (opts.httpBase ?? DEFAULT_BRIDGE_HTTP).replace(/\/+$/, "");
		this.input = new PtyInputClient({ sessionId: opts.sessionId, httpBase: this.httpBase });
		this.displayName = opts.displayName ?? "desktop";
		this.collabLink = opts.collabLink ?? null;
		this.currentSnapshot = emptySnapshot(this.collabLink ? "connecting" : "waiting");
	}

	/**
	 * Attach a GuestClient now that the collab link is known. Idempotent for
	 * the same link; tears down + rebuilds for a different one (a session
	 * restart may produce a new room).
	 */
	setCollabLink(link: string): void {
		if (this.closed) return;
		if (this.collabLink === link && this.guest) return;
		this.collabLink = link;
		this.attachGuest();
	}

	connect(): void {
		if (this.closed) return;
		if (this.guest) {
			this.guest.connect();
			return;
		}
		if (this.collabLink) {
			this.attachGuest();
			return;
		}
		this.startPolling();
	}

	close(): void {
		this.closed = true;
		this.stopPolling();
		this.guestUnsub?.();
		this.guestUnsub = null;
		this.guest?.close();
		this.guest = null;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): GuestSnapshot {
		return this.currentSnapshot;
	}

	// ─── Write surface (input synth into PTY) ────────────────────────────────

	sendPrompt(text: string, _images?: ImageContent[]): void {
		// Images are out of scope for the PTY path — the TUI composer doesn't take
		// images; the bridge would have to upload them and synthesize a path/URL,
		// which we leave for Phase 4 (file browser handles uploads separately).
		void this.input.synthText(`${text}\r`);
	}

	sendAbort(): void {
		void this.input.synthKey(KEY_INTERRUPT);
	}

	/**
	 * Steer/follow-up are TUI-native: the user just types while the agent is
	 * streaming and the input-controller decides (steer if mid-turn, queue if
	 * finishing). We route both through the same synth path — the TUI does not
	 * distinguish them at the wire, only at intent.
	 */
	sendSteer(text: string): void {
		void this.input.synthText(`${text}\r`);
	}

	sendFollowUp(text: string): void {
		void this.input.synthText(`${text}\r`);
	}

	/**
	 * Regenerate mirrors the composer's ↻ button. The TUI exposes it as the
	 * `/regenerate` slash command; we synth-invoke it so the button keeps
	 * working after the RPC transport is retired.
	 */
	sendRegenerate(): void {
		void this.input.synthSlash("regenerate");
	}

	// ─── Phase 3: slash-command + keybind synth matrix ───────────────────────
	// Each of these routes a former RpcClient call to the equivalent TUI
	// interaction: a slash command (fire-and-forget), a raw key sequence
	// (keybindings pulled from packages/coding-agent/src/config/keybindings.ts),
	// or a bridge REST endpoint (for config values the TUI reads from disk).

	sendSetModel(provider: string, modelId: string): void {
		void this.input.synthSlash("model", `${provider}/${modelId}`);
	}

	sendCycleModel(): void {
		void this.input.synthKey(KEY_CYCLE_MODEL_FORWARD);
	}

	sendCycleThinkingLevel(): void {
		void this.input.synthKey(KEY_CYCLE_THINKING);
	}

	sendLogin(providerId: string): void {
		void this.input.synthSlash("login", providerId);
	}

	sendCompact(instructions?: string): void {
		void this.input.synthSlash("compact", instructions ?? "");
	}

	sendAbortRetry(): void {
		void this.input.synthKey(KEY_INTERRUPT);
	}

	sendSetSessionName(name: string): void {
		// OMP's slash is `/rename` (see slash-commands/builtin-registry.ts:1547).
		void this.input.synthSlash("rename", name);
	}

	sendHandoff(instructions?: string): void {
		void this.input.synthSlash("handoff", instructions ?? "");
	}

	sendBranch(entryId: string): void {
		void this.input.synthSlash("branch", entryId);
	}

	/**
	 * `/export` writes the HTML export to disk and prints the path in the TUI.
	 * We can't easily observe that path from React side (it lands in a chunk,
	 * not a structured frame), so we just kick the command and resolve with
	 * an empty path — the UI shows a "check the terminal for the file path"
	 * hint and the entries stream will carry an OSC 8 link.
	 */
	async sendExportHtml(outputPath?: string): Promise<{ path: string }> {
		await this.input.synthSlash("export", outputPath ?? "");
		return { path: outputPath ?? "" };
	}

	// ─── Config REST (values TUI reads from ~/.omp/agent/config.yml) ─────────
	// These change persistent settings. The TUI caches them at startup, so a
	// change may only take effect after the next `/reload` or session restart.
	// UI sites should surface that hint next to the toggle.

	sendSetSteeringMode(mode: SteeringMode): void {
		void setConfigKey("steeringMode", mode).catch(() => {});
	}

	sendSetFollowUpMode(mode: FollowUpMode): void {
		void setConfigKey("followUpMode", mode).catch(() => {});
	}

	sendSetInterruptMode(mode: InterruptMode): void {
		void setConfigKey("interruptMode", mode).catch(() => {});
	}

	sendSetAutoCompaction(enabled: boolean): void {
		void setConfigKey("compaction.enabled", enabled).catch(() => {});
	}

	sendSetAutoRetry(enabled: boolean): void {
		void setConfigKey("retry.enabled", enabled).catch(() => {});
	}

	// ─── Query methods ───────────────────────────────────────────────────────

	/**
	 * Adapts the bridge's rich provider-catalog to the sparse `LoginProvider[]`
	 * shape the Providers panel expects. Filters to OAuth + API-key providers
	 * (the ones with an interactive login path in the TUI).
	 */
	async sendGetLoginProviders(): Promise<LoginProvider[]> {
		try {
			const res = await fetch(BRIDGE_PROVIDERS_CATALOG);
			if (!res.ok) return [];
			const body = (await res.json()) as {
				providers?: Array<{ id: string; name: string; type: string; configured: boolean }>;
			};
			const list = body.providers ?? [];
			return list
				.filter(p => p.type === "oauth" || p.type === "api-key")
				.map(p => ({
					id: p.id,
					name: p.name,
					available: true,
					authenticated: p.configured,
				}));
		} catch {
			return [];
		}
	}

	// Explicitly unimplemented (Phase 4 / not applicable):
	//   sendGetAvailableModels, sendGetSessionStats, sendGetBranchMessages —
	//     need new bridge endpoints that read/parse session state.
	//   sendBashStreaming — bridge has /chat/sessions/{id}/shell WS; wiring
	//     it to a callback-based streaming API here adds surface area we don't
	//     need yet.
	//   respondToDialog, showSyntheticDialog, registerEditorTextSetter,
	//     sendSetThinkingLevel — collab does not broadcast extension_ui_request
	//     frames from TUI mode, so `snapshot.pendingDialog` never populates
	//     and these methods have no live consumers. Slash-intercept falls
	//     through to synthText when `/model` is typed, so the TUI's own
	//     dialog handles model selection.

	// ─── Private ────────────────────────────────────────────────────────────

	/**
	 * Poll the bridge for the scraped collab view link, up to
	 * {@link COLLAB_POLL_MAX_ATTEMPTS} times at {@link COLLAB_POLL_INTERVAL_MS}
	 * cadence. As soon as the bridge reports `ready: true` we attach the
	 * GuestClient and stop polling.
	 *
	 * Why polling instead of push:
	 *   The bridge already exposes a PTY WebSocket for byte forwarding but not
	 *   an event bus for control state. A dedicated SSE would carry exactly
	 *   this event, but a 500 ms poll for a value we expect within 1-2 seconds
	 *   is cheaper and matches the pattern the launcher/health checks already
	 *   use.
	 */
	private startPolling(): void {
		if (this.closed || this.pollTimer || this.guest) return;
		this.pollAttempts = 0;
		const tick = (): void => {
			if (this.closed || this.guest) return;
			this.pollAttempts++;
			void this.fetchCollabLink().then(link => {
				if (this.closed || this.guest) return;
				if (link) {
					this.stopPolling();
					this.setCollabLink(link);
					return;
				}
				if (this.pollAttempts >= COLLAB_POLL_MAX_ATTEMPTS) {
					this.stopPolling();
					// Park in "waiting" — user can retry via a fresh connect() (e.g.
					// after restarting the session) or interact through the terminal
					// pane, which never depended on the collab link.
					return;
				}
				this.pollTimer = setTimeout(tick, COLLAB_POLL_INTERVAL_MS);
			});
		};
		this.pollTimer = setTimeout(tick, COLLAB_POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
	}

	private async fetchCollabLink(): Promise<string | null> {
		try {
			const url = `${this.httpBase}/chat/sessions/${encodeURIComponent(this.sessionId)}/collab-link`;
			const res = await fetch(url);
			if (!res.ok) return null;
			const body = (await res.json().catch(() => null)) as { link?: string | null; ready?: boolean } | null;
			if (!body?.link) return null;
			return body.link;
		} catch {
			// Bridge down / net blip / CORS — poll again on the next tick.
			return null;
		}
	}

	private attachGuest(): void {
		this.guestUnsub?.();
		this.guest?.close();
		const link = this.collabLink;
		if (!link) {
			this.guest = null;
			this.publish(emptySnapshot("waiting"));
			return;
		}
		try {
			const guest = new GuestClient(link, this.displayName);
			this.guest = guest;
			this.guestUnsub = guest.subscribe(() => this.publish(guest.getSnapshot()));
			guest.connect();
			this.publish(guest.getSnapshot());
		} catch (err) {
			// Bad link, key length wrong, etc. Park in "ended" so the UI surfaces
			// the failure rather than spinning on "connecting" forever.
			const snap = emptySnapshot("ended");
			snap.endedReason = err instanceof Error ? err.message : String(err);
			this.guest = null;
			this.publish(snap);
		}
	}

	private publish(snapshot: GuestSnapshot): void {
		this.currentSnapshot = snapshot;
		for (const l of this.listeners) {
			try {
				l();
			} catch {
				/* listener errors are not our problem */
			}
		}
	}
}

// Re-exported for callers that want the explicit shape without pulling chat-client.
export type { DialogResponsePayload };
