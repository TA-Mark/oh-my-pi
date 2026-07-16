/** Secure renderer bridge exposed by Electron preload. */
export function pickWorkspaceFolder(): Promise<string | null> {
	return window.desktop.pickWorkspaceFolder();
}

export function openExternalUrl(url: string): Promise<void> {
	return window.desktop.openExternalUrl(url);
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
	return window.desktop.collectDiagnostics();
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

export function onRpcFrame(cb: (line: string) => void): () => void {
	return window.desktop.onRpcFrame(cb);
}

export function onRpcStderr(cb: (line: string) => void): () => void {
	return window.desktop.onRpcStderr(cb);
}

export function onEngineExit(cb: () => void): () => void {
	return window.desktop.onEngineExit(cb);
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
export function onSideRpcFrame(cb: (line: string) => void): () => void {
	return window.desktop.onSideRpcFrame(cb);
}
export function onSideRpcStderr(cb: (line: string) => void): () => void {
	return window.desktop.onSideRpcStderr(cb);
}
export function onSideEngineExit(cb: () => void): () => void {
	return window.desktop.onSideEngineExit(cb);
}

export const sideEngineTransport = {
	startEngine: startSideEngine,
	stopEngine: stopSideEngine,
	sendRpcLine: sendSideRpcLine,
	onRpcFrame: onSideRpcFrame,
	onRpcStderr: onSideRpcStderr,
	onEngineExit: onSideEngineExit,
};
