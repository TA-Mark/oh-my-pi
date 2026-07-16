import { contextBridge, ipcRenderer } from "electron";

const api = {
	startEngine: (cwd?: string) => ipcRenderer.invoke("engine:start", cwd) as Promise<void>,
	stopEngine: () => ipcRenderer.invoke("engine:stop") as Promise<void>,
	sendRpcLine: (line: string) => ipcRenderer.invoke("engine:send", line) as Promise<void>,
	pickWorkspaceFolder: () => ipcRenderer.invoke("workspace:pick") as Promise<string | null>,
	openExternalUrl: (url: string) => ipcRenderer.invoke("shell:open", url) as Promise<void>,
	revealItem: (target: string) => ipcRenderer.invoke("shell:reveal", target) as Promise<void>,
	writeClipboardText: (value: string) => ipcRenderer.invoke("clipboard:write-text", value) as Promise<void>,
	confirmPermission: (message: string) => ipcRenderer.invoke("permission:confirm", message) as Promise<boolean>,
	collectDiagnostics: () => ipcRenderer.invoke("diagnostics:collect") as Promise<{
		appVersion: string;
		platform: string;
		arch: string;
		engineRunning: boolean;
		protocolVersion: number | null;
		lastDiagnosticId: string | null;
		logTail: string;
	}>,
	onRpcFrame: (cb: (line: string) => void) => { const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line); ipcRenderer.on("rpc:frame", listener); return () => ipcRenderer.removeListener("rpc:frame", listener); },
	onRpcStderr: (cb: (line: string) => void) => { const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line); ipcRenderer.on("rpc:stderr", listener); return () => ipcRenderer.removeListener("rpc:stderr", listener); },
	onEngineExit: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on("rpc:exit", listener); return () => ipcRenderer.removeListener("rpc:exit", listener); },
	startSideEngine: (cwd?: string) => ipcRenderer.invoke("engine:side:start", cwd) as Promise<void>,
	stopSideEngine: () => ipcRenderer.invoke("engine:side:stop") as Promise<void>,
	sendSideRpcLine: (line: string) => ipcRenderer.invoke("engine:side:send", line) as Promise<void>,
	onSideRpcFrame: (cb: (line: string) => void) => { const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line); ipcRenderer.on("side-rpc:frame", listener); return () => ipcRenderer.removeListener("side-rpc:frame", listener); },
	onSideRpcStderr: (cb: (line: string) => void) => { const listener = (_event: Electron.IpcRendererEvent, line: string) => cb(line); ipcRenderer.on("side-rpc:stderr", listener); return () => ipcRenderer.removeListener("side-rpc:stderr", listener); },
	onSideEngineExit: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on("side-rpc:exit", listener); return () => ipcRenderer.removeListener("side-rpc:exit", listener); },
	listScheduledTasks: () => ipcRenderer.invoke("scheduled:list") as Promise<unknown[]>,
	upsertScheduledTask: (input: unknown) => ipcRenderer.invoke("scheduled:upsert", input) as Promise<unknown>,
	removeScheduledTask: (id: string) => ipcRenderer.invoke("scheduled:remove", id) as Promise<void>,
	runScheduledTaskNow: (id: string) => ipcRenderer.invoke("scheduled:run-now", id) as Promise<void>,
	onScheduledTasksChanged: (cb: (tasks: unknown[]) => void) => { const listener = (_event: Electron.IpcRendererEvent, value: string) => cb(JSON.parse(value) as unknown[]); ipcRenderer.on("scheduled:changed", listener); return () => ipcRenderer.removeListener("scheduled:changed", listener); },
};

contextBridge.exposeInMainWorld("desktop", api);
