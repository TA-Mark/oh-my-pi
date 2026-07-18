import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ScheduledTaskStore } from "./scheduled-tasks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let windowRef: BrowserWindow | null = null;
interface EngineRuntime {
	child: ChildProcessWithoutNullStreams;
	readyFrame: string | null;
}

const windows = new Map<number, BrowserWindow>();
const engines = new Map<number, EngineRuntime>();
const sideEngines = new Map<number, ChildProcessWithoutNullStreams>();
interface WorkspaceWatcherRuntime {
	root: string;
	watcher: nodeFs.FSWatcher;
	flushTimer: NodeJS.Timeout | null;
	pending: Set<string>;
}
const workspaceWatchers = new Map<number, WorkspaceWatcherRuntime>();
let lastDiagnosticId: string | null = null;
let scheduledTasks: ScheduledTaskStore | null = null;

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
		if (existing.readyFrame) sendTo(windowId, "rpc:frame", existing.readyFrame);
		return;
	}
	const spec = engineCommand();
	logMain("engine_start", { cwd: cwd ?? process.cwd(), command: spec.command, args: spec.args });
	const child = spawn(spec.command, spec.args, { cwd: cwd ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	const runtime: EngineRuntime = { child, readyFrame: null };
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
	ipcMain.handle("workspace:pick", async () => {
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open workspace folder" });
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
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
	const nextWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 960, minHeight: 640, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false } });
	const windowId = nextWindow.webContents.id;
	windows.set(windowId, nextWindow);
	if (!windowRef) windowRef = nextWindow;
	if (process.env.ELECTRON_RENDERER_URL) await nextWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	else await nextWindow.loadFile(path.join(__dirname, "../dist/index.html"));
	nextWindow.on("closed", () => {
		stopEngine(windowId);
		stopSideEngine(windowId);
		stopWorkspaceWatcher(windowId);
		windows.delete(windowId);
		if (windowRef === nextWindow) windowRef = windows.values().next().value ?? null;
	});
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { if (windowRef) { if (windowRef.isMinimized()) windowRef.restore(); windowRef.focus(); } });

app.whenReady().then(async () => {
	if (!primaryInstance) return;
	scheduledTasks = new ScheduledTaskStore(path.join(app.getPath("userData"), "scheduled-tasks.json"), engineCommand, tasks => broadcast("scheduled:changed", JSON.stringify(tasks)));
	await scheduledTasks.load();
	scheduledTasks.start();
	powerMonitor.on("resume", () => void scheduledTasks?.runDueTasks());
	registerIpc();
	void createWindow();
});
app.on("render-process-gone", (_event, _webContents, details) => logMain("renderer_exit", { reason: details.reason, exitCode: details.exitCode }));
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
	scheduledTasks?.stop();
	for (const windowId of windows.keys()) {
		stopEngine(windowId);
		stopSideEngine(windowId);
		stopWorkspaceWatcher(windowId);
	}
});
