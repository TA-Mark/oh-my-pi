import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Folder, Globe, MessageCircle, PanelRightClose, Plus, SquarePen, Terminal } from "lucide-react";
import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { HunkSelection, PtyController, WorkspaceFileChange } from "../lib/rpc-protocol";
import { ChangesPanel } from "./ChangesPanel";

export type WorkspaceToolView = "menu" | "review" | "terminal" | "browser" | "files" | "side-chat";

interface WorkspaceToolsPanelProps {
	view: WorkspaceToolView;
	changes: WorkspaceFileChange[];
	disabled: boolean;
	onClose: () => void;
	onRefreshChanges: () => void;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	onSelectView: (view: WorkspaceToolView) => void;
	ptyController: PtyController;
	/** Active project directory; drives terminal re-rooting on project switch. */
	workspace: string;
}

interface ToolItem {
	view: WorkspaceToolView;
	label: string;
	shortcut?: string;
	icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const TOOLS: ToolItem[] = [
	{ view: "review", label: "Review", shortcut: "Ctrl+Shift+G", icon: SquarePen },
	{ view: "terminal", label: "Terminal", icon: Terminal },
	{ view: "browser", label: "Browser", shortcut: "Ctrl+T", icon: Globe },
	{ view: "files", label: "Files", shortcut: "Ctrl+P", icon: Folder },
	{ view: "side-chat", label: "Side chat", shortcut: "Ctrl+Alt+S", icon: MessageCircle },
];

const DEFAULT_REVIEW_WIDTH = 820;
const MIN_REVIEW_WIDTH = 360;
const MAX_REVIEW_WIDTH = 1280;
const MIN_MAIN_COLUMN_WIDTH = 320;

function maxReviewWidth(): number {
	return Math.max(MIN_REVIEW_WIDTH, Math.min(MAX_REVIEW_WIDTH, window.innerWidth - MIN_MAIN_COLUMN_WIDTH));
}

function clampReviewWidth(width: number): number {
	return Math.min(maxReviewWidth(), Math.max(MIN_REVIEW_WIDTH, width));
}

function FeatureMenu({ onSelectView }: { onSelectView: (view: WorkspaceToolView) => void }) {
	return (
		<div className="tools-feature-menu">
			{TOOLS.map(tool => {
				const Icon = tool.icon;
				return (
					<button
						key={tool.view}
						type="button"
						className="tools-feature-item"
						onClick={() => onSelectView(tool.view)}
					>
						<span className="tools-feature-left">
							<Icon size={16} strokeWidth={1.8} />
							<span>{tool.label}</span>
						</span>
						{tool.shortcut ? <span className="tools-shortcut">{tool.shortcut}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

function PlaceholderView({ title }: { title: string }) {
	return (
		<div className="tools-placeholder">
			<p className="tools-placeholder-title">{title}</p>
			<p className="tools-placeholder-copy">
				This surface is ready in the panel, but the desktop host has not wired it yet.
			</p>
		</div>
	);
}

let ptyCounter = 0;

// Cursor Position Report: CSI <row> ; <col> R (the ESC is written as the \x1b
// escape, not a raw control byte, so noControlCharactersInRegex is satisfied).
const CPR_REPLY = /\x1b\[[0-9]+;[0-9]+R/g;

/** Copy the terminal's current selection to the clipboard (no-op if empty). */
function copySelection(term: Xterm): void {
	const selection = term.getSelection();
	if (selection.length === 0) return;
	void navigator.clipboard?.writeText(selection).catch(() => {});
}

/** Paste clipboard text into the PTY as if typed. Silently ignores denials. */
function pasteInto(ptyId: string, ptyController: PtyController, started: boolean): void {
	if (!started) return;
	void navigator.clipboard
		?.readText()
		.then(text => {
			if (text.length > 0) ptyController.input(ptyId, text);
		})
		.catch(() => {});
}

/** Mint a process-unique id so multiple terminal sessions never collide. */
function nextPtyId(): string {
	ptyCounter += 1;
	return `term-${Date.now().toString(36)}-${ptyCounter}`;
}

/**
 * One interactive terminal: an xterm instance bound to an engine-side PTY. Its
 * DOM lives in a detached `container` that we move into the panel only while the
 * tab is active, so scrollback and the running program (claude, vim, …) survive
 * both switching tabs and toggling the panel closed. Only closing the tab (or a
 * spawn failure the user restarts) tears it down.
 */
interface TerminalSession {
	id: string;
	ptyId: string;
	/** Auto-assigned label ("PS 1"); shown unless the user renamed the tab. */
	autoTitle: string;
	/** User-chosen label, or null to fall back to {@link autoTitle}. */
	userTitle: string | null;
	term: Xterm;
	fit: FitAddon;
	container: HTMLDivElement;
	started: boolean;
	exitReason: string | null;
	attach: (host: HTMLElement) => void;
	dispose: () => void;
}

/** The label a tab shows: user-chosen name if set, else the auto one. */
function tabTitle(session: TerminalSession): string {
	return session.userTitle ?? session.autoTitle;
}

/** Snapshot of the tab strip the view renders from. */
interface TerminalTabsState {
	tabs: Array<{ id: string; title: string; exited: boolean }>;
	activeId: string | null;
}

function buildTerminalSession(ptyController: PtyController, autoTitle: string, onChange: () => void): TerminalSession {
	const container = document.createElement("div");
	container.className = "terminal-xterm";

	const term = new Xterm({
		cursorBlink: true,
		fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
		fontSize: 13,
		theme: { background: "#0b0e14" },
		allowProposedApi: true,
		scrollback: 5000,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);

	const ptyId = nextPtyId();
	let opened = false;
	let startRequested = false;

	const session: TerminalSession = {
		id: ptyId,
		ptyId,
		autoTitle,
		userTitle: null,
		term,
		fit,
		container,
		started: false,
		exitReason: null,
		attach: () => {},
		dispose: () => {},
	};

	// Terminal shortcuts (Linux-style, so Ctrl+C stays SIGINT and Ctrl+V stays a
	// literal byte). Returning false tells xterm to swallow the key instead of
	// forwarding it to the PTY. Tab management keys act on the live manager.
	term.attachCustomKeyEventHandler((event): boolean => {
		if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
		switch (event.code) {
			case "KeyC":
				copySelection(term);
				return false;
			case "KeyV":
				pasteInto(ptyId, ptyController, session.started);
				return false;
			case "KeyT":
				terminalManager.open(ptyController);
				return false;
			case "KeyW":
				terminalManager.close(session.id);
				return false;
			default:
				return true;
		}
	});

	// Right-click: copy when there's a selection, otherwise paste — the familiar
	// Windows Terminal / conhost behaviour.
	container.addEventListener("contextmenu", event => {
		event.preventDefault();
		if (term.hasSelection()) copySelection(term);
		else pasteInto(ptyId, ptyController, session.started);
	});

	const unsubscribe = ptyController.subscribe(ptyId, {
		onData: chunk => term.write(chunk),
		onExit: frame => {
			session.exitReason = frame.error
				? `error: ${frame.error}`
				: frame.timedOut
					? "timed out"
					: frame.cancelled
						? "terminated"
						: `exit ${frame.exitCode ?? "?"}`;
			onChange();
		},
	});

	// term.onData fires for keystrokes and pastes alike (already encoded as the
	// bytes a TTY would deliver: control chars, escape sequences, …).
	const dataSub = term.onData(data => {
		if (!session.started) return;
		// Drop Cursor Position Reports (CSI row;col R). ConPTY answers the shell's
		// `ESC[6n` query itself, but the same query also reaches xterm, which emits
		// its own duplicate CPR here. Forwarding it lands stray `[1;1R` text on the
		// PowerShell prompt (PSReadLine eats the ESC and echoes the rest), so we
		// swallow it — the ConPTY-authored reply is the correct one anyway.
		const clean = data.replace(CPR_REPLY, "");
		if (clean.length > 0) ptyController.input(ptyId, clean);
	});

	session.attach = (host: HTMLElement): void => {
		// Moving the container re-parents its xterm DOM without destroying it.
		host.appendChild(container);
		if (!opened) {
			term.open(container);
			opened = true;
		}
		try {
			fit.fit();
		} catch {
			// Container not measurable yet; the ResizeObserver will refit.
		}
		term.focus();
		if (!startRequested) {
			startRequested = true;
			void ptyController
				.start(ptyId, term.cols, term.rows)
				.then(() => {
					session.started = true;
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					term.write(`\r\n\x1b[31mFailed to start terminal: ${message}\x1b[0m\r\n`);
					session.exitReason = "failed to start";
					onChange();
				});
		} else if (session.started) {
			ptyController.resize(ptyId, term.cols, term.rows);
		}
	};

	session.dispose = (): void => {
		unsubscribe();
		dataSub.dispose();
		ptyController.kill(ptyId);
		term.dispose();
		container.remove();
	};

	return session;
}

/**
 * Holds every open terminal tab at module scope so tabs (and their scrollback +
 * live PTYs) persist across panel toggles and even remounts of the Terminal
 * tool. The view subscribes for tab-strip changes and drives open/activate/close.
 */
class TerminalManager {
	#sessions: TerminalSession[] = [];
	#activeId: string | null = null;
	#seq = 0;
	#listeners = new Set<() => void>();
	#workspace: string | null = null;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	getState(): TerminalTabsState {
		return {
			tabs: this.#sessions.map(s => ({ id: s.id, title: tabTitle(s), exited: s.exitReason !== null })),
			activeId: this.#activeId,
		};
	}

	getActive(): TerminalSession | null {
		return this.#sessions.find(s => s.id === this.#activeId) ?? null;
	}

	/** Ensure at least one tab exists; returns the active session. */
	ensure(ptyController: PtyController): TerminalSession {
		if (this.#sessions.length === 0) this.open(ptyController);
		return this.getActive() as TerminalSession;
	}

	open(ptyController: PtyController): TerminalSession {
		this.#seq += 1;
		const session = buildTerminalSession(ptyController, `PS ${this.#seq}`, () => this.#emit());
		this.#sessions.push(session);
		this.#activeId = session.id;
		this.#emit();
		return session;
	}

	activate(id: string): void {
		if (this.#activeId === id) return;
		this.#activeId = id;
		this.#emit();
	}

	close(id: string): void {
		const index = this.#sessions.findIndex(s => s.id === id);
		if (index === -1) return;
		const [removed] = this.#sessions.splice(index, 1);
		removed.dispose();
		if (this.#activeId === id) {
			const next = this.#sessions[index] ?? this.#sessions[index - 1] ?? null;
			this.#activeId = next?.id ?? null;
		}
		this.#emit();
	}

	/**
	 * Restart a tab in place: drop the dead PTY, spawn a fresh one. The tab keeps
	 * its position and label (auto or user-renamed) so a restart is invisible in
	 * the strip beyond the terminal clearing.
	 */
	restart(ptyController: PtyController, id: string): void {
		const index = this.#sessions.findIndex(s => s.id === id);
		if (index === -1) return;
		const old = this.#sessions[index];
		old.dispose();
		const session = buildTerminalSession(ptyController, old.autoTitle, () => this.#emit());
		session.userTitle = old.userTitle;
		this.#sessions.splice(index, 1, session);
		this.#activeId = session.id;
		this.#emit();
	}

	/** Rename a tab. A blank name clears the override back to the auto label. */
	rename(id: string, title: string): void {
		const session = this.#sessions.find(s => s.id === id);
		if (!session) return;
		const trimmed = title.trim();
		session.userTitle = trimmed.length > 0 ? trimmed : null;
		this.#emit();
	}

	/**
	 * Re-root terminals when the app switches project. The engine already killed
	 * its PTYs on `set_workspace`, so the tabs here point at dead sessions; tear
	 * them all down and open one fresh tab in the new project's cwd. A no-op when
	 * the workspace is unchanged (e.g. merely toggling the panel).
	 */
	setWorkspace(ptyController: PtyController, cwd: string): void {
		if (this.#workspace === cwd) return;
		const firstOpen = this.#workspace === null;
		this.#workspace = cwd;
		if (firstOpen) return;
		for (const session of this.#sessions) session.dispose();
		this.#sessions = [];
		this.#activeId = null;
		this.#seq = 0;
		this.open(ptyController);
	}
}

const terminalManager = new TerminalManager();

/**
 * A real interactive terminal backed by engine-side PTYs, with tabs. Unlike the
 * old one-shot command runner, each tab drives a persistent pseudo-terminal with
 * a genuine controlling TTY, so REPLs and TUIs (claude, codex, python, vim, …)
 * work with line editing, colors, and job control. Tabs live in a module-level
 * {@link TerminalManager}, so they persist across panel toggles.
 */
function TerminalView({
	ptyController,
	disabled,
	workspace,
}: {
	ptyController: PtyController;
	disabled: boolean;
	workspace: string;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<TerminalTabsState>(() => terminalManager.getState());
	// The tab currently being renamed, plus the draft text in its input.
	const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

	// Keep the tab strip in sync with the manager.
	useEffect(() => terminalManager.subscribe(() => setState(terminalManager.getState())), []);

	// Re-root terminals on project switch (kills stale tabs, opens one in the new
	// cwd), then make sure at least one tab exists.
	useEffect(() => {
		if (disabled) return;
		terminalManager.setWorkspace(ptyController, workspace);
		terminalManager.ensure(ptyController);
	}, [ptyController, disabled, workspace]);

	// Attach the active tab's terminal into the host; refit on resize.
	useEffect(() => {
		if (disabled) return;
		const host = hostRef.current;
		const session = terminalManager.getActive();
		if (!host || !session) return;

		// Detach whatever tab was showing (its container stays alive in memory, so
		// scrollback is preserved) before mounting the active tab's container.
		while (host.firstChild) host.removeChild(host.firstChild);
		session.attach(host);

		const observer = new ResizeObserver(() => {
			try {
				session.fit.fit();
			} catch {
				return;
			}
			if (session.started) ptyController.resize(session.ptyId, session.term.cols, session.term.rows);
		});
		observer.observe(host);

		return () => {
			observer.disconnect();
			// Leave the session attached-but-detached; DOM stays alive in its
			// container so scrollback survives switching tabs or closing the panel.
		};
	}, [ptyController, disabled, state.activeId]);

	if (disabled) {
		return (
			<div className="terminal-view">
				<p className="terminal-hint">Engine not ready.</p>
			</div>
		);
	}

	const activeExited = state.tabs.find(t => t.id === state.activeId)?.exited ?? false;

	const commitRename = (): void => {
		if (editing) terminalManager.rename(editing.id, editing.draft);
		setEditing(null);
	};

	return (
		<div className="terminal-view">
			<div className="terminal-tabs">
				<div className="terminal-tab-list">
					{state.tabs.map(tab => (
						<div
							key={tab.id}
							className={`terminal-tab${tab.id === state.activeId ? " terminal-tab--active" : ""}${
								tab.exited ? " terminal-tab--exited" : ""
							}`}
						>
							{editing?.id === tab.id ? (
								<input
									type="text"
									className="terminal-tab-rename"
									autoFocus
									value={editing.draft}
									onChange={event => setEditing({ id: tab.id, draft: event.target.value })}
									onBlur={commitRename}
									onKeyDown={event => {
										if (event.key === "Enter") commitRename();
										else if (event.key === "Escape") setEditing(null);
									}}
								/>
							) : (
								<button
									type="button"
									className="terminal-tab-label"
									onClick={() => terminalManager.activate(tab.id)}
									onDoubleClick={() => setEditing({ id: tab.id, draft: tab.title })}
									title={`${tab.title} (double-click to rename)`}
								>
									{tab.title}
								</button>
							)}
							<button
								type="button"
								className="terminal-tab-close"
								onClick={() => terminalManager.close(tab.id)}
								title="Close tab"
								aria-label={`Close ${tab.title}`}
							>
								×
							</button>
						</div>
					))}
				</div>
				<button
					type="button"
					className="terminal-tab-add"
					onClick={() => terminalManager.open(ptyController)}
					title="New terminal"
					aria-label="New terminal"
				>
					+
				</button>
			</div>
			<div className="terminal-host" ref={hostRef} />
			{activeExited ? (
				<div className="terminal-exit-bar">
					<span>Terminal ended.</span>
					<button
						type="button"
						className="terminal-restart"
						onClick={() => {
							if (state.activeId) terminalManager.restart(ptyController, state.activeId);
						}}
					>
						Restart
					</button>
				</div>
			) : null}
		</div>
	);
}

function viewTitle(view: WorkspaceToolView): string {
	switch (view) {
		case "review":
			return "Review";
		case "terminal":
			return "Terminal";
		case "browser":
			return "Browser";
		case "files":
			return "Files";
		case "side-chat":
			return "Side chat";
		default:
			return "Workspace";
	}
}

export function WorkspaceToolsPanel({
	view,
	changes,
	disabled,
	onClose,
	onRefreshChanges,
	onStageHunks,
	onUnstage,
	onSelectView,
	ptyController,
	workspace,
}: WorkspaceToolsPanelProps) {
	const isReview = view === "review";
	// Both the review and terminal panels can be dragged wider; the rest use their
	// natural width.
	const isResizable = view === "review" || view === "terminal";
	const [reviewWidth, setReviewWidth] = useState(DEFAULT_REVIEW_WIDTH);

	useEffect(() => {
		if (!isResizable) return;
		const onWindowResize = (): void => {
			setReviewWidth(width => clampReviewWidth(width));
		};
		onWindowResize();
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, [isResizable]);

	const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = reviewWidth;
		const onMove = (moveEvent: PointerEvent): void => {
			const next = startWidth + startX - moveEvent.clientX;
			setReviewWidth(clampReviewWidth(next));
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	return (
		<aside
			className={`workspace-tools-panel workspace-tools-panel--${view}`}
			style={isResizable ? { width: reviewWidth, flexBasis: reviewWidth } : undefined}
		>
			{isResizable ? <div className="tools-panel-resize-handle" onPointerDown={startResize} /> : null}
			<div className={`tools-panel-head${isReview ? " tools-panel-head--review" : ""}`}>
				<div className="tools-panel-title">
					{isReview ? (
						<>
							<span className="tools-review-tab">
								<SquarePen size={15} strokeWidth={1.8} />
								Review
							</span>
							<button
								type="button"
								className="tools-review-add"
								title="New review tab"
								aria-label="New review tab"
							>
								<Plus size={17} strokeWidth={1.8} />
							</button>
						</>
					) : (
						viewTitle(view)
					)}
				</div>
				<div className="tools-panel-actions">
					{view !== "menu" ? (
						<button type="button" className="tools-panel-link" onClick={() => onSelectView("menu")}>
							All tools
						</button>
					) : null}
					<button
						type="button"
						className="top-icon-button"
						title="Close side panel"
						aria-label="Close side panel"
						onClick={onClose}
					>
						<PanelRightClose size={16} strokeWidth={1.8} />
					</button>
				</div>
			</div>
			<div className="tools-panel-body">
				{view === "menu" ? <FeatureMenu onSelectView={onSelectView} /> : null}
				{view === "review" ? (
					<ChangesPanel
						changes={changes}
						onRefresh={onRefreshChanges}
						onStageHunks={onStageHunks}
						onUnstage={onUnstage}
						disabled={disabled}
					/>
				) : null}
				{view === "terminal" ? (
					<TerminalView ptyController={ptyController} disabled={disabled} workspace={workspace} />
				) : null}
				{view === "browser" ? <PlaceholderView title="Browser" /> : null}
				{view === "files" ? <PlaceholderView title="Files" /> : null}
				{view === "side-chat" ? <PlaceholderView title="Side chat" /> : null}
			</div>
		</aside>
	);
}
