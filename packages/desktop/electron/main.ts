import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ScheduledTaskStore } from "./scheduled-tasks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let windowRef: BrowserWindow | null = null;
let engine: ChildProcessWithoutNullStreams | null = null;
let sideEngine: ChildProcessWithoutNullStreams | null = null;
let lastReadyFrame: string | null = null;
let lastDiagnosticId: string | null = null;
let scheduledTasks: ScheduledTaskStore | null = null;

function redact(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(/(Bearer\s+|sk-[A-Za-z0-9_-]{8,}|api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
	}
	if (Array.isArray(value)) return value.map(redact);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [/token|secret|password|apiKey|api_key/i.test(key) ? key : key, /token|secret|password|apiKey|api_key/i.test(key) ? "[REDACTED]" : redact(item)]));
	}
	return value;
}

function logMain(event: string, details: Record<string, unknown> = {}): void {
	const entry = `${JSON.stringify(redact({ at: new Date().toISOString(), event, ...details }))}\n`;
	void fs
		.mkdir(app.getPath("logs"), { recursive: true })
		.then(() => fs.appendFile(path.join(app.getPath("logs"), "omp-electron.log"), entry))
		.catch(() => undefined);
}

function engineCommand(): { command: string; args: string[] } {
	const configured = process.env.OMP_ENGINE_PATH;
	if (configured) return { command: configured, args: ["--mode", "rpc-ui"] };
	const bundled = path.join(process.resourcesPath, process.platform === "win32" ? "omp.exe" : "omp");
	if (app.isPackaged) return { command: bundled, args: ["--mode", "rpc-ui"] };
	const repoRoot = path.resolve(__dirname, "../../..");
	return { command: process.env.BUN_BINARY ?? "bun", args: [path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "--mode", "rpc-ui"] };
}

function send(channel: string, payload: string): void {
	if (!windowRef?.isDestroyed()) windowRef?.webContents.send(channel, payload);
}

function startEngine(cwd?: string): void {
	if (engine) {
		if (lastReadyFrame) send("rpc:frame", lastReadyFrame);
		return;
	}
	const spec = engineCommand();
	logMain("engine_start", { cwd: cwd ?? process.cwd(), command: spec.command, args: spec.args });
	const child = spawn(spec.command, spec.args, { cwd: cwd ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	engine = child;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const frame = JSON.parse(line) as { type?: unknown };
				if (frame.type === "ready") lastReadyFrame = line;
			} catch {
				// Forward malformed lines for the renderer/client to classify.
			}
			send("rpc:frame", line);
		}
	});
	child.stderr.on("data", (chunk: string) => send("rpc:stderr", chunk));
	child.once("error", error => {
		const diagnosticId = `engine-${Date.now()}-${child.pid ?? "unknown"}`;
		lastDiagnosticId = diagnosticId;
		logMain("engine_error", { diagnosticId, message: error.message });
		send("rpc:stderr", `Failed to start engine (${diagnosticId}): ${error.message}`);
	});
	child.once("exit", (code, signal) => {
		const diagnosticId = `engine-${Date.now()}-${child.pid ?? "unknown"}`;
		lastDiagnosticId = diagnosticId;
		logMain("engine_exit", { diagnosticId, code, signal });
		if (buffer.trim()) send("rpc:frame", buffer);
		if (engine === child) engine = null;
		lastReadyFrame = null;
		send("rpc:exit", "");
	});
}

function stopEngine(): void {
	if (!engine) return;
	logMain("engine_stop");
	engine.kill();
	engine = null;
	lastReadyFrame = null;
}

function startSideEngine(cwd?: string): void {
	if (sideEngine) return;
	const spec = engineCommand();
	const child = spawn(spec.command, spec.args, { cwd: cwd ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
	sideEngine = child;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let buffer = "";
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) send("side-rpc:frame", line);
	});
	child.stderr.on("data", (chunk: string) => send("side-rpc:stderr", chunk));
	child.once("exit", () => {
		if (sideEngine === child) sideEngine = null;
		if (buffer.trim()) send("side-rpc:frame", buffer);
		send("side-rpc:exit", "");
	});
}

function stopSideEngine(): void {
	if (!sideEngine) return;
	sideEngine.kill();
	sideEngine = null;
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
	ipcMain.handle("engine:start", (_event, cwd?: string) => startEngine(cwd));
	ipcMain.handle("engine:stop", () => stopEngine());
	ipcMain.handle("engine:send", (_event, line: string) => {
		if (!engine?.stdin.writable) throw new Error("engine is not running");
		engine.stdin.write(`${line}\n`);
	});
	ipcMain.handle("engine:side:start", (_event, cwd?: string) => startSideEngine(cwd));
	ipcMain.handle("engine:side:stop", () => stopSideEngine());
	ipcMain.handle("engine:side:send", (_event, line: string) => {
		if (!sideEngine?.stdin.writable) throw new Error("side engine is not running");
		sideEngine.stdin.write(`${line}\n`);
	});
	ipcMain.handle("workspace:pick", async () => {
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open workspace folder" });
		return result.canceled ? null : result.filePaths[0] ?? null;
	});
	ipcMain.handle("shell:open", (_event, url: string) => shell.openExternal(url));
	ipcMain.handle("shell:reveal", (_event, target: string) => shell.showItemInFolder(target));
	ipcMain.handle("clipboard:write-text", (_event, value: string) => clipboard.writeText(value));
	ipcMain.handle("permission:confirm", async (_event, message: string) => {
		const result = await dialog.showMessageBox({
			type: "question",
			buttons: ["Cancel", "Allow"],
			defaultId: 0,
			cancelId: 0,
			title: "OMP permission request",
			message,
		});
		return result.response === 1;
	});
	ipcMain.handle("diagnostics:collect", async () => {
		const logPath = path.join(app.getPath("logs"), "omp-electron.log");
		let logTail = "";
		try {
			const log = await fs.readFile(logPath, "utf8");
			logTail = log.slice(-64 * 1024);
		} catch {
			logTail = "(no Electron log available)";
		}
		const home = app.getPath("home");
		const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const safeLog = redact(logTail.replace(new RegExp(escapedHome, "gi"), "<HOME>"));
		let protocolVersion: number | null = null;
		if (lastReadyFrame) {
			try {
				const ready = JSON.parse(lastReadyFrame) as { protocolVersion?: unknown };
				if (typeof ready.protocolVersion === "number") protocolVersion = ready.protocolVersion;
			} catch {
				protocolVersion = null;
			}
		}
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			engineRunning: engine !== null,
			protocolVersion,
			lastDiagnosticId,
			logTail: typeof safeLog === "string" ? safeLog : "",
			scheduledTasks: redact(scheduledTasks?.diagnostics() ?? { taskCount: 0, runningTaskIds: [], tasks: [] }),
		};
	});
}

async function createWindow(): Promise<void> {
	windowRef = new BrowserWindow({
		width: 1440,
		height: 960,
		minWidth: 960,
		minHeight: 640,
		webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
	});
	if (process.env.ELECTRON_RENDERER_URL) await windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
	else await windowRef.loadFile(path.join(__dirname, "../dist/index.html"));
windowRef.on("closed", () => { stopEngine(); stopSideEngine(); windowRef = null; });
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => {
	if (!windowRef) return;
	if (windowRef.isMinimized()) windowRef.restore();
	windowRef.focus();
});

app.whenReady().then(async () => {
	if (!primaryInstance) return;
	scheduledTasks = new ScheduledTaskStore(path.join(app.getPath("userData"), "scheduled-tasks.json"), engineCommand, tasks => send("scheduled:changed", JSON.stringify(tasks)));
	await scheduledTasks.load();
	scheduledTasks.start();
	powerMonitor.on("resume", () => void scheduledTasks?.runDueTasks());
	registerIpc();
	void createWindow();
});
app.on("render-process-gone", (_event, _webContents, details) =>
	logMain("renderer_exit", { reason: details.reason, exitCode: details.exitCode }),
);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { scheduledTasks?.stop(); stopEngine(); });
