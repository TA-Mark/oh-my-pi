interface Window {
	desktop: {
		startEngine(cwd?: string): Promise<void>;
		stopEngine(): Promise<void>;
		sendRpcLine(line: string): Promise<void>;
		pickWorkspaceFolder(): Promise<string | null>;
		startWorkspaceWatcher(root: string): Promise<string>;
		stopWorkspaceWatcher(): Promise<void>;
		onWorkspaceFilesChanged(cb: (value: { root: string; paths: string[] }) => void): () => void;
		openExternalUrl(url: string): Promise<void>;
		openPath(target: string): Promise<string>;
		revealItem(target: string): Promise<void>;
		writeClipboardText(value: string): Promise<void>;
		confirmPermission(message: string): Promise<boolean>;
		collectDiagnostics(): Promise<unknown>;
		exportDiagnosticsBundle(): Promise<string>;
		openNewWindow(): Promise<void>;
		onRpcFrame(cb: (line: string) => void): () => void;
		onRpcStderr(cb: (line: string) => void): () => void;
		onEngineExit(cb: () => void): () => void;
		startSideEngine(cwd?: string): Promise<void>;
		stopSideEngine(): Promise<void>;
		sendSideRpcLine(line: string): Promise<void>;
		onSideRpcFrame(cb: (line: string) => void): () => void;
		onSideRpcStderr(cb: (line: string) => void): () => void;
		onSideEngineExit(cb: () => void): () => void;
		listScheduledTasks(): Promise<unknown[]>;
		upsertScheduledTask(input: unknown): Promise<unknown>;
		removeScheduledTask(id: string): Promise<void>;
		runScheduledTaskNow(id: string): Promise<void>;
		onScheduledTasksChanged(cb: (tasks: unknown[]) => void): () => void;
	};
}
