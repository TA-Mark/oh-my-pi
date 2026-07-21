import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	powerMonitor,
	shell,
	WebContentsView,
	type Rectangle,
	type Session,
} from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty, type IPty } from "node-pty";
import { ScheduledTaskStore } from "./scheduled-tasks";
import { buildTerminalEnvironment } from "./terminal-environment";
import { resolveTerminalShell } from "./terminal-shell";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let windowRef: BrowserWindow | null = null;
interface EngineRuntime {
	child: ChildProcessWithoutNullStreams;
	cwd: string;
	readyFrame: string | null;
}

const windows = new Map<number, BrowserWindow>();
const engines = new Map<number, EngineRuntime>();
const sideEngines = new Map<number, ChildProcessWithoutNullStreams>();
interface TerminalRuntime {
	pty: IPty;
}
interface TerminalCreateRequest {
	id: string;
	cwd: string;
	cols: number;
	rows: number;
}
const terminals = new Map<number, Map<string, TerminalRuntime>>();
interface BrowserViewDescriptor {
	id: string;
	title: string;
	url: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: string | null;
}
interface BrowserViewRuntime {
	view: WebContentsView;
	descriptor: BrowserViewDescriptor;
}
interface BrowserWindowRuntime {
	views: Map<string, BrowserViewRuntime>;
	activeId: string | null;
	bounds: Rectangle | null;
	visible: boolean;
}
interface BrowserViewBoundsRequest {
	x: number;
	y: number;
	width: number;
	height: number;
}
const browserViews = new Map<number, BrowserWindowRuntime>();
const securedBrowserSessions = new WeakSet<Session>();
interface WorkspaceWatcherRuntime {
	root: string;
	watcher: nodeFs.FSWatcher;
	flushTimer: NodeJS.Timeout | null;
	pending: Set<string>;
}
const workspaceWatchers = new Map<number, WorkspaceWatcherRuntime>();
let lastDiagnosticId: string | null = null;
let scheduledTasks: ScheduledTaskStore | null = null;
let preferredWorkspace: string | null = null;

function workspaceStatePath(): string {
	return path.join(app.getPath("userData"), "workspace.json");
}

async function loadPreferredWorkspace(): Promise<void> {
	try {
		const value = JSON.parse(await fs.readFile(workspaceStatePath(), "utf8")) as { path?: unknown };
		if (typeof value.path === "string" && value.path.trim()) preferredWorkspace = value.path;
	} catch {
		// First launch or a corrupted preference: resolveWorkspace() supplies home.
	}
}

async function rememberWorkspace(workspace: string): Promise<void> {
	const resolved = await resolveWorkspace(workspace);
	preferredWorkspace = resolved;
	await fs.mkdir(app.getPath("userData"), { recursive: true });
	await fs.writeFile(workspaceStatePath(), JSON.stringify({ path: resolved }), "utf8");
}

function redact(value: unknown): unknown {
	if (typeof value === "string") return value.replace(/(Bearer\s+|sk-[A-Za-z0-9_-]{8,}|api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
	if (Array.isArray(value)) return value.map(redact);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|apiKey|api_key/i.test(key) ? "[REDACTED]" : redact(item)]));
	}
	return value;
}

function logMain(event: string, details: Record<string, unknown> = {}): void {
	const entry = `${JSON.stringify(redact({ at: new Date().toISOString(), event, ...details }))}\n`;
	void fs.mkdir(app.getPath("logs"), { recursive: true }).then(() => fs.appendFile(path.join(app.getPath("logs"), "omp-electron.log"), entry)).catch(() => undefined);
}

function engineCommand(): { command: string; args: string[] } {
	const configured = process.env.OMP_ENGINE_PATH;
	if (configured) return { command: configured, args: ["--mode", "rpc-ui"] };
	const bundled = path.join(process.resourcesPath, process.platform === "win32" ? "omp.exe" : "omp");
	if (app.isPackaged) return { command: bundled, args: ["--mode", "rpc-ui"] };
	const repoRoot = path.resolve(__dirname, "../../..");
	return { command: process.env.BUN_BINARY ?? "bun", args: [path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "--mode", "rpc-ui"] };
}

function appIconPath(): string {
	return app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(__dirname, "../resources/icon.png");
}

function sendTo(windowId: number, channel: string, payload: string): void {
	const target = windows.get(windowId);
	if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
}

function broadcast(channel: string, payload: string): void {
	for (const [windowId] of windows) sendTo(windowId, channel, payload);
}

function validateExternalUrl(value: string): string {
	const url = new URL(value);
	if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Only credential-free http(s) and mailto URLs may be opened externally');
	}
	return url.toString();
}

function wireEngine(
	windowId: number,
	child: ChildProcessWithoutNullStreams,
	frameChannel: string,
	stderrChannel: string,
	exitChannel: string,
	rememberReady: boolean,
	onReady: (frame: string) => void,
): void {
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			if (rememberReady) {
				try {
					if ((JSON.parse(line) as { type?: unknown }).type === "ready") onReady(line);
				} catch {
					// Forward malformed lines for the renderer/client to classify.
				}
			}
			sendTo(windowId, frameChannel, line);
		}
	});
	child.stderr.on("data", (chunk: string) => sendTo(windowId, stderrChannel, chunk));
	child.once("error", error => {
		const diagnosticId = `engine-${Date.now()}-${child.pid ?? "unknown"}`;
		lastDiagnosticId = diagnosticId;
		logMain("engine_error", { diagnosticId, message: error.message });
		sendTo(windowId, stderrChannel, `Failed to start engine (${diagnosticId}): ${error.message}`);
	});
	child.once("exit", (code, signal) => {
		const diagnosticId = `engine-${Date.now()}-${child.pid ?? "unknown"}`;
		lastDiagnosticId = diagnosticId;
		logMain("engine_exit", { diagnosticId, code, signal });
		if (buffer.trim()) sendTo(windowId, frameChannel, buffer);
		sendTo(windowId, exitChannel, "");
	});
}

function startEngine(windowId: number, cwd?: string): void {
	const existing = engines.get(windowId);
	if (existing) {
		if (cwd && path.resolve(cwd) !== existing.cwd) {
			stopEngine(windowId);
		} else {
			if (existing.readyFrame) sendTo(windowId, "rpc:frame", existing.readyFrame);
			return;
		}
	}
	const spec = engineCommand();
	const engineCwd = path.resolve(cwd ?? process.cwd());
	logMain("engine_start", { cwd: engineCwd, command: spec.command, args: spec.args });
	const child = spawn(spec.command, spec.args, { cwd: engineCwd, stdio: ["pipe", "pipe", "pipe"] });
	const runtime: EngineRuntime = { child, cwd: engineCwd, readyFrame: null };
	engines.set(windowId, runtime);
	wireEngine(windowId, child, "rpc:frame", "rpc:stderr", "rpc:exit", true, frame => {
		if (engines.get(windowId)?.child === child) runtime.readyFrame = frame;
	});
	child.once("exit", () => {
		if (engines.get(windowId)?.child === child) engines.delete(windowId);
	});
}

function stopEngine(windowId: number): void {
	const runtime = engines.get(windowId);
	if (!runtime) return;
	logMain("engine_stop", { windowId });
	engines.delete(windowId);
	runtime.child.kill();
}

function startSideEngine(windowId: number, cwd?: string): void {
	if (sideEngines.has(windowId)) return;
	const spec = engineCommand();
	const child = spawn(spec.command, spec.args, { cwd: cwd ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	sideEngines.set(windowId, child);
	wireEngine(windowId, child, "side-rpc:frame", "side-rpc:stderr", "side-rpc:exit", false, () => undefined);
	child.once("exit", () => {
		if (sideEngines.get(windowId) === child) sideEngines.delete(windowId);
	});
}

function stopSideEngine(windowId: number): void {
	const child = sideEngines.get(windowId);
	if (!child) return;
	sideEngines.delete(windowId);
	child.kill();
}

function terminalDimensions(value: number, fallback: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(2, Math.min(maximum, Math.floor(value)));
}

function closeTerminal(windowId: number, terminalId: string): void {
	const windowTerminals = terminals.get(windowId);
	const runtime = windowTerminals?.get(terminalId);
	if (!runtime) return;
	windowTerminals?.delete(terminalId);
	if (windowTerminals?.size === 0) terminals.delete(windowId);
	try {
		runtime.pty.kill();
	} catch (error) {
		logMain("terminal_close_error", {
			windowId,
			terminalId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function stopTerminals(windowId: number): void {
	const windowTerminals = terminals.get(windowId);
	if (!windowTerminals) return;
	for (const terminalId of [...windowTerminals.keys()]) closeTerminal(windowId, terminalId);
}

function browserWindowRuntime(windowId: number): BrowserWindowRuntime {
	const existing = browserViews.get(windowId);
	if (existing) return existing;
	const runtime: BrowserWindowRuntime = {
		views: new Map<string, BrowserViewRuntime>(),
		activeId: null,
		bounds: null,
		visible: false,
	};
	browserViews.set(windowId, runtime);
	return runtime;
}

function browserDescriptor(runtime: BrowserViewRuntime): BrowserViewDescriptor {
	const contents = runtime.view.webContents;
	return {
		...runtime.descriptor,
		canGoBack: contents.navigationHistory.canGoBack(),
		canGoForward: contents.navigationHistory.canGoForward(),
	};
}

function browserState(windowId: number): { tabs: BrowserViewDescriptor[]; activeId: string | null } {
	const runtime = browserWindowRuntime(windowId);
	return {
		tabs: [...runtime.views.values()].map(browserDescriptor),
		activeId: runtime.activeId,
	};
}

function sendBrowserState(windowId: number): void {
	sendTo(windowId, "browser-view:state", JSON.stringify(browserState(windowId)));
}

function validBrowserUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "about:blank") return "about:blank";
	let normalized = trimmed;
	if (!/^[a-z][a-z\d+.-]*:/i.test(normalized)) {
		const looksLikeAddress = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[^\s]+\.[^\s]+)(?::\d+)?(?:[/?#]|$)/i.test(
			normalized,
		);
		normalized = looksLikeAddress
			? `https://${normalized}`
			: `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
	}
	const url = new URL(normalized);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Only credential-free http(s) URLs may be opened in Browser");
	}
	return url.toString();
}

function safeBrowserTitle(title: string, url: string): string {
	const clean = title.replace(/\s+/g, " ").trim();
	if (clean) return clean.slice(0, 120);
	if (url === "about:blank") return "New tab";
	try {
		return new URL(url).hostname || "Browser";
	} catch {
		return "Browser";
	}
}

function configureBrowserSession(browserSession: Session): void {
	if (securedBrowserSessions.has(browserSession)) return;
	securedBrowserSessions.add(browserSession);
	browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	browserSession.on("will-download", event => event.preventDefault());
}

function syncBrowserViewVisibility(windowId: number): void {
	const runtime = browserViews.get(windowId);
	if (!runtime) return;
	for (const [id, browser] of runtime.views) {
		const shouldShow =
			runtime.visible &&
			runtime.bounds !== null &&
			id === runtime.activeId &&
			browser.descriptor.url !== "about:blank" &&
			browser.descriptor.error === null;
		browser.view.setVisible(shouldShow);
		if (shouldShow && runtime.bounds) browser.view.setBounds(runtime.bounds);
	}
}

function createBrowserView(windowId: number, requestedUrl = "about:blank"): BrowserViewDescriptor {
	const owner = windows.get(windowId);
	if (!owner || owner.isDestroyed()) throw new Error("Browser window is not available");
	const runtime = browserWindowRuntime(windowId);
	if (runtime.views.size >= 12) throw new Error("Browser tab limit reached");
	const id = `browser-${crypto.randomUUID()}`;
	const url = validBrowserUrl(requestedUrl);
	const view = new WebContentsView({
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			partition: "persist:omp-browser",
		},
	});
	view.setBackgroundColor("#ffffff");
	view.setVisible(false);
	owner.contentView.addChildView(view);
	const descriptor: BrowserViewDescriptor = {
		id,
		title: url === "about:blank" ? "New tab" : safeBrowserTitle("", url),
		url,
		loading: url !== "about:blank",
		canGoBack: false,
		canGoForward: false,
		error: null,
	};
	const browser: BrowserViewRuntime = { view, descriptor };
	runtime.views.set(id, browser);
	runtime.activeId = id;
	configureBrowserSession(view.webContents.session);

	const updateNavigation = (nextUrl?: string): void => {
		if (nextUrl) descriptor.url = nextUrl;
		descriptor.canGoBack = view.webContents.navigationHistory.canGoBack();
		descriptor.canGoForward = view.webContents.navigationHistory.canGoForward();
		descriptor.error = null;
		syncBrowserViewVisibility(windowId);
		sendBrowserState(windowId);
	};
	view.webContents.on("did-start-loading", () => {
		descriptor.loading = true;
		descriptor.error = null;
		sendBrowserState(windowId);
	});
	view.webContents.on("did-stop-loading", () => {
		descriptor.loading = false;
		updateNavigation(view.webContents.getURL() || descriptor.url);
	});
	view.webContents.on("did-navigate", (_event, nextUrl) => updateNavigation(nextUrl));
	view.webContents.on("did-navigate-in-page", (_event, nextUrl, isMainFrame) => {
		if (isMainFrame) updateNavigation(nextUrl);
	});
	view.webContents.on("page-title-updated", (_event, title) => {
		descriptor.title = safeBrowserTitle(title, descriptor.url);
		sendBrowserState(windowId);
	});
	view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
		if (!isMainFrame || errorCode === -3) return;
		descriptor.loading = false;
		descriptor.url = failedUrl || descriptor.url;
		descriptor.error = errorDescription;
		descriptor.title = "Page unavailable";
		sendBrowserState(windowId);
	});
	view.webContents.on("will-navigate", event => {
		try {
			validBrowserUrl(event.url);
		} catch {
			event.preventDefault();
		}
	});
	view.webContents.setWindowOpenHandler(details => {
		try {
			createBrowserView(windowId, details.url);
			sendBrowserState(windowId);
		} catch (error) {
			logMain("browser_new_tab_error", {
				windowId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return { action: "deny" };
	});
	view.webContents.on("destroyed", () => {
		if (runtime.views.get(id)?.view !== view) return;
		runtime.views.delete(id);
		if (runtime.activeId === id) runtime.activeId = runtime.views.keys().next().value ?? null;
		syncBrowserViewVisibility(windowId);
		sendBrowserState(windowId);
	});
	if (url !== "about:blank") {
		void view.webContents.loadURL(url).catch(error => {
			descriptor.loading = false;
			descriptor.error = error instanceof Error ? error.message : String(error);
			sendBrowserState(windowId);
		});
	}
	syncBrowserViewVisibility(windowId);
	sendBrowserState(windowId);
	return browserDescriptor(browser);
}

function closeBrowserView(windowId: number, id: string): void {
	const runtime = browserViews.get(windowId);
	const browser = runtime?.views.get(id);
	if (!runtime || !browser) return;
	runtime.views.delete(id);
	const owner = windows.get(windowId);
	if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(browser.view);
	if (runtime.activeId === id) runtime.activeId = runtime.views.keys().next().value ?? null;
	browser.view.webContents.close({ waitForBeforeUnload: false });
	syncBrowserViewVisibility(windowId);
	sendBrowserState(windowId);
}

function stopBrowserViews(windowId: number): void {
	const runtime = browserViews.get(windowId);
	if (!runtime) return;
	browserViews.delete(windowId);
	const owner = windows.get(windowId);
	for (const browser of runtime.views.values()) {
		if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(browser.view);
		if (!browser.view.webContents.isDestroyed()) browser.view.webContents.close({ waitForBeforeUnload: false });
	}
}

function requireBrowserView(windowId: number, id: string): BrowserViewRuntime {
	const browser = browserViews.get(windowId)?.views.get(id);
	if (!browser) throw new Error("Browser tab is not available");
	return browser;
}

function browserBounds(request: BrowserViewBoundsRequest): Rectangle {
	const coordinate = (value: number): number =>
		Number.isFinite(value) ? Math.max(0, Math.min(20_000, Math.round(value))) : 0;
	return {
		x: coordinate(request.x),
		y: coordinate(request.y),
		width: Math.max(1, coordinate(request.width)),
		height: Math.max(1, coordinate(request.height)),
	};
}

async function createTerminal(
	windowId: number,
	request: TerminalCreateRequest,
): Promise<{ id: string; title: string; shell: string; cwd: string }> {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(request.id)) throw new Error("invalid terminal id");
	const windowTerminals = terminals.get(windowId) ?? new Map<string, TerminalRuntime>();
	if (windowTerminals.has(request.id)) throw new Error("terminal already exists");
	if (windowTerminals.size >= 8) throw new Error("terminal tab limit reached");
	const cwd = await fs.realpath(request.cwd);
	const stat = await fs.stat(cwd);
	if (!stat.isDirectory()) throw new Error("terminal workspace must be a directory");
	const spec = resolveTerminalShell();
	const pty = spawnPty(spec.command, spec.args, {
		name: "xterm-256color",
		cols: terminalDimensions(request.cols, 80, 500),
		rows: terminalDimensions(request.rows, 24, 200),
		cwd,
		env: { ...buildTerminalEnvironment(), TERM: "xterm-256color", COLORTERM: "truecolor" },
		...(process.platform === "win32" ? { useConpty: true } : {}),
	});
	windowTerminals.set(request.id, { pty });
	terminals.set(windowId, windowTerminals);
	pty.onData(data => sendTo(windowId, "terminal:data", JSON.stringify({ id: request.id, data })));
	pty.onExit(event => {
		const current = terminals.get(windowId)?.get(request.id);
		if (current?.pty !== pty) return;
		terminals.get(windowId)?.delete(request.id);
		if (terminals.get(windowId)?.size === 0) terminals.delete(windowId);
		sendTo(
			windowId,
			"terminal:exit",
			JSON.stringify({ id: request.id, exitCode: event.exitCode, signal: event.signal ?? null }),
		);
	});
	logMain("terminal_start", { windowId, terminalId: request.id, cwd, shell: spec.command, pid: pty.pid });
	return { id: request.id, title: path.basename(spec.command), shell: spec.command, cwd };
}

function stopWorkspaceWatcher(windowId: number): void {
	const runtime = workspaceWatchers.get(windowId);
	if (!runtime) return;
	workspaceWatchers.delete(windowId);
	if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
	runtime.watcher.close();
}

async function startWorkspaceWatcher(windowId: number, requestedRoot: string): Promise<string> {
	const root = await fs.realpath(requestedRoot);
	const stat = await fs.stat(root);
	if (!stat.isDirectory()) throw new Error("workspace watcher root must be a directory");
	stopWorkspaceWatcher(windowId);
	const pending = new Set<string>();
	let runtime: WorkspaceWatcherRuntime | undefined;
	const onChange = (_eventType: string, filename: string | Buffer | null): void => {
		const current = runtime;
		if (!current) return;
		const relativePath = filename ? filename.toString().replace(/\\/g, "/") : "";
		const first = relativePath.split("/", 1)[0]?.toLowerCase();
		if (first === ".git" || first === "node_modules") return;
		if (relativePath) pending.add(relativePath);
		if (current.flushTimer) clearTimeout(current.flushTimer);
		current.flushTimer = setTimeout(() => {
			current.flushTimer = null;
			if (workspaceWatchers.get(windowId) !== current) return;
			sendTo(windowId, "workspace:changed", JSON.stringify({ root, paths: [...pending].slice(0, 200) }));
			pending.clear();
		}, 150);
	};
	let watcher: nodeFs.FSWatcher;
	try {
		watcher = nodeFs.watch(root, { recursive: true }, onChange);
	} catch {
		watcher = nodeFs.watch(root, onChange);
	}
	runtime = { root, watcher, flushTimer: null, pending };
	watcher.on("error", error => {
		logMain("workspace_watcher_error", { windowId, root, message: error.message });
		stopWorkspaceWatcher(windowId);
	});
	workspaceWatchers.set(windowId, runtime);
	return root;
}

async function collectDiagnostics(windowId: number): Promise<Record<string, unknown>> {
	const logPath = path.join(app.getPath("logs"), "omp-electron.log");
	let logTail = "";
	try {
		logTail = (await fs.readFile(logPath, "utf8")).slice(-64 * 1024);
	} catch {
		logTail = "(no Electron log available)";
	}
	const home = app.getPath("home");
	const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const safeLog = redact(logTail.replace(new RegExp(escapedHome, "gi"), "<HOME>"));
	let protocolVersion: number | null = null;
	const readyFrame = engines.get(windowId)?.readyFrame;
	if (readyFrame) {
		try {
			const ready = JSON.parse(readyFrame) as { protocolVersion?: unknown };
			if (typeof ready.protocolVersion === "number") protocolVersion = ready.protocolVersion;
		} catch {
			protocolVersion = null;
		}
	}
	return {
		appVersion: app.getVersion(),
		platform: process.platform,
		arch: process.arch,
		engineRunning: engines.has(windowId),
		protocolVersion,
		lastDiagnosticId,
		logTail: typeof safeLog === "string" ? safeLog : "",
		scheduledTasks: redact(scheduledTasks?.diagnostics() ?? { taskCount: 0, runningTaskIds: [], tasks: [] }),
	};
}

async function resolveWorkspace(requested?: string): Promise<string> {
	if (requested) {
		try {
			const stat = await fs.stat(requested);
			if (stat.isDirectory()) return await fs.realpath(requested);
		} catch {
			// The last workspace may have been moved or deleted; use a stable fallback.
		}
	}
	return app.getPath("home");
}

function registerIpc(): void {
	ipcMain.handle("scheduled:list", () => scheduledTasks?.list() ?? []);
	ipcMain.handle("scheduled:upsert", (_event, input: Parameters<ScheduledTaskStore["upsert"]>[0]) => {
		if (!scheduledTasks) throw new Error("scheduler is not ready");
		return scheduledTasks.upsert(input);
	});
	ipcMain.handle("scheduled:remove", (_event, id: string) => {
		if (!scheduledTasks) throw new Error("scheduler is not ready");
		return scheduledTasks.remove(id);
	});
	ipcMain.handle("scheduled:run-now", (_event, id: string) => {
		if (!scheduledTasks) throw new Error("scheduler is not ready");
		return scheduledTasks.runNow(id);
	});
	ipcMain.handle("engine:start", (event, cwd?: string) => startEngine(event.sender.id, cwd));
	ipcMain.handle("engine:stop", event => stopEngine(event.sender.id));
	ipcMain.handle("engine:send", (event, line: string) => {
		const runtime = engines.get(event.sender.id);
		if (!runtime?.child.stdin.writable) throw new Error("engine is not running");
		runtime.child.stdin.write(`${line}\n`);
	});
	ipcMain.handle("engine:side:start", (event, cwd?: string) => startSideEngine(event.sender.id, cwd));
	ipcMain.handle("engine:side:stop", event => stopSideEngine(event.sender.id));
	ipcMain.handle("engine:side:send", (event, line: string) => {
		const child = sideEngines.get(event.sender.id);
		if (!child?.stdin.writable) throw new Error("side engine is not running");
		child.stdin.write(`${line}\n`);
	});
	ipcMain.handle("terminal:create", (event, request: TerminalCreateRequest) =>
		createTerminal(event.sender.id, request),
	);
	ipcMain.handle("terminal:write", (event, terminalId: string, data: string) => {
		if (data.length > 64 * 1024) throw new Error("terminal input is too large");
		const runtime = terminals.get(event.sender.id)?.get(terminalId);
		if (!runtime) throw new Error("terminal is not running");
		runtime.pty.write(data);
	});
	ipcMain.handle("terminal:resize", (event, terminalId: string, cols: number, rows: number) => {
		const runtime = terminals.get(event.sender.id)?.get(terminalId);
		if (!runtime) return;
		runtime.pty.resize(terminalDimensions(cols, 80, 500), terminalDimensions(rows, 24, 200));
	});
	ipcMain.handle("terminal:close", (event, terminalId: string) => closeTerminal(event.sender.id, terminalId));
	ipcMain.handle("browser-view:list", event => browserState(event.sender.id));
	ipcMain.handle("browser-view:create", (event, url?: string) => createBrowserView(event.sender.id, url));
	ipcMain.handle("browser-view:activate", (event, id: string) => {
		const runtime = browserWindowRuntime(event.sender.id);
		requireBrowserView(event.sender.id, id);
		runtime.activeId = id;
		syncBrowserViewVisibility(event.sender.id);
		sendBrowserState(event.sender.id);
		return browserState(event.sender.id);
	});
	ipcMain.handle("browser-view:close", (event, id: string) => closeBrowserView(event.sender.id, id));
	ipcMain.handle("browser-view:navigate", async (event, id: string, value: string) => {
		const browser = requireBrowserView(event.sender.id, id);
		const url = validBrowserUrl(value);
		browser.descriptor.loading = true;
		browser.descriptor.error = null;
		browser.descriptor.url = url;
		browser.descriptor.title = safeBrowserTitle("", url);
		syncBrowserViewVisibility(event.sender.id);
		sendBrowserState(event.sender.id);
		if (url === "about:blank") return browserDescriptor(browser);
		await browser.view.webContents.loadURL(url);
		return browserDescriptor(browser);
	});
	ipcMain.handle("browser-view:history", (event, id: string, action: "back" | "forward" | "reload" | "stop") => {
		const browser = requireBrowserView(event.sender.id, id);
		const contents = browser.view.webContents;
		if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
		else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
		else if (action === "reload") contents.reload();
		else if (action === "stop") contents.stop();
	});
	ipcMain.handle("browser-view:bounds", (event, request: BrowserViewBoundsRequest) => {
		const runtime = browserWindowRuntime(event.sender.id);
		runtime.bounds = browserBounds(request);
		syncBrowserViewVisibility(event.sender.id);
	});
	ipcMain.handle("browser-view:visible", (event, visible: boolean) => {
		const runtime = browserWindowRuntime(event.sender.id);
		runtime.visible = visible === true;
		syncBrowserViewVisibility(event.sender.id);
	});
	ipcMain.handle("browser-view:extract", async (event, id: string) => {
		const browser = requireBrowserView(event.sender.id, id);
		const value: unknown = await browser.view.webContents.executeJavaScript(
			"({ title: document.title, text: (document.body?.innerText || '').slice(0, 100000) })",
		);
		const result = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
		return {
			url: browser.descriptor.url,
			title: typeof result.title === "string" ? result.title.slice(0, 500) : browser.descriptor.title,
			text: typeof result.text === "string" ? result.text : "",
		};
	});
	ipcMain.handle("workspace:pick", async () => {
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open workspace folder" });
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	ipcMain.handle("workspace:resolve", (_event, requested?: string) => resolveWorkspace(requested));
	ipcMain.handle("workspace:remember", (_event, workspace: string) => rememberWorkspace(workspace));
	ipcMain.handle("workspace:watch:start", (event, root: string) => startWorkspaceWatcher(event.sender.id, root));
	ipcMain.handle("workspace:watch:stop", event => stopWorkspaceWatcher(event.sender.id));
	ipcMain.handle("shell:open", (_event, url: string) => shell.openExternal(validateExternalUrl(url)));
	ipcMain.handle("shell:open-path", (_event, target: string) => shell.openPath(target));
	ipcMain.handle("shell:reveal", (_event, target: string) => shell.showItemInFolder(target));
	ipcMain.handle("clipboard:write-text", (_event, value: string) => clipboard.writeText(value));
	ipcMain.handle("window:new", () => { void createWindow(); });
	ipcMain.handle("permission:confirm", async (_event, message: string) => {
		const result = await dialog.showMessageBox({ type: "question", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0, title: "OMP permission request", message });
		return result.response === 1;
	});
	ipcMain.handle("diagnostics:collect", event => collectDiagnostics(event.sender.id));
	ipcMain.handle("diagnostics:export", async event => {
		const snapshot = await collectDiagnostics(event.sender.id);
		const directory = path.join(app.getPath("userData"), "diagnostics");
		await fs.mkdir(directory, { recursive: true });
		const outputPath = path.join(directory, `omp-diagnostics-${Date.now()}.json`);
		await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2), "utf8");
		return outputPath;
	});
}

async function createWindow(): Promise<void> {
	const nextWindow = new BrowserWindow({
		width: 1440,
		height: 960,
		minWidth: 960,
		minHeight: 640,
		icon: appIconPath(),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	const windowId = nextWindow.webContents.id;
	windows.set(windowId, nextWindow);
	if (!windowRef) windowRef = nextWindow;
	// Warm the engine while Chromium loads the renderer. The renderer still owns
	// the RPC client, but it receives the cached ready frame as soon as listeners
	// are attached. This removes the engine cold-start from the visible shell path
	// on subsequent launches without guessing a workspace in the renderer.
	if (preferredWorkspace) startEngine(windowId, preferredWorkspace);
	if (process.env.ELECTRON_RENDERER_URL) await nextWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	else await nextWindow.loadFile(path.join(__dirname, "../dist/index.html"));
	nextWindow.on("closed", () => {
		stopEngine(windowId);
		stopSideEngine(windowId);
		stopTerminals(windowId);
		stopBrowserViews(windowId);
		stopWorkspaceWatcher(windowId);
		windows.delete(windowId);
		if (windowRef === nextWindow) windowRef = windows.values().next().value ?? null;
	});
}

const validationInstance = process.argv.includes("--omp-validation-instance");
const primaryInstance = validationInstance || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else if (!validationInstance) app.on("second-instance", () => { if (windowRef) { if (windowRef.isMinimized()) windowRef.restore(); windowRef.focus(); } });

app.whenReady().then(async () => {
	if (!primaryInstance) return;
	scheduledTasks = new ScheduledTaskStore(path.join(app.getPath("userData"), "scheduled-tasks.json"), engineCommand, tasks => broadcast("scheduled:changed", JSON.stringify(tasks)));
	await scheduledTasks.load();
	scheduledTasks.start();
	powerMonitor.on("resume", () => void scheduledTasks?.runDueTasks());
	registerIpc();
	await loadPreferredWorkspace();
	void createWindow();
});
app.on("render-process-gone", (_event, _webContents, details) => logMain("renderer_exit", { reason: details.reason, exitCode: details.exitCode }));
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
	scheduledTasks?.stop();
	for (const windowId of windows.keys()) {
		stopEngine(windowId);
		stopSideEngine(windowId);
		stopTerminals(windowId);
		stopBrowserViews(windowId);
		stopWorkspaceWatcher(windowId);
	}
});
