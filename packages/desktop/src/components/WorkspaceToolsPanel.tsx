import { Folder, Globe, MessageCircle, PanelRightClose, Plus, SquarePen, Terminal } from "lucide-react";
import type { ComponentType, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import type {
	BranchMessage,
	GitStatus,
	HunkSelection,
	ImageContent,
	SessionStats,
	TodoPhase,
	WorkspaceEntry,
	WorkspaceFileChange,
	WorkspaceFileContent,
} from "../lib/rpc-protocol";
import { BrowserPanel } from "./BrowserPanel";
import { ChangesPanel } from "./ChangesPanel";
import { ContextInspector, type StagedContextItem } from "./ContextInspector";
import { FilesPanel } from "./FilesPanel";
import { ScheduledTasksPanel, type ScheduledTaskView } from "./ScheduledTasksPanel";
import { SessionControls } from "./SessionControls";
import { type SideChatMessage, SideChatPanel } from "./SideChatPanel";

export type WorkspaceToolView =
	| "menu"
	| "review"
	| "terminal"
	| "session"
	| "context"
	| "browser"
	| "files"
	| "side-chat"
	| "scheduled";

interface WorkspaceToolsPanelProps {
	view: WorkspaceToolView;
	changes: WorkspaceFileChange[];
	gitStatus: GitStatus;
	disabled: boolean;
	onClose: () => void;
	onRefreshChanges: () => void;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	onRevertFiles: (files: string[]) => void;
	onCommit: () => void;
	onPush: () => void;
	onCreatePullRequest: () => void;
	onSelectView: (view: WorkspaceToolView) => void;
	capabilities: readonly string[];
	bashOutput: string;
	bashRunning: boolean;
	onRunBash: (command: string) => void;
	onAbortBash: () => void;
	sessionStats: SessionStats | null;
	statsLoading: boolean;
	compacting: boolean;
	autoRetry: boolean;
	onRefreshStats: () => void;
	onCompact: () => void;
	onSetAutoRetry: (enabled: boolean) => void;
	onAbortRetry: () => void;
	branchMessages: BranchMessage[];
	sessionActionRunning: boolean;
	onBranch: (entryId: string) => void;
	onCopyLast: () => void;
	onExport: () => void;
	onHandoff: () => void;
	thinkingLevel?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	autoCompaction: boolean;
	todoPhases: TodoPhase[];
	onCycleThinking: () => void;
	onSetSteering: (mode: "all" | "one-at-a-time") => void;
	onSetFollowUp: (mode: "all" | "one-at-a-time") => void;
	onSetInterrupt: (mode: "immediate" | "wait") => void;
	onSetAutoCompaction: (enabled: boolean) => void;
	workspaceEntries: WorkspaceEntry[];
	workspaceFileContent: WorkspaceFileContent | null;
	selectedWorkspacePath: string | null;
	workspaceFilesLoading: boolean;
	workspaceFilesTruncated: boolean;
	onRefreshWorkspaceFiles: (query?: string) => void;
	onOpenWorkspaceFile: (path: string) => void;
	onRevealWorkspaceFile: (path: string) => void;
	onAddWorkspaceContext: (path: string, selection?: string) => void;
	contextItems: StagedContextItem[];
	contextImages: ImageContent[];
	contextSkills: string[];
	contextMemoryBackend: string | null;
	contextSkillDetails?: Array<{
		name: string;
		description: string;
		filePath: string;
		source: string;
		hidden?: boolean;
	}>;
	contextSkillWarnings?: Array<{ skillPath: string; message: string }>;
	onRemoveContextItem: (id: string) => void;
	onRemoveContextImage: (index: number) => void;
	onClearContext: () => void;
	browserUrl: string;
	browserSnapshot: string;
	browserBusy: boolean;
	onBrowserOpen: (url: string) => void;
	onBrowserHistory: (direction: "back" | "forward" | "reload") => void;
	onBrowserSnapshot: () => void;
	onBrowserAddContext: () => void;
	onBrowserExternal: (url: string) => void;
	sideChatReady: boolean;
	sideChatStarting: boolean;
	sideChatMessages: SideChatMessage[];
	onEnsureSideChat: () => void;
	onForkSideChat: () => void;
	onAddSideChatResult: () => void;
	sideChatWorktreePath: string | null;
	onToggleSideChatWorktree: () => void;
	onSendSideChat: (text: string) => void;
	onCloseSideChat: () => void;
	scheduledTasks: ScheduledTaskView[];
	onSaveScheduledTask: (
		input: Omit<ScheduledTaskView, "id" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastError" | "runs"> & {
			id?: string;
		},
	) => void;
	onRemoveScheduledTask: (id: string) => void;
	onRunScheduledTask: (id: string) => void;
}

interface ToolItem {
	view: WorkspaceToolView;
	label: string;
	shortcut?: string;
	icon: ComponentType<{ size?: number; strokeWidth?: number }>;
	capability?: string;
}

const TOOLS: ToolItem[] = [
	{ view: "review", label: "Review", shortcut: "Ctrl+Shift+G", icon: SquarePen, capability: "get_workspace_diff" },
	{ view: "terminal", label: "Terminal", icon: Terminal, capability: "bash" },
	{ view: "session", label: "Session", icon: MessageCircle, capability: "get_session_stats" },
	{ view: "context", label: "Context", icon: MessageCircle },
	{ view: "browser", label: "Browser", shortcut: "Ctrl+T", icon: Globe },
	{ view: "files", label: "Files", shortcut: "Ctrl+P", icon: Folder },
	{ view: "side-chat", label: "Side chat", shortcut: "Ctrl+Alt+S", icon: MessageCircle },
	{ view: "scheduled", label: "Scheduled tasks", icon: MessageCircle },
];

const DEFAULT_REVIEW_WIDTH = 820;
const MIN_REVIEW_WIDTH = 360;
const MAX_REVIEW_WIDTH = 1280;
const MIN_MAIN_COLUMN_WIDTH = 320;

function maxReviewWidth(): number {
	return Math.max(MIN_REVIEW_WIDTH, Math.min(MAX_REVIEW_WIDTH, window.innerWidth - MIN_MAIN_COLUMN_WIDTH));
}

function clampReviewWidth(width: number): number {
	return Math.min(maxReviewWidth(), Math.max(MIN_REVIEW_WIDTH, width));
}

function FeatureMenu({
	onSelectView,
	capabilities,
}: {
	onSelectView: (view: WorkspaceToolView) => void;
	capabilities: readonly string[];
}) {
	return (
		<div className="tools-feature-menu">
			{TOOLS.filter(tool => !tool.capability || capabilities.includes(tool.capability)).map(tool => {
				const Icon = tool.icon;
				return (
					<button
						key={tool.view}
						type="button"
						className="tools-feature-item"
						onClick={() => onSelectView(tool.view)}
					>
						<span className="tools-feature-left">
							<Icon size={16} strokeWidth={1.8} />
							<span>{tool.label}</span>
						</span>
						{tool.shortcut ? <span className="tools-shortcut">{tool.shortcut}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

function TerminalView({
	output,
	running,
	onRun,
	onAbort,
}: {
	output: string;
	running: boolean;
	onRun: (command: string) => void;
	onAbort: () => void;
}) {
	const [command, setCommand] = useState("");
	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		if (!command.trim() || running) return;
		onRun(command.trim());
		setCommand("");
	};
	return (
		<div className="tools-terminal">
			<pre className="tools-terminal-output">{output || "Run a command in the workspace terminal."}</pre>
			<form className="tools-terminal-form" onSubmit={submit}>
				<input
					value={command}
					onChange={event => setCommand(event.target.value)}
					placeholder="Command"
					disabled={running}
				/>
				{running ? (
					<button type="button" onClick={onAbort}>
						Stop
					</button>
				) : (
					<button type="submit" disabled={!command.trim()}>
						Run
					</button>
				)}
			</form>
		</div>
	);
}

function viewTitle(view: WorkspaceToolView): string {
	switch (view) {
		case "review":
			return "Review";
		case "terminal":
			return "Terminal";
		case "session":
			return "Session";
		case "context":
			return "Context Inspector";
		case "browser":
			return "Browser";
		case "files":
			return "Files";
		case "side-chat":
			return "Side chat";
		default:
			return "Workspace";
	}
}

export function WorkspaceToolsPanel({
	view,
	changes,
	gitStatus,
	disabled,
	onClose,
	onRefreshChanges,
	onStageHunks,
	onUnstage,
	onRevertFiles,
	onCommit,
	onPush,
	onCreatePullRequest,
	onSelectView,
	capabilities,
	bashOutput,
	bashRunning,
	onRunBash,
	onAbortBash,
	sessionStats,
	statsLoading,
	compacting,
	autoRetry,
	onRefreshStats,
	onCompact,
	onSetAutoRetry,
	onAbortRetry,
	branchMessages,
	sessionActionRunning,
	onBranch,
	onCopyLast,
	onExport,
	onHandoff,
	thinkingLevel,
	steeringMode,
	followUpMode,
	interruptMode,
	autoCompaction,
	todoPhases,
	onCycleThinking,
	onSetSteering,
	onSetFollowUp,
	onSetInterrupt,
	onSetAutoCompaction,
	workspaceEntries,
	workspaceFileContent,
	selectedWorkspacePath,
	workspaceFilesLoading,
	workspaceFilesTruncated,
	onRefreshWorkspaceFiles,
	onOpenWorkspaceFile,
	onRevealWorkspaceFile,
	onAddWorkspaceContext,
	contextItems,
	contextImages,
	contextSkills,
	contextMemoryBackend,
	contextSkillDetails,
	contextSkillWarnings,
	onRemoveContextItem,
	onRemoveContextImage,
	onClearContext,
	browserUrl,
	browserSnapshot,
	browserBusy,
	onBrowserOpen,
	onBrowserHistory,
	onBrowserSnapshot,
	onBrowserAddContext,
	onBrowserExternal,
	sideChatReady,
	sideChatStarting,
	sideChatMessages,
	onEnsureSideChat,
	onForkSideChat,
	onAddSideChatResult,
	sideChatWorktreePath,
	onToggleSideChatWorktree,
	onSendSideChat,
	onCloseSideChat,
	scheduledTasks,
	onSaveScheduledTask,
	onRemoveScheduledTask,
	onRunScheduledTask,
}: WorkspaceToolsPanelProps) {
	const isReview = view === "review";
	const isWide = isReview || view === "files";
	const [reviewWidth, setReviewWidth] = useState(DEFAULT_REVIEW_WIDTH);

	useEffect(() => {
		if (!isWide) return;
		const onWindowResize = (): void => {
			setReviewWidth(width => clampReviewWidth(width));
		};
		onWindowResize();
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, [isWide]);

	const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = reviewWidth;
		const onMove = (moveEvent: PointerEvent): void => {
			const next = startWidth + startX - moveEvent.clientX;
			setReviewWidth(clampReviewWidth(next));
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	return (
		<aside
			className={`workspace-tools-panel workspace-tools-panel--${view}`}
			style={isWide ? { width: reviewWidth, flexBasis: reviewWidth } : undefined}
		>
			{isWide ? <div className="tools-panel-resize-handle" onPointerDown={startResize} /> : null}
			<div className={`tools-panel-head${isReview ? " tools-panel-head--review" : ""}`}>
				<div className="tools-panel-title">
					{isReview ? (
						<>
							<span className="tools-review-tab">
								<SquarePen size={15} strokeWidth={1.8} />
								Review
							</span>
							<button
								type="button"
								className="tools-review-add"
								title="New review tab"
								aria-label="New review tab"
							>
								<Plus size={17} strokeWidth={1.8} />
							</button>
						</>
					) : (
						viewTitle(view)
					)}
				</div>
				<div className="tools-panel-actions">
					{view !== "menu" ? (
						<button type="button" className="tools-panel-link" onClick={() => onSelectView("menu")}>
							All tools
						</button>
					) : null}
					<button
						type="button"
						className="top-icon-button"
						title="Close side panel"
						aria-label="Close side panel"
						onClick={onClose}
					>
						<PanelRightClose size={16} strokeWidth={1.8} />
					</button>
				</div>
			</div>
			<div className="tools-panel-body">
				{view === "menu" ? <FeatureMenu onSelectView={onSelectView} capabilities={capabilities} /> : null}
				{view === "review" ? (
					<ChangesPanel
						changes={changes}
						gitStatus={gitStatus}
						onRefresh={onRefreshChanges}
						onStageHunks={onStageHunks}
						onUnstage={onUnstage}
						onRevertFiles={onRevertFiles}
						onCommit={onCommit}
						onPush={onPush}
						onCreatePullRequest={onCreatePullRequest}
						disabled={disabled}
					/>
				) : null}
				{view === "terminal" ? (
					<TerminalView output={bashOutput} running={bashRunning} onRun={onRunBash} onAbort={onAbortBash} />
				) : null}
				{view === "session" ? (
					<SessionControls
						stats={sessionStats}
						loading={statsLoading}
						compacting={compacting}
						autoRetry={autoRetry}
						onRefresh={onRefreshStats}
						onCompact={onCompact}
						onSetAutoRetry={onSetAutoRetry}
						onAbortRetry={onAbortRetry}
						canCompact={capabilities.includes("compact")}
						canAutoRetry={capabilities.includes("set_auto_retry")}
						canAbortRetry={capabilities.includes("abort_retry")}
						branchMessages={branchMessages}
						actionRunning={sessionActionRunning}
						canBranch={capabilities.includes("branch")}
						canCopyLast={capabilities.includes("get_last_assistant_text")}
						canExport={capabilities.includes("export_html")}
						canHandoff={capabilities.includes("handoff")}
						thinkingLevel={thinkingLevel}
						steeringMode={steeringMode}
						followUpMode={followUpMode}
						interruptMode={interruptMode}
						autoCompaction={autoCompaction}
						todoPhases={todoPhases}
						canAgentControls={capabilities.some(capability =>
							[
								"cycle_thinking_level",
								"set_steering_mode",
								"set_follow_up_mode",
								"set_interrupt_mode",
								"set_auto_compaction",
							].includes(capability),
						)}
						onCycleThinking={onCycleThinking}
						onSetSteering={onSetSteering}
						onSetFollowUp={onSetFollowUp}
						onSetInterrupt={onSetInterrupt}
						onSetAutoCompaction={onSetAutoCompaction}
						onBranch={onBranch}
						onCopyLast={onCopyLast}
						onExport={onExport}
						onHandoff={onHandoff}
					/>
				) : null}
				{view === "context" ? (
					<ContextInspector
						items={contextItems}
						images={contextImages}
						skills={contextSkills}
						memoryBackend={contextMemoryBackend}
						skillDetails={contextSkillDetails}
						skillWarnings={contextSkillWarnings}
						onRemoveItem={onRemoveContextItem}
						onRemoveImage={onRemoveContextImage}
						onClear={onClearContext}
					/>
				) : null}
				{view === "browser" ? (
					<BrowserPanel
						url={browserUrl}
						snapshot={browserSnapshot}
						busy={browserBusy}
						onOpen={onBrowserOpen}
						onHistory={onBrowserHistory}
						onSnapshot={onBrowserSnapshot}
						onAddContext={onBrowserAddContext}
						onExternal={onBrowserExternal}
					/>
				) : null}
				{view === "files" ? (
					<FilesPanel
						entries={workspaceEntries}
						content={workspaceFileContent}
						selectedPath={selectedWorkspacePath}
						loading={workspaceFilesLoading}
						truncated={workspaceFilesTruncated}
						onRefresh={onRefreshWorkspaceFiles}
						onOpen={onOpenWorkspaceFile}
						onReveal={onRevealWorkspaceFile}
						onAddContext={onAddWorkspaceContext}
					/>
				) : null}
				{view === "side-chat" ? (
					<SideChatPanel
						ready={sideChatReady}
						starting={sideChatStarting}
						messages={sideChatMessages}
						onEnsure={onEnsureSideChat}
						onFork={onForkSideChat}
						onAddResult={onAddSideChatResult}
						worktreePath={sideChatWorktreePath}
						onToggleWorktree={onToggleSideChatWorktree}
						onSend={onSendSideChat}
						onClose={onCloseSideChat}
					/>
				) : null}
				{view === "scheduled" ? (
					<ScheduledTasksPanel
						tasks={scheduledTasks}
						onSave={onSaveScheduledTask}
						onRemove={onRemoveScheduledTask}
						onRunNow={onRunScheduledTask}
					/>
				) : null}
			</div>
		</aside>
	);
}
