import { Folder, Globe, MessageCircle, PanelRightClose, Plus, SquarePen, Terminal } from "lucide-react";
import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import type {
	BashResult,
	BrowserTab,
	ContextBreakdown,
	ContextUsage,
	GitStatus,
	HunkSelection,
	ImageContent,
	ScheduledTask,
	ScheduledTaskInput,
	WorkspaceEntry,
	WorkspaceFileChange,
	WorkspaceFileContent,
} from "../lib/rpc-protocol";
import { type BrowserActivity, BrowserPanel } from "./BrowserPanel";
import { ChangesPanel } from "./ChangesPanel";
import { ContextInspector, type StagedContextItem } from "./ContextInspector";
import { FilesPanel } from "./FilesPanel";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import { type SideChatMessage, SideChatPanel } from "./SideChatPanel";
import { TerminalPanel } from "./TerminalPanel";

export type WorkspaceToolView =
	| "menu"
	| "review"
	| "terminal"
	| "context"
	| "browser"
	| "files"
	| "side-chat"
	| "scheduled";

interface WorkspaceToolsPanelProps {
	view: WorkspaceToolView;
	workspace: string;
	changes: WorkspaceFileChange[];
	disabled: boolean;
	onClose: () => void;
	onRefreshChanges: () => void;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	gitStatus: GitStatus;
	onRevertFiles: (files: string[]) => void;
	onCommit: () => void;
	onPush: () => void;
	onCreatePullRequest: () => void;
	onTerminalRun: (command: string) => Promise<BashResult>;
	onTerminalAbort: () => Promise<void>;
	sideChatReady: boolean;
	sideChatStarting: boolean;
	sideChatMessages: SideChatMessage[];
	sideChatWorktreePath: string | null;
	onEnsureSideChat: () => void;
	onForkSideChat: () => void;
	onAddSideChatResult: () => void;
	onToggleSideChatWorktree: () => void;
	onSendSideChat: (text: string) => void;
	onCloseSideChat: () => void;
	scheduledTasks: ScheduledTask[];
	onSaveScheduledTask: (input: ScheduledTaskInput) => void;
	onRemoveScheduledTask: (id: string) => void;
	onRunScheduledTask: (id: string) => void;
	onSelectView: (view: WorkspaceToolView) => void;
	workspaceEntries: WorkspaceEntry[];
	workspaceFileContent: WorkspaceFileContent | null;
	selectedWorkspacePath: string | null;
	workspaceFilesLoading: boolean;
	workspaceFilesTruncated: boolean;
	onRefreshWorkspaceFiles: (query?: string) => void;
	onOpenWorkspaceFile: (path: string) => void;
	onRevealWorkspaceFile: (path: string) => void;
	onAddWorkspaceContext?: (path: string, selection?: string) => void;
	contextItems: StagedContextItem[];
	contextImages: ImageContent[];
	contextSkills: string[];
	contextMemoryBackend: string | null;
	contextUsage?: ContextUsage;
	contextBreakdown?: ContextBreakdown;
	onRemoveContextItem: (id: string) => void;
	onRemoveContextImage: (index: number) => void;
	onClearContext: () => void;
	browserUrl: string;
	browserSnapshot: string;
	browserBusy: boolean;
	browserTabs: BrowserTab[];
	browserActiveTab: string;
	browserActivity: BrowserActivity[];
	browserDownloadPolicy: "deny";
	onBrowserOpen: (url: string) => void;
	onBrowserNewTab: () => void;
	onBrowserSelectTab: (tab: BrowserTab) => void;
	onBrowserCloseTab: (name: string) => void;
	onBrowserRefreshTabs: () => void;
	onBrowserHistory: (direction: "back" | "forward" | "reload") => void;
	onBrowserSnapshot: () => void;
	onBrowserAddContext: () => void;
	onBrowserExternal: (url: string) => void;
}

interface ToolItem {
	view: WorkspaceToolView;
	label: string;
	shortcut?: string;
	icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const TOOLS: ToolItem[] = [
	{ view: "review", label: "Review", shortcut: "Ctrl+Shift+G", icon: SquarePen },
	{ view: "terminal", label: "Terminal", icon: Terminal },
	{ view: "context", label: "Context", icon: MessageCircle },
	{ view: "browser", label: "Browser", shortcut: "Ctrl+T", icon: Globe },
	{ view: "files", label: "Files", shortcut: "Ctrl+P", icon: Folder },
	{ view: "side-chat", label: "Side chat", shortcut: "Ctrl+Alt+S", icon: MessageCircle },
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

function FeatureMenu({ onSelectView }: { onSelectView: (view: WorkspaceToolView) => void }) {
	return (
		<div className="tools-feature-menu">
			{TOOLS.map(tool => {
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

function viewTitle(view: WorkspaceToolView): string {
	switch (view) {
		case "review":
			return "Review";
		case "terminal":
			return "Terminal";
		case "context":
			return "Context Inspector";
		case "browser":
			return "Browser";
		case "files":
			return "Files";
		case "side-chat":
			return "Side chat";
		case "scheduled":
			return "Scheduled Tasks";
		default:
			return "Workspace";
	}
}

export function WorkspaceToolsPanel({
	view,
	workspace,
	changes,
	disabled,
	onClose,
	onRefreshChanges,
	onStageHunks,
	onUnstage,
	gitStatus,
	onRevertFiles,
	onCommit,
	onPush,
	onCreatePullRequest,
	onTerminalRun,
	onTerminalAbort,
	sideChatReady,
	sideChatStarting,
	sideChatMessages,
	sideChatWorktreePath,
	onEnsureSideChat,
	onForkSideChat,
	onAddSideChatResult,
	onToggleSideChatWorktree,
	onSendSideChat,
	onCloseSideChat,
	scheduledTasks,
	onSaveScheduledTask,
	onRemoveScheduledTask,
	onRunScheduledTask,
	onSelectView,
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
	contextUsage,
	contextBreakdown,
	onRemoveContextItem,
	onRemoveContextImage,
	onClearContext,
	browserUrl,
	browserSnapshot,
	browserBusy,
	browserTabs,
	browserActiveTab,
	browserActivity,
	browserDownloadPolicy,
	onBrowserOpen,
	onBrowserNewTab,
	onBrowserSelectTab,
	onBrowserCloseTab,
	onBrowserRefreshTabs,
	onBrowserHistory,
	onBrowserSnapshot,
	onBrowserAddContext,
	onBrowserExternal,
}: WorkspaceToolsPanelProps) {
	const isReview = view === "review";
	const [reviewWidth, setReviewWidth] = useState(DEFAULT_REVIEW_WIDTH);

	useEffect(() => {
		if (!isReview) return;
		const onWindowResize = (): void => {
			setReviewWidth(width => clampReviewWidth(width));
		};
		onWindowResize();
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, [isReview]);

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
			style={isReview ? { width: reviewWidth, flexBasis: reviewWidth } : undefined}
		>
			{isReview ? <div className="tools-panel-resize-handle" onPointerDown={startResize} /> : null}
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
				{view === "menu" ? <FeatureMenu onSelectView={onSelectView} /> : null}
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
					<TerminalPanel disabled={disabled} onRun={onTerminalRun} onAbort={onTerminalAbort} />
				) : null}
				{view === "browser" ? (
					<BrowserPanel
						url={browserUrl}
						snapshot={browserSnapshot}
						busy={browserBusy}
						tabs={browserTabs}
						activeTab={browserActiveTab}
						activity={browserActivity}
						downloadPolicy={browserDownloadPolicy}
						onOpen={onBrowserOpen}
						onNewTab={onBrowserNewTab}
						onSelectTab={onBrowserSelectTab}
						onCloseTab={onBrowserCloseTab}
						onRefreshTabs={onBrowserRefreshTabs}
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
						onAddContext={onAddWorkspaceContext ?? (() => {})}
					/>
				) : null}
				{view === "context" ? (
					<ContextInspector
						items={contextItems}
						images={contextImages}
						skills={contextSkills}
						memoryBackend={contextMemoryBackend}
						usage={contextUsage}
						breakdown={contextBreakdown}
						onRemoveItem={onRemoveContextItem}
						onRemoveImage={onRemoveContextImage}
						onClear={onClearContext}
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
						defaultWorkspace={workspace}
						onSave={onSaveScheduledTask}
						onRemove={onRemoveScheduledTask}
						onRunNow={onRunScheduledTask}
					/>
				) : null}
			</div>
		</aside>
	);
}
