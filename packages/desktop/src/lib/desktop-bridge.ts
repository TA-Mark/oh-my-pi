import type { ScheduledTask, ScheduledTaskInput } from "./rpc-protocol";

export function pickWorkspaceFolder(): Promise<string | null> {
	return window.desktop.pickWorkspaceFolder();
}

export function resolveWorkspace(requested?: string): Promise<string> {
	return window.desktop.resolveWorkspace(requested);
}

export function rememberWorkspace(workspace: string): Promise<void> {
	return window.desktop.rememberWorkspace(workspace);
}

export function startWorkspaceWatcher(root: string): Promise<string> {
	return window.desktop.startWorkspaceWatcher(root);
}

export function stopWorkspaceWatcher(): Promise<void> {
	return window.desktop.stopWorkspaceWatcher();
}

export function onWorkspaceFilesChanged(cb: (value: { root: string; paths: string[] }) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onWorkspaceFilesChanged(cb));
}
export function openExternalUrl(url: string): Promise<void> {
	return window.desktop.openExternalUrl(url);
}
export function openPath(target: string): Promise<string> {
	return window.desktop.openPath(target);
}
export function revealItem(target: string): Promise<void> {
	return window.desktop.revealItem(target);
}
export function writeClipboardText(value: string): Promise<void> {
	return window.desktop.writeClipboardText(value);
}
export function confirmPermission(message: string): Promise<boolean> {
	return window.desktop.confirmPermission(message);
}
export function openNewWindow(): Promise<void> {
	return window.desktop.openNewWindow();
}

export interface DiagnosticsSnapshot {
	appVersion: string;
	platform: string;
	arch: string;
	engineRunning: boolean;
	protocolVersion: number | null;
	lastDiagnosticId: string | null;
	logTail: string;
	scheduledTasks: {
		taskCount: number;
		runningTaskIds: string[];
		tasks: Array<{
			id: string;
			name: string;
			enabled: boolean;
			nextRunAt: string;
			lastRunAt?: string;
			lastStatus?: string;
			lastError?: string;
		}>;
	};
}

export function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
	return window.desktop.collectDiagnostics() as Promise<DiagnosticsSnapshot>;
}
export function exportDiagnosticsBundle(): Promise<string> {
	return window.desktop.exportDiagnosticsBundle() as Promise<string>;
}
export function startEngine(cwd?: string): Promise<void> {
	return window.desktop.startEngine(cwd);
}
export function stopEngine(): Promise<void> {
	return window.desktop.stopEngine();
}
export function sendRpcLine(line: string): Promise<void> {
	return window.desktop.sendRpcLine(line);
}
export function onRpcFrame(cb: (line: string) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onRpcFrame(cb));
}
export function onRpcStderr(cb: (line: string) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onRpcStderr(cb));
}
export function onEngineExit(cb: () => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onEngineExit(cb));
}

export function startSideEngine(cwd?: string): Promise<void> {
	return window.desktop.startSideEngine(cwd);
}
export function stopSideEngine(): Promise<void> {
	return window.desktop.stopSideEngine();
}
export function sendSideRpcLine(line: string): Promise<void> {
	return window.desktop.sendSideRpcLine(line);
}
export function onSideRpcFrame(cb: (line: string) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onSideRpcFrame(cb));
}
export function onSideRpcStderr(cb: (line: string) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onSideRpcStderr(cb));
}
export function onSideEngineExit(cb: () => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onSideEngineExit(cb));
}

export const sideEngineTransport = {
	start: startSideEngine,
	stop: stopSideEngine,
	send: sendSideRpcLine,
	onFrame: onSideRpcFrame,
	onStderr: onSideRpcStderr,
	onExit: onSideEngineExit,
};
export function listScheduledTasks(): Promise<ScheduledTask[]> {
	return window.desktop.listScheduledTasks() as Promise<ScheduledTask[]>;
}
export function upsertScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
	return window.desktop.upsertScheduledTask(input) as Promise<ScheduledTask>;
}
export function removeScheduledTask(id: string): Promise<void> {
	return window.desktop.removeScheduledTask(id);
}
export function runScheduledTaskNow(id: string): Promise<void> {
	return window.desktop.runScheduledTaskNow(id);
}
export function onScheduledTasksChanged(cb: (tasks: ScheduledTask[]) => void): Promise<() => void> {
	return Promise.resolve(window.desktop.onScheduledTasksChanged(value => cb(value as ScheduledTask[])));
}
