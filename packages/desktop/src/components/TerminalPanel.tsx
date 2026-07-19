import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalSession {
	id: string;
	title: string;
	starting: boolean;
	exited: boolean;
}

interface TerminalHandle {
	terminal: XtermTerminal;
	fit: FitAddon;
}

interface TerminalPanelProps {
	disabled: boolean;
	workspace: string;
	onClosePanel: () => void;
}

interface TerminalSurfaceProps {
	id: string;
	active: boolean;
	disabled: boolean;
	onReady: (id: string, terminal: XtermTerminal, fit: FitAddon) => void;
	onDispose: (id: string, terminal: XtermTerminal) => void;
}

function createSession(): TerminalSession {
	return {
		id: `term-${crypto.randomUUID()}`,
		title: "Terminal",
		starting: true,
		exited: false,
	};
}

function terminalTheme(): ITheme {
	const style = getComputedStyle(document.documentElement);
	const color = (token: string, fallback: string): string => style.getPropertyValue(token).trim() || fallback;
	return {
		background: color("--bg-canvas", "#ffffff"),
		foreground: color("--text", "#1f2328"),
		cursor: color("--text", "#1f2328"),
		cursorAccent: color("--bg-canvas", "#ffffff"),
		selectionBackground: color("--selection", "#cfe3ff"),
		black: "#24292f",
		red: "#cf222e",
		green: "#1a7f37",
		yellow: "#9a6700",
		blue: "#0969da",
		magenta: "#8250df",
		cyan: "#1b7c83",
		white: "#f6f8fa",
		brightBlack: "#57606a",
		brightRed: "#ff7b72",
		brightGreen: "#56d364",
		brightYellow: "#e3b341",
		brightBlue: "#58a6ff",
		brightMagenta: "#d2a8ff",
		brightCyan: "#39c5cf",
		brightWhite: "#ffffff",
	};
}

function TerminalSurface({ id, active, disabled, onReady, onDispose }: TerminalSurfaceProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<XtermTerminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const terminal = new XtermTerminal({
			allowTransparency: false,
			cursorBlink: true,
			cursorStyle: "bar",
			fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
			fontSize: 12,
			fontWeight: "400",
			lineHeight: 1.25,
			rightClickSelectsWord: true,
			scrollback: 10_000,
			theme: terminalTheme(),
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(container);
		terminalRef.current = terminal;
		fitRef.current = fit;
		const input = terminal.onData(data => {
			if (!disabledRef.current) void window.desktop.writeTerminal(id, data).catch(() => undefined);
		});
		const resize = terminal.onResize(size => {
			void window.desktop.resizeTerminal(id, size.cols, size.rows).catch(() => undefined);
		});
		let fitFrame = 0;
		const scheduleFit = (): void => {
			window.cancelAnimationFrame(fitFrame);
			fitFrame = window.requestAnimationFrame(() => {
				if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
				fit.fit();
			});
		};
		const resizeObserver = new ResizeObserver(scheduleFit);
		resizeObserver.observe(container);
		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = terminalTheme();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		const readyFrame = window.requestAnimationFrame(() => {
			scheduleFit();
			onReady(id, terminal, fit);
		});
		return () => {
			window.cancelAnimationFrame(readyFrame);
			window.cancelAnimationFrame(fitFrame);
			resizeObserver.disconnect();
			themeObserver.disconnect();
			input.dispose();
			resize.dispose();
			onDispose(id, terminal);
			terminal.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [id, onDispose, onReady]);

	useEffect(() => {
		if (!active) return;
		const frame = window.requestAnimationFrame(() => {
			fitRef.current?.fit();
			terminalRef.current?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [active]);

	return (
		<div className={active ? "terminal-surface terminal-surface--active" : "terminal-surface"} aria-hidden={!active}>
			<div className="terminal-viewport" ref={containerRef} />
		</div>
	);
}

export function TerminalPanel({ disabled, workspace, onClosePanel }: TerminalPanelProps) {
	const [sessions, setSessions] = useState<TerminalSession[]>(() => [createSession()]);
	const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? "");
	const handlesRef = useRef(new Map<string, TerminalHandle>());
	const pendingOutputRef = useRef(new Map<string, string>());
	const creatingRef = useRef(new Set<string>());
	const sessionIdsRef = useRef<string[]>([]);
	const mountedRef = useRef(false);
	sessionIdsRef.current = sessions.map(session => session.id);

	const handleDispose = useCallback((id: string, terminal: XtermTerminal): void => {
		if (handlesRef.current.get(id)?.terminal === terminal) handlesRef.current.delete(id);
	}, []);

	const handleReady = useCallback(
		(id: string, terminal: XtermTerminal, fit: FitAddon): void => {
			handlesRef.current.set(id, { terminal, fit });
			const pending = pendingOutputRef.current.get(id);
			if (pending) {
				terminal.write(pending);
				pendingOutputRef.current.delete(id);
			}
			if (creatingRef.current.has(id)) return;
			creatingRef.current.add(id);
			fit.fit();
			void window.desktop
				.createTerminal({ id, cwd: workspace, cols: terminal.cols, rows: terminal.rows })
				.then(descriptor => {
					setSessions(current =>
						current.map(session =>
							session.id === id ? { ...session, title: descriptor.title, starting: false } : session,
						),
					);
					terminal.focus();
				})
				.catch(error => {
					const message = error instanceof Error ? error.message : String(error);
					terminal.writeln(`\r\n\x1b[31mUnable to start terminal: ${message}\x1b[0m`);
					setSessions(current =>
						current.map(session =>
							session.id === id
								? { ...session, title: "Terminal unavailable", starting: false, exited: true }
								: session,
						),
					);
				});
		},
		[workspace],
	);

	useEffect(() => {
		const offData = window.desktop.onTerminalData(event => {
			const handle = handlesRef.current.get(event.id);
			if (handle) {
				handle.terminal.write(event.data);
				return;
			}
			const buffered = `${pendingOutputRef.current.get(event.id) ?? ""}${event.data}`;
			pendingOutputRef.current.set(event.id, buffered.slice(-1024 * 1024));
		});
		const offExit = window.desktop.onTerminalExit(event => {
			handlesRef.current
				.get(event.id)
				?.terminal.writeln(`\r\n\x1b[90mProcess exited with code ${event.exitCode}.\x1b[0m`);
			setSessions(current =>
				current.map(session => (session.id === event.id ? { ...session, starting: false, exited: true } : session)),
			);
		});
		return () => {
			offData();
			offExit();
		};
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			queueMicrotask(() => {
				if (mountedRef.current) return;
				for (const id of sessionIdsRef.current) void window.desktop.closeTerminal(id).catch(() => undefined);
			});
		};
	}, []);

	const addSession = (): void => {
		if (sessions.length >= 8) return;
		const session = createSession();
		setSessions(current => [...current, session]);
		setActiveId(session.id);
	};

	const closeSession = (id: string): void => {
		void window.desktop.closeTerminal(id).catch(() => undefined);
		creatingRef.current.delete(id);
		pendingOutputRef.current.delete(id);
		const remaining = sessions.filter(session => session.id !== id);
		setSessions(remaining);
		if (remaining.length === 0) {
			onClosePanel();
			return;
		}
		if (activeId === id) setActiveId(remaining.at(-1)?.id ?? remaining[0]?.id ?? "");
	};

	return (
		<div className="terminal-panel">
			<div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
				{sessions.map(session => (
					<div
						className={session.id === activeId ? "terminal-tab terminal-tab--active" : "terminal-tab"}
						key={session.id}
						title={session.title}
						role="presentation"
					>
						<button
							type="button"
							className="terminal-tab-main"
							role="tab"
							aria-selected={session.id === activeId}
							onClick={() => setActiveId(session.id)}
						>
							<SquareTerminal size={13} strokeWidth={1.8} />
							<span>{session.title}</span>
							{session.starting ? <i className="terminal-tab-status" aria-label="Starting" /> : null}
							{session.exited ? (
								<i className="terminal-tab-status terminal-tab-status--exited" aria-label="Exited" />
							) : null}
						</button>
						<button
							type="button"
							className="terminal-tab-close"
							aria-label={`Close ${session.title}`}
							onClick={event => {
								event.stopPropagation();
								closeSession(session.id);
							}}
						>
							<X size={12} strokeWidth={1.8} />
						</button>
					</div>
				))}
				<button
					type="button"
					className="terminal-add"
					onClick={addSession}
					disabled={sessions.length >= 8}
					title="New terminal"
					aria-label="New terminal"
				>
					<Plus size={16} strokeWidth={1.8} />
				</button>
			</div>
			<div className="terminal-stage">
				{sessions.map(session => (
					<TerminalSurface
						key={session.id}
						id={session.id}
						active={session.id === activeId}
						disabled={disabled || session.exited}
						onReady={handleReady}
						onDispose={handleDispose}
					/>
				))}
			</div>
		</div>
	);
}
