import { Folder, Globe, MessageCircle, Plus, SquarePen, Terminal, X } from "lucide-react";
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import type {
	ContextBreakdown,
	ContextUsage,
	GitStatus,
	HunkSelection,
	ImageContent,
	LoginProvider,
	ModelInfo,
	ReviewCommit,
	ReviewScope,
	ScheduledTask,
	ScheduledTaskInput,
	WorkspaceEntry,
	WorkspaceFileChange,
	WorkspaceFileContent,
} from "../lib/rpc-protocol";
import { BrowserPanel } from "./BrowserPanel";
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
	tabs: WorkspaceToolView[];
	workspace: string;
	changes: WorkspaceFileChange[];
	disabled: boolean;
	expanded: boolean;
	onResize: () => void;
	onRefreshChanges: () => void;
	onLoadReview: (scope: ReviewScope, ref?: string) => Promise<WorkspaceFileChange[]>;
	onLoadReviewCommits: () => Promise<ReviewCommit[]>;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	gitStatus: GitStatus;
	onRevertFiles: (files: string[]) => void;
	onCommit: () => void;
	onPush: () => void;
	onCreatePullRequest: () => void;
	sideChatReady: boolean;
	sideChatStarting: boolean;
	sideChatBusy: boolean;
	sideChatMessages: SideChatMessage[];
	sideChatWorktreePath: string | null;
	sideChatModels: ModelInfo[];
	sideChatProviders: LoginProvider[];
	sideChatModel?: string;
	onEnsureSideChat: () => void;
	onStopSideChat: () => void;
	onSelectSideChatModel: (provider: string, modelId: string) => void;
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
	onSelectTab: (view: WorkspaceToolView) => void;
	onNewTab: () => void;
	onCloseTab: (view: WorkspaceToolView) => void;
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
	onBrowserAddContext: (url: string, text: string) => void;
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

const MIN_PANEL_WIDTH = 320;
const MIN_REVIEW_WIDTH = 480;
const MAX_PANEL_WIDTH = 1280;
const MIN_MAIN_COLUMN_WIDTH = 440;

function maxPanelWidth(minWidth: number): number {
	const mainWidth = document.querySelector<HTMLElement>(".app-main")?.clientWidth ?? window.innerWidth;
	return Math.max(minWidth, Math.min(MAX_PANEL_WIDTH, mainWidth - MIN_MAIN_COLUMN_WIDTH));
}

function clampPanelWidth(width: number, minWidth: number): number {
	return Math.min(maxPanelWidth(minWidth), Math.max(minWidth, width));
}

function FeatureMenu({ onSelectView }: { onSelectView: (view: WorkspaceToolView) => void }) {
	return (
		<div className="tools-feature-menu">
			<div className="tools-feature-intro">
				<span>Choose a tool to open alongside your task.</span>
			</div>
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
						{tool.shortcut ? <kbd className="tools-shortcut">{tool.shortcut}</kbd> : null}
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
	tabs,
	workspace,
	changes,
	disabled,
	expanded,
	onResize,
	onRefreshChanges,
	onLoadReview,
	onLoadReviewCommits,
	onStageHunks,
	onUnstage,
	gitStatus,
	onRevertFiles,
	onCommit,
	onPush,
	onCreatePullRequest,
	sideChatReady,
	sideChatStarting,
	sideChatBusy,
	sideChatMessages,
	sideChatWorktreePath,
	sideChatModels,
	sideChatProviders,
	sideChatModel,
	onEnsureSideChat,
	onStopSideChat,
	onSelectSideChatModel,
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
	onSelectTab,
	onNewTab,
	onCloseTab,
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
	onBrowserAddContext,
	onBrowserExternal,
}: WorkspaceToolsPanelProps) {
	const isReview = view === "review";
	const [reviewWidth, setReviewWidth] = useState<number | null>(null);
	const [toolWidth, setToolWidth] = useState<number | null>(null);
	const activeMinWidth = isReview ? MIN_REVIEW_WIDTH : MIN_PANEL_WIDTH;
	const activeWidth = expanded ? maxPanelWidth(activeMinWidth) : isReview ? reviewWidth : toolWidth;

	useEffect(() => {
		const onWindowResize = (): void => {
			setReviewWidth(width => (width === null ? null : clampPanelWidth(width, MIN_REVIEW_WIDTH)));
			setToolWidth(width => (width === null ? null : clampPanelWidth(width, MIN_PANEL_WIDTH)));
		};
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, []);

	const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		onResize();
		const startX = event.clientX;
		const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? activeMinWidth;
		const setWidth = isReview ? setReviewWidth : setToolWidth;
		const onMove = (moveEvent: PointerEvent): void => {
			const next = startWidth + startX - moveEvent.clientX;
			setWidth(clampPanelWidth(next, activeMinWidth));
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		onResize();
		const currentWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? activeMinWidth;
		const nextWidth = currentWidth + (event.key === "ArrowLeft" ? 24 : -24);
		const setWidth = isReview ? setReviewWidth : setToolWidth;
		setWidth(clampPanelWidth(nextWidth, activeMinWidth));
	};

	return (
		<aside
			className={`workspace-tools-panel workspace-tools-panel--${view}`}
			style={activeWidth === null ? undefined : { width: activeWidth, flexBasis: activeWidth }}
		>
			<div
				className="tools-panel-resize-handle"
				role="separator"
				aria-label="Resize workspace panel"
				aria-orientation="vertical"
				aria-valuemin={activeMinWidth}
				aria-valuemax={maxPanelWidth(activeMinWidth)}
				aria-valuenow={activeWidth ?? undefined}
				tabIndex={0}
				onPointerDown={startResize}
				onKeyDown={resizeWithKeyboard}
			/>
			{view !== "terminal" && view !== "browser" ? (
				<div className={`tools-panel-head${isReview ? " tools-panel-head--review" : ""}`}>
					<div className="tools-panel-title">
						{tabs.length > 0 ? (
							<div className="tools-workspace-tabs" role="tablist" aria-label="Workspace tabs">
								{tabs.map(tab => {
									const tool = TOOLS.find(item => item.view === tab);
									const Icon = tool?.icon;
									return (
										<div
											key={tab}
											className={`tools-workspace-tab${tab === view ? " tools-workspace-tab--active" : ""}`}
											role="presentation"
										>
											<button
												type="button"
												className="tools-workspace-tab-button"
												role="tab"
												aria-selected={tab === view}
												onClick={() => onSelectTab(tab)}
											>
												{Icon ? <Icon size={15} strokeWidth={1.8} /> : null}
												<span>{viewTitle(tab)}</span>
											</button>
											<button
												type="button"
												className="tools-workspace-tab-close"
												title={`Close ${viewTitle(tab)} tab`}
												aria-label={`Close ${viewTitle(tab)} tab`}
												onClick={() => onCloseTab(tab)}
											>
												<X size={13} strokeWidth={1.9} />
											</button>
										</div>
									);
								})}
								<button
									type="button"
									className="tools-review-add"
									title="Open a new workspace tab"
									aria-label="Open a new workspace tab"
									onClick={onNewTab}
								>
									<Plus size={17} strokeWidth={1.8} />
								</button>
							</div>
						) : (
							viewTitle(view)
						)}
					</div>
				</div>
			) : null}
			<div className="tools-panel-body">
				{view === "menu" ? <FeatureMenu onSelectView={onSelectView} /> : null}
				{view === "review" ? (
					<ChangesPanel
						changes={changes}
						workspaceEntries={workspaceEntries}
						workspaceFilesLoading={workspaceFilesLoading}
						workspaceFilesTruncated={workspaceFilesTruncated}
						onRefreshWorkspaceFiles={onRefreshWorkspaceFiles}
						gitStatus={gitStatus}
						onRefresh={onRefreshChanges}
						onLoadReview={onLoadReview}
						onLoadReviewCommits={onLoadReviewCommits}
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
					<TerminalPanel
						key={workspace}
						disabled={disabled}
						workspace={workspace}
						onClosePanel={() => onCloseTab("terminal")}
					/>
				) : null}
				{view === "browser" ? (
					<BrowserPanel
						onClosePanel={() => onCloseTab("browser")}
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
						busy={sideChatBusy}
						messages={sideChatMessages}
						onEnsure={onEnsureSideChat}
						onStop={onStopSideChat}
						models={sideChatModels}
						providers={sideChatProviders}
						model={sideChatModel}
						onSelectModel={onSelectSideChatModel}
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
