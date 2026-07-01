/**
 * REST client for synthesizing user input into a PTY-backed omp TUI.
 *
 * The bridge owns one `PtySession` per session id; everything the React UI
 * "would have sent over RPC" instead lands here as a POST that turns into
 * stdin bytes for that PTY (`POST /api/v1/chat/sessions/{id}/input`).
 *
 * Why a REST companion when the PTY WebSocket already accepts input:
 *   - One-shot writes (a button click, a slash invocation) don't justify
 *     subscribing to the byte stream. REST lets the caller fire-and-forget
 *     without owning a socket.
 *   - The ChatComposer (`PtyChatClient.sendPrompt`) uses this to push a full
 *     line + CR while a different subscriber (the visible terminal pane)
 *     stays on the WebSocket for keystroke-level input + live render.
 *   - The synth surface stays narrow: text / raw key sequence / slash
 *     command / resize. New surfaces (e.g. dialog answer keys) add a method
 *     here, never a new endpoint shape.
 */

const DEFAULT_BRIDGE_HTTP = "http://127.0.0.1:8787/api/v1";

export interface PtyInputClientOptions {
	/** Bridge HTTP base. Defaults to the local desktop bridge. */
	httpBase?: string;
	/** Session id this client targets. */
	sessionId: string;
}

interface PostResult {
	ok: boolean;
	bytes?: number;
	error?: string;
}

export class PtyInputClient {
	private readonly httpBase: string;
	private readonly sessionId: string;

	constructor(opts: PtyInputClientOptions) {
		this.httpBase = (opts.httpBase ?? DEFAULT_BRIDGE_HTTP).replace(/\/+$/, "");
		this.sessionId = opts.sessionId;
	}

	/** Push a plain text payload into the PTY's stdin. */
	synthText(data: string): Promise<PostResult> {
		return this.post({ kind: "text", data });
	}

	/**
	 * Push a raw key sequence (control characters + escape sequences).
	 * No transformation: the caller already produced bytes that the TUI's key
	 * decoder understands (e.g. `"\x03"` for Ctrl+C, `"\x1b[A"` for ArrowUp).
	 */
	synthKey(data: string): Promise<PostResult> {
		return this.post({ kind: "keys", data });
	}

	/**
	 * Invoke a slash command. Equivalent to typing `/<name> <args>` + Enter in
	 * the TUI. Bridge appends `\r` for us so the caller never has to remember.
	 */
	synthSlash(name: string, args = ""): Promise<PostResult> {
		return this.post({ kind: "slash", data: name, args });
	}

	/**
	 * Tell the PTY to resize. The visible terminal pane also sends resize over
	 * the WebSocket; this REST path is for callers without a socket (e.g. an
	 * off-screen mirror pane).
	 */
	synthResize(cols: number, rows: number): Promise<PostResult> {
		return this.post({ kind: "resize", cols, rows });
	}

	private async post(body: Record<string, unknown>): Promise<PostResult> {
		try {
			const res = await fetch(`${this.httpBase}/chat/sessions/${encodeURIComponent(this.sessionId)}/input`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => res.statusText);
				return { ok: false, error: `${res.status} ${text || res.statusText}` };
			}
			const json = (await res.json().catch(() => ({}))) as { bytes?: number };
			return { ok: true, bytes: json.bytes };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}

// ─── Standalone key sequence helpers ───────────────────────────────────────
//
// Plain strings the React UI can pass to `synthKey()`. Keeping them in one
// place makes it obvious which raw bytes the bridge will inject.

/** Ctrl+C — abort / interrupt the running turn. */
export const KEY_INTERRUPT = "\x03";
/** Ctrl+D — EOF; OMP TUI maps this to /exit on an empty input line. */
export const KEY_EOF = "\x04";
/** Escape — close popovers, cancel modal selections. */
export const KEY_ESCAPE = "\x1b";
/** Carriage return — submit input (terminals use CR not LF for "enter"). */
export const KEY_ENTER = "\r";
/** Arrow keys (DECSET cursor mode off — application mode adds an "O" prefix). */
export const KEY_UP = "\x1b[A";
export const KEY_DOWN = "\x1b[B";
export const KEY_RIGHT = "\x1b[C";
export const KEY_LEFT = "\x1b[D";

/**
 * Wrap `text` with the bracketed-paste sentinels so the TUI's input
 * controller treats it as pasted content (no per-character key processing,
 * no autocomplete trigger). Only enable if the active screen has bracketed
 * paste on (most modern TUIs do by default).
 */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}
