import { contextBridge, ipcRenderer } from "electron";

const api = {
	startEngine: (cwd?: string) => ipcRenderer.invoke("engine:start", cwd),
	stopEngine: () => ipcRenderer.invoke("engine:stop"),
	sendRpcLine: (line: string) => ipcRenderer.invoke("engine:send", line),
	pickWorkspaceFolder: () => ipcRenderer.invoke("workspace:pick"),
	startWorkspaceWatcher: (root: string) => ipcRenderer.invoke("workspace:watch:start", root),
	stopWorkspaceWatcher: () => ipcRenderer.invoke("workspace:watch:stop"),
	onWorkspaceFilesChanged: (cb: (value: { root: string; paths: string[] }) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, value: string) => cb(JSON.parse(value) as { root: string; paths: string[] });
		ipcRenderer.on("workspace:changed", listener);
		return () => ipcRenderer.removeListener("workspace:changed", listener);
	},
	openExternalUrl: (url: string) => ipcRenderer.invoke("shell:open", url),
	openPath: (target: string) => ipcRenderer.invoke("shell:open-path", target),
	revealItem: (target: string) => ipcRenderer.invoke("shell:reveal", target),
	writeClipboardText: (value: string) => ipcRenderer.invoke("clipboard:write-text", value),
	confirmPermission: (message: string) => ipcRenderer.invoke("permission:confirm", message),
	collectDiagnostics: () => ipcRenderer.invoke("diagnostics:collect"),
	exportDiagnosticsBundle: () => ipcRenderer.invoke("diagnostics:export"),
	openNewWindow: () => ipcRenderer.invoke("window:new"),
	onRpcFrame: (cb: (line: string) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line);
		ipcRenderer.on("rpc:frame", listener);
		return () => ipcRenderer.removeListener("rpc:frame", listener);
	},
	onRpcStderr: (cb: (line: string) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line);
		ipcRenderer.on("rpc:stderr", listener);
		return () => ipcRenderer.removeListener("rpc:stderr", listener);
	},
	onEngineExit: (cb: () => void) => {
		const listener = () => cb();
		ipcRenderer.on("rpc:exit", listener);
		return () => ipcRenderer.removeListener("rpc:exit", listener);
	},
	startSideEngine: (cwd?: string) => ipcRenderer.invoke("engine:side:start", cwd),
	stopSideEngine: () => ipcRenderer.invoke("engine:side:stop"),
	sendSideRpcLine: (line: string) => ipcRenderer.invoke("engine:side:send", line),
	onSideRpcFrame: (cb: (line: string) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line);
		ipcRenderer.on("side-rpc:frame", listener);
		return () => ipcRenderer.removeListener("side-rpc:frame", listener);
	},
	onSideRpcStderr: (cb: (line: string) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line);
		ipcRenderer.on("side-rpc:stderr", listener);
		return () => ipcRenderer.removeListener("side-rpc:stderr", listener);
	},
	onSideEngineExit: (cb: () => void) => {
		const listener = () => cb();
		ipcRenderer.on("side-rpc:exit", listener);
		return () => ipcRenderer.removeListener("side-rpc:exit", listener);
	},
	listScheduledTasks: () => ipcRenderer.invoke("scheduled:list"),
	upsertScheduledTask: (input: unknown) => ipcRenderer.invoke("scheduled:upsert", input),
	removeScheduledTask: (id: string) => ipcRenderer.invoke("scheduled:remove", id),
	runScheduledTaskNow: (id: string) => ipcRenderer.invoke("scheduled:run-now", id),
	onScheduledTasksChanged: (cb: (tasks: unknown[]) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, value: string) => cb(JSON.parse(value) as unknown[]);
		ipcRenderer.on("scheduled:changed", listener);
		return () => ipcRenderer.removeListener("scheduled:changed", listener);
	},
};

contextBridge.exposeInMainWorld("desktop", api);
