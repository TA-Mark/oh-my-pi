interface DesktopBrowserView {
	id: string;
	title: string;
	url: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	error: string | null;
}

interface DesktopBrowserViewState {
	tabs: DesktopBrowserView[];
	activeId: string | null;
}

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
		createTerminal(request: {
			id: string;
			cwd: string;
			cols: number;
			rows: number;
		}): Promise<{ id: string; title: string; shell: string; cwd: string }>;
		writeTerminal(id: string, data: string): Promise<void>;
		resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
		closeTerminal(id: string): Promise<void>;
		onTerminalData(cb: (event: { id: string; data: string }) => void): () => void;
		onTerminalExit(cb: (event: { id: string; exitCode: number; signal: number | null }) => void): () => void;
		listBrowserViews(): Promise<DesktopBrowserViewState>;
		createBrowserView(url?: string): Promise<DesktopBrowserView>;
		activateBrowserView(id: string): Promise<DesktopBrowserViewState>;
		closeBrowserView(id: string): Promise<void>;
		navigateBrowserView(id: string, value: string): Promise<DesktopBrowserView>;
		browserViewHistory(id: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
		setBrowserViewBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
		setBrowserViewVisible(visible: boolean): Promise<void>;
		extractBrowserView(id: string): Promise<{ url: string; title: string; text: string }>;
		onBrowserViewState(cb: (state: DesktopBrowserViewState) => void): () => void;
		listScheduledTasks(): Promise<unknown[]>;
		upsertScheduledTask(input: unknown): Promise<unknown>;
		removeScheduledTask(id: string): Promise<void>;
		runScheduledTaskNow(id: string): Promise<void>;
		onScheduledTasksChanged(cb: (tasks: unknown[]) => void): () => void;
	};
}
