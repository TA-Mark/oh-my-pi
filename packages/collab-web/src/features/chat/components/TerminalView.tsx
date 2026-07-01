/**
 * TerminalView — renders a live PTY-backed omp TUI inside the React app.
 *
 * Connects to the desktop-bridge PTY WebSocket
 * (`ws://127.0.0.1:8787/api/v1/chat/sessions/{id}/pty`), pipes the binary
 * byte stream into a ghostty-web Terminal, and forwards keystrokes back as
 * `term.onData` payloads. The bridge already routes binary frames to PTY
 * stdin and JSON text frames to control (resize/ping); we mirror that
 * convention here.
 *
 * Lifecycle:
 *   - On mount: initialize the shared Ghostty WASM module once, build a
 *     Terminal sized to the container, open the WebSocket, wire data flow.
 *   - On `sessionId` change: tear everything down and rebuild (no in-place
 *     swap — Terminal state is tied to the WASM instance).
 *   - On unmount: close the socket, dispose the terminal, drop listeners.
 *
 * Reconnect:
 *   - On close (1006 / network blip), wait `RECONNECT_DELAY_MS` and retry.
 *   - The bridge replays its rolling tail (~256 KiB) so xterm gets enough
 *     bytes to redraw before the next live write lands.
 *
 * Not responsible for:
 *   - Starting the PTY session (parent calls `POST /start-pty`).
 *   - Driving collab-frame state for transcript/agents/todos panels (that
 *     is `PtyChatClient` + the existing React components).
 *   - Composer-driven prompts (use `pty-input-client.ts` for those).
 */

import { type ReactNode, useEffect, useRef } from "react";

const DEFAULT_WS_BASE = "ws://127.0.0.1:8787/api/v1";
const RECONNECT_DELAY_MS = 1500;
const MIN_COLS = 20;
const MIN_ROWS = 5;
const FIT_DEBOUNCE_MS = 100;

// Default theme — leans on the OMP TUI's own ANSI palette so themed output
// (status line accents, syntax highlight) renders the same as the native CLI.
const DEFAULT_THEME = {
	background: "#0b0d10",
	foreground: "#d6deeb",
	cursor: "#82aaff",
};

interface Props {
	sessionId: string;
	/** Override the bridge WebSocket base — useful when testing against a tunnel. */
	wsBase?: string;
	/** Initial font size. Default 13px. */
	fontSize?: number;
}

interface TerminalLike {
	open(parent: HTMLElement): void;
	write(data: Uint8Array | string): void;
	resize(cols: number, rows: number): void;
	dispose(): void;
	focus(): void;
	onData(listener: (data: string) => void): { dispose(): void };
	onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
}

let initPromise: Promise<typeof import("ghostty-web")> | null = null;

/**
 * Lazy-load the ghostty-web module + WASM. Single shared init across every
 * mounted TerminalView so the ~400 KiB WASM bundle pays its cost once.
 */
function loadGhostty(): Promise<typeof import("ghostty-web")> {
	if (!initPromise) {
		initPromise = (async () => {
			const mod = await import("ghostty-web");
			await mod.init();
			return mod;
		})();
	}
	return initPromise;
}

/**
 * Measure the container and compute a cols/rows fit. ghostty-web ships
 * `FitAddon`; we use a hand-rolled version because we want the same metrics
 * the renderer would derive from font metrics directly, without depending on
 * the addon's internal state machine (which has been noted to be flaky in
 * `packages/tui/test/virtual-terminal.ts`).
 */
function measureFit(container: HTMLElement, fontSize: number): { cols: number; rows: number } {
	const rect = container.getBoundingClientRect();
	// Empirical metrics: at 13px monospace, char width ≈ 7.8px, line height ≈ 18px.
	// We use ratios so non-default fontSize still gets a sensible fit.
	const charW = fontSize * 0.6;
	const charH = fontSize * 1.4;
	const cols = Math.max(MIN_COLS, Math.floor(rect.width / charW));
	const rows = Math.max(MIN_ROWS, Math.floor(rect.height / charH));
	return { cols, rows };
}

export function TerminalView({ sessionId, wsBase, fontSize = 13 }: Props): ReactNode {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let term: TerminalLike | null = null;
		let ws: WebSocket | null = null;
		let dataDisposer: { dispose(): void } | null = null;
		let resizeDisposer: { dispose(): void } | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let fitTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let disposed = false;
		let lastSize: { cols: number; rows: number } | null = null;
		const base = wsBase ?? DEFAULT_WS_BASE;

		const sendResize = (cols: number, rows: number): void => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify({ type: "resize", cols, rows }));
		};

		const performFit = (): void => {
			if (!term || !container) return;
			const { cols, rows } = measureFit(container, fontSize);
			if (lastSize && lastSize.cols === cols && lastSize.rows === rows) return;
			lastSize = { cols, rows };
			try {
				term.resize(cols, rows);
			} catch {
				/* terminal may not be fully open yet */
			}
			sendResize(cols, rows);
		};

		const scheduleFit = (): void => {
			if (fitTimer) clearTimeout(fitTimer);
			fitTimer = setTimeout(performFit, FIT_DEBOUNCE_MS);
		};

		const connectWs = (): void => {
			if (disposed) return;
			const url = `${base}/chat/sessions/${encodeURIComponent(sessionId)}/pty`;
			const sock = new WebSocket(url);
			sock.binaryType = "arraybuffer";
			ws = sock;
			sock.onopen = (): void => {
				if (lastSize) sendResize(lastSize.cols, lastSize.rows);
			};
			sock.onmessage = (ev): void => {
				if (typeof ev.data === "string") {
					// Bridge sends JSON TEXT for control frames (exit/error/respawning/pong).
					// We render those as faint status lines so the operator can see them
					// without leaving the terminal pane.
					let ctrl: { type?: string; message?: string; exitCode?: number | null };
					try {
						ctrl = JSON.parse(ev.data) as typeof ctrl;
					} catch {
						return;
					}
					if (!term) return;
					if (ctrl.type === "exit") {
						term.write(`\r\n\x1b[2m[bridge] omp exited with code ${ctrl.exitCode ?? "?"}\x1b[0m\r\n`);
					} else if (ctrl.type === "error" && ctrl.message) {
						term.write(`\r\n\x1b[33m[bridge] ${ctrl.message}\x1b[0m\r\n`);
					} else if (ctrl.type === "respawning" && ctrl.message) {
						term.write(`\r\n\x1b[2m[bridge] ${ctrl.message}\x1b[0m\r\n`);
					}
					return;
				}
				if (!term) return;
				term.write(new Uint8Array(ev.data));
			};
			sock.onclose = (ev): void => {
				if (disposed) return;
				if (term) {
					term.write(
						`\r\n\x1b[2m[bridge] socket closed (${ev.code} ${ev.reason || ""}); reconnecting…\x1b[0m\r\n`,
					);
				}
				// Bridge replays its rolling tail on reconnect, so the redraw will catch
				// up automatically. A short delay avoids hammering during a hard outage.
				reconnectTimer = setTimeout(connectWs, RECONNECT_DELAY_MS);
			};
			sock.onerror = (): void => {
				// onclose fires right after; let it handle the retry path. We avoid
				// logging here to keep the terminal pane quiet during expected drops.
			};
		};

		void (async () => {
			let mod: typeof import("ghostty-web");
			try {
				mod = await loadGhostty();
			} catch (err) {
				container.textContent = `Failed to load terminal renderer: ${err instanceof Error ? err.message : String(err)}`;
				return;
			}
			if (disposed) return;

			const initial = measureFit(container, fontSize);
			const t = new mod.Terminal({
				cols: initial.cols,
				rows: initial.rows,
				fontSize,
				cursorBlink: true,
				cursorStyle: "block",
				scrollback: 10_000,
				theme: DEFAULT_THEME,
			}) as unknown as TerminalLike;
			term = t;
			t.open(container);
			t.focus();
			lastSize = initial;

			// Wire keystrokes → WebSocket. We never UTF-8-decode here; the bridge's
			// `PtySession.write(string)` re-encodes to bytes on the Rust side, and
			// strings are the contract pi-natives offers.
			dataDisposer = t.onData((data: string) => {
				if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
			});
			// Some shells emit DSR responses; pipe those too.
			resizeDisposer = t.onResize(({ cols, rows }) => sendResize(cols, rows));

			resizeObserver = new ResizeObserver(scheduleFit);
			resizeObserver.observe(container);

			connectWs();
		})();

		return (): void => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (fitTimer) clearTimeout(fitTimer);
			resizeObserver?.disconnect();
			dataDisposer?.dispose();
			resizeDisposer?.dispose();
			try {
				ws?.close(1000, "unmount");
			} catch {
				/* already closed */
			}
			try {
				term?.dispose();
			} catch {
				/* WASM teardown can throw on partial init — ignore */
			}
		};
	}, [sessionId, wsBase, fontSize]);

	return (
		<div
			ref={containerRef}
			className="mc-terminal"
			role="application"
			aria-label="Terminal — Oh-My-Pi CLI"
			tabIndex={-1}
			style={{ width: "100%", height: "100%", background: DEFAULT_THEME.background, overflow: "hidden" }}
		/>
	);
}
