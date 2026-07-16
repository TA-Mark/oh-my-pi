interface Window {
	desktop: {
		startEngine(cwd?: string): Promise<void>;
		stopEngine(): Promise<void>;
		sendRpcLine(line: string): Promise<void>;
		pickWorkspaceFolder(): Promise<string | null>;
		openExternalUrl(url: string): Promise<void>;
		revealItem(target: string): Promise<void>;
		writeClipboardText(value: string): Promise<void>;
		confirmPermission(message: string): Promise<boolean>;
		collectDiagnostics(): Promise<{
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
		}>;
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
