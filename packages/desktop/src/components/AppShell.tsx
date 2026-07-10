import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
	Archive,
	Badge,
	Box,
	Bug,
	CalendarClock,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CirclePlus,
	FolderOpen,
	FolderPlus,
	GitBranchPlus,
	GripVertical,
	History,
	Maximize2,
	MessageSquarePlus,
	MoreHorizontal,
	PanelBottom,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRight,
	Pencil,
	Pin,
	Plug,
	RefreshCw,
	Search,
	SortDesc,
	Telescope,
	Terminal,
	Wrench,
	X,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewModel } from "../lib/reducer";
import type { EngineStatus } from "../lib/rpc-client";
import type {
	ApprovalMode,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ImageContent,
	LoginProvider,
	ModelInfo,
	SessionSummary,
	SubagentSnapshot,
	ThinkingLevel,
	WorkspaceFileChange,
} from "../lib/rpc-protocol";
import { AuthDialog, type AuthPrompt } from "./AuthDialog";
import { Composer, type ComposerInjection } from "./Composer";
import { DialogHost } from "./DialogHost";
import { StatusBar, WidgetArea, type WidgetEntry } from "./ExtensionWidgets";
import { LoginMenu } from "./LoginMenu";
import { ThemeToggle } from "./ThemeToggle";
import { ModelPicker } from "./ModelPicker";
import { type ChatContextActions, SessionHistory } from "./SessionHistory";
import { SubagentPanel } from "./SubagentPanel";
import { ThinkingPicker } from "./ThinkingPicker";
import { type Toast, Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { WorkspaceToolsPanel, type WorkspaceToolView } from "./WorkspaceToolsPanel";

export interface SessionInfo {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	sessionName?: string;
	messageCount: number;
}

interface AppShellProps {
	vm: ViewModel;
	status: EngineStatus;
	statusDetail?: string;
	workspace: string;
	models: ModelInfo[];
	session: SessionInfo;
	subagents: SubagentSnapshot[];
	loginProviders: LoginProvider[];
	sessions: SessionSummary[];
	statuses: Record<string, string>;
	widgets: Record<string, WidgetEntry>;
	changes: WorkspaceFileChange[];
	onRefreshChanges: () => void;
	historyLoading: boolean;
	dialog: ExtensionUIRequest | null;
	toasts: Toast[];
	injection?: ComposerInjection;
	authPrompt: AuthPrompt | null;
	onSend: (text: string, images: ImageContent[]) => void;
	onAbort: () => void;
	onChangeFolder: () => void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectThinking: (level: ThinkingLevel) => void;
	onSelectApprovalMode: (mode: ApprovalMode) => void;
	onNewSession: () => void;
	onRenameSession: (name: string) => void;
	onSelectSession: (session: SessionSummary) => void;
	onLogin: (providerId: string) => void;
	onSetApiKey: (providerId: string, apiKey: string) => void;
	onLogout: (providerId: string) => void;
	onAuthOpen: (url: string) => void;
	onAuthCancel: () => void;
	onDialogRespond: (response: ExtensionUIResponse) => void;
	onDismissToast: (id: string) => void;
}

function projectName(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? p;
}

const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 342;
const MIN_MAIN_WORKSPACE_WIDTH = 360;
const SIDEBAR_COLLAPSED_KEY = "omp.sidebar.collapsed";
const SIDEBAR_WIDTH_KEY = "omp.sidebar.width.v2";

function maxSidebarWidth(): number {
	return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_WORKSPACE_WIDTH));
}

function clampSidebarWidth(width: number): number {
	return Math.min(maxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readSidebarCollapsed(): boolean {
	return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function readSidebarWidth(): number {
	const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (!raw) return clampSidebarWidth(Math.round(window.innerWidth * 0.21));
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
}

function taskTitleFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	if (normalized.length <= 52) return normalized;
	const shortened = normalized.slice(0, 49);
	const wordBoundary = shortened.lastIndexOf(" ");
	return `${(wordBoundary > 28 ? shortened.slice(0, wordBoundary) : shortened).trimEnd()}...`;
}

function SessionName({ name, onRename }: { name?: string; onRename: (name: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(name ?? "");
	useEffect(() => {
		setValue(name ?? "");
	}, [name]);

	if (editing) {
		return (
			<input
				className="session-name-input"
				autoFocus
				value={value}
				onChange={event => setValue(event.target.value)}
				onBlur={() => {
					setEditing(false);
					const next = value.trim();
					if (next && next !== name) onRename(next);
				}}
				onKeyDown={event => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						setValue(name ?? "");
						setEditing(false);
					}
				}}
			/>
		);
	}
	return (
		<button type="button" className="session-name" title="Rename session" onClick={() => setEditing(true)}>
			{name || "untitled"}
		</button>
	);
}

function ProjectMenu({
	pinned,
	onTogglePinned,
	onOpenExplorer,
	onCreateWorktree,
	onRenameProject,
	onArchiveChats,
	onRemoveProject,
}: {
	pinned: boolean;
	onTogglePinned: () => void;
	onOpenExplorer: () => void;
	onCreateWorktree: () => void;
	onRenameProject: () => void;
	onArchiveChats: () => void;
	onRemoveProject: () => void;
}) {
	return (
		<div className="project-menu">
			<button type="button" className="project-menu-item" onClick={onTogglePinned}>
				<Pin size={16} strokeWidth={1.8} />
				<span>{pinned ? "Unpin project" : "Pin project"}</span>
			</button>
			<button type="button" className="project-menu-item" onClick={onOpenExplorer}>
				<FolderOpen size={16} strokeWidth={1.8} />
				<span>Open in Explorer</span>
			</button>
			<button type="button" className="project-menu-item" onClick={onCreateWorktree}>
				<GitBranchPlus size={16} strokeWidth={1.8} />
				<span>Create permanent worktree</span>
			</button>
			<button type="button" className="project-menu-item" onClick={onRenameProject}>
				<Pencil size={16} strokeWidth={1.8} />
				<span>Rename project</span>
			</button>
			<button type="button" className="project-menu-item" onClick={onArchiveChats}>
				<Archive size={16} strokeWidth={1.8} />
				<span>Archive chats</span>
			</button>
			<button type="button" className="project-menu-item project-menu-item--danger" onClick={onRemoveProject}>
				<X size={16} strokeWidth={1.8} />
				<span>Remove</span>
			</button>
		</div>
	);
}

type ProjectHeaderSubmenu = "organize" | "sort" | null;
type ProjectSubmenuPlacement = "left" | "right";
type SidebarNavView = "new-task" | "chats" | "search" | "scheduled" | "plugins";
type SidebarOrganization = "by-project" | "recent-projects" | "chronological";
type SidebarSortMode = "manual" | "created" | "updated";

interface SidebarSettings {
	organization: SidebarOrganization;
	sortMode: SidebarSortMode;
	projectsMovedDown: boolean;
}

interface WorkspaceSidebarState {
	projectPinned: boolean;
	projectHidden: boolean;
	projectLabel: string | null;
	archivedSessionPaths: string[];
	pinnedSessionPaths: string[];
	unreadSessionPaths: string[];
	sessionTitleOverrides: Record<string, string>;
}

const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
	organization: "by-project",
	sortMode: "manual",
	projectsMovedDown: false,
};

const DEFAULT_WORKSPACE_SIDEBAR_STATE: WorkspaceSidebarState = {
	projectPinned: false,
	projectHidden: false,
	projectLabel: null,
	archivedSessionPaths: [],
	pinnedSessionPaths: [],
	unreadSessionPaths: [],
	sessionTitleOverrides: {},
};

const HOME_PROMPTS = [
	{ icon: Telescope, tone: "blue", label: "Explore and understand code" },
	{ icon: Wrench, tone: "violet", label: "Build a new feature, app, or tool" },
	{ icon: RefreshCw, tone: "green", label: "Review code and suggest changes" },
	{ icon: Bug, tone: "orange", label: "Fix issues and failures" },
] as const;

function readSidebarSettings(): SidebarSettings {
	const organization = window.localStorage.getItem("omp.sidebar.organization");
	const sortMode = window.localStorage.getItem("omp.sidebar.sortMode");
	const projectsMovedDown = window.localStorage.getItem("omp.sidebar.projectsMovedDown") === "true";
	return {
		organization:
			organization === "recent-projects" || organization === "chronological" || organization === "by-project"
				? organization
				: DEFAULT_SIDEBAR_SETTINGS.organization,
		sortMode:
			sortMode === "created" || sortMode === "updated" || sortMode === "manual"
				? sortMode
				: DEFAULT_SIDEBAR_SETTINGS.sortMode,
		projectsMovedDown,
	};
}

function workspaceSidebarStateKey(workspace: string): string {
	return `omp.sidebar.workspace.${encodeURIComponent(workspace)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function readWorkspaceSidebarState(workspace: string): WorkspaceSidebarState {
	try {
		const raw = window.localStorage.getItem(workspaceSidebarStateKey(workspace));
		if (!raw) return DEFAULT_WORKSPACE_SIDEBAR_STATE;
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return DEFAULT_WORKSPACE_SIDEBAR_STATE;
		return {
			projectPinned: parsed.projectPinned === true,
			projectHidden: parsed.projectHidden === true,
			projectLabel: typeof parsed.projectLabel === "string" ? parsed.projectLabel : null,
			archivedSessionPaths: isStringArray(parsed.archivedSessionPaths) ? parsed.archivedSessionPaths : [],
			pinnedSessionPaths: isStringArray(parsed.pinnedSessionPaths) ? parsed.pinnedSessionPaths : [],
			unreadSessionPaths: isStringArray(parsed.unreadSessionPaths) ? parsed.unreadSessionPaths : [],
			sessionTitleOverrides: isStringRecord(parsed.sessionTitleOverrides) ? parsed.sessionTitleOverrides : {},
		};
	} catch {
		return DEFAULT_WORKSPACE_SIDEBAR_STATE;
	}
}

function writeWorkspaceSidebarState(workspace: string, state: WorkspaceSidebarState): void {
	window.localStorage.setItem(workspaceSidebarStateKey(workspace), JSON.stringify(state));
}

function ProjectsHeaderMenu({
	settings,
	onArchiveAllChats,
	onChangeOrganization,
	onChangeSortMode,
	onToggleProjectOrder,
	onClose,
}: {
	settings: SidebarSettings;
	onArchiveAllChats: () => void;
	onChangeOrganization: (organization: SidebarOrganization) => void;
	onChangeSortMode: (sortMode: SidebarSortMode) => void;
	onToggleProjectOrder: () => void;
	onClose: () => void;
}) {
	const [submenu, setSubmenu] = useState<ProjectHeaderSubmenu>(null);
	const [submenuPlacement, setSubmenuPlacement] = useState<ProjectSubmenuPlacement>("right");
	const shellRef = useRef<HTMLDivElement | null>(null);
	const selectOrganization = (organization: SidebarOrganization): void => {
		onChangeOrganization(organization);
		onClose();
	};
	const selectSortMode = (sortMode: SidebarSortMode): void => {
		onChangeSortMode(sortMode);
		onClose();
	};
	const showSubmenu = (nextSubmenu: Exclude<ProjectHeaderSubmenu, null>): void => {
		const shellRect = shellRef.current?.getBoundingClientRect();
		const submenuWidth = 226;
		const gap = 6;
		const viewportPadding = 12;
		if (shellRect && shellRect.right + gap + submenuWidth > window.innerWidth - viewportPadding) {
			setSubmenuPlacement("left");
		} else {
			setSubmenuPlacement("right");
		}
		setSubmenu(nextSubmenu);
	};
	return (
		<div className="projects-menu-shell" ref={shellRef} onMouseLeave={() => setSubmenu(null)}>
			<div className="projects-header-menu">
				<button type="button" className="project-menu-item" onClick={onArchiveAllChats}>
					<Archive size={16} strokeWidth={1.8} />
					<span>Archive all chats</span>
				</button>
				<div className="project-menu-separator" />
				<button
					type="button"
					className={`project-menu-item${submenu === "organize" ? " project-menu-item--active" : ""}`}
					onMouseEnter={() => showSubmenu("organize")}
				>
					<PanelLeftClose size={16} strokeWidth={1.8} />
					<span>Organize sidebar</span>
					<ChevronRight className="project-menu-arrow" size={15} strokeWidth={1.9} />
				</button>
				<button
					type="button"
					className={`project-menu-item${submenu === "sort" ? " project-menu-item--active" : ""}`}
					onMouseEnter={() => showSubmenu("sort")}
				>
					<CalendarClock size={16} strokeWidth={1.8} />
					<span>Sort by</span>
					<ChevronRight className="project-menu-arrow" size={15} strokeWidth={1.9} />
				</button>
			</div>
			{submenu === "organize" ? (
				<div className={`project-submenu project-submenu--${submenuPlacement}`}>
					<button
						type="button"
						className={`project-menu-item${settings.organization === "by-project" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectOrganization("by-project")}
					>
						<Archive size={16} strokeWidth={1.8} />
						<span>By project</span>
						{settings.organization === "by-project" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
					<button
						type="button"
						className={`project-menu-item${settings.organization === "recent-projects" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectOrganization("recent-projects")}
					>
						<FolderOpen size={16} strokeWidth={1.8} />
						<span>Recent projects</span>
						{settings.organization === "recent-projects" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
					<button
						type="button"
						className={`project-menu-item${settings.organization === "chronological" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectOrganization("chronological")}
					>
						<History size={16} strokeWidth={1.8} />
						<span>Chronological list</span>
						{settings.organization === "chronological" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
					<button type="button" className="project-menu-item" onClick={onToggleProjectOrder}>
						<SortDesc size={16} strokeWidth={1.8} />
						<span>{settings.projectsMovedDown ? "Move up" : "Move down"}</span>
					</button>
				</div>
			) : null}
			{submenu === "sort" ? (
				<div className={`project-submenu project-submenu--${submenuPlacement}`}>
					<button
						type="button"
						className={`project-menu-item${settings.sortMode === "manual" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectSortMode("manual")}
					>
						<GripVertical size={16} strokeWidth={1.8} />
						<span>Manual order</span>
						{settings.sortMode === "manual" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
					<button
						type="button"
						className={`project-menu-item${settings.sortMode === "created" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectSortMode("created")}
					>
						<CirclePlus size={16} strokeWidth={1.8} />
						<span>Created</span>
						{settings.sortMode === "created" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
					<button
						type="button"
						className={`project-menu-item${settings.sortMode === "updated" ? " project-menu-item--selected" : ""}`}
						onClick={() => selectSortMode("updated")}
					>
						<Pencil size={16} strokeWidth={1.8} />
						<span>Last updated</span>
						{settings.sortMode === "updated" ? (
							<Check className="project-menu-check" size={15} strokeWidth={2} />
						) : null}
					</button>
				</div>
			) : null}
		</div>
	);
}

export function AppShell(props: AppShellProps) {
	const {
		vm,
		status,
		statusDetail,
		workspace,
		models,
		session,
		subagents,
		loginProviders,
		sessions,
		statuses,
		widgets,
		changes,
		onRefreshChanges,
		historyLoading,
		dialog,
		toasts,
		injection,
		authPrompt,
		onSend,
		onAbort,
		onChangeFolder,
		onSelectModel,
		onSelectThinking,
		onSelectApprovalMode,
		onNewSession,
		onRenameSession,
		onSelectSession,
		onLogin,
		onSetApiKey,
		onLogout,
		onAuthOpen,
		onAuthCancel,
		onDialogRespond,
		onDismissToast,
	} = props;
	const disabled = status !== "ready";
	const isEmptySession = vm.messages.length === 0;
	const [initialWorkspaceSidebarState] = useState(() => readWorkspaceSidebarState(workspace));
	const [toolsOpen, setToolsOpen] = useState(false);
	const [toolsView, setToolsView] = useState<WorkspaceToolView>("menu");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());
	const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
	const [projectMenuPlacement, setProjectMenuPlacement] = useState<"header" | "row" | null>(null);
	const [projectPinned, setProjectPinned] = useState(initialWorkspaceSidebarState.projectPinned);
	const [projectHidden, setProjectHidden] = useState(initialWorkspaceSidebarState.projectHidden);
	const [projectLabel, setProjectLabel] = useState<string | null>(initialWorkspaceSidebarState.projectLabel);
	const [projectContextEnabled, setProjectContextEnabled] = useState(false);
	const [activeSidebarView, setActiveSidebarView] = useState<SidebarNavView>("new-task");
	const [historyQuery, setHistoryQuery] = useState("");
	const [archivedSessionPaths, setArchivedSessionPaths] = useState<Set<string>>(
		() => new Set(initialWorkspaceSidebarState.archivedSessionPaths),
	);
	const [pinnedSessionPaths, setPinnedSessionPaths] = useState<Set<string>>(
		() => new Set(initialWorkspaceSidebarState.pinnedSessionPaths),
	);
	const [unreadSessionPaths, setUnreadSessionPaths] = useState<Set<string>>(
		() => new Set(initialWorkspaceSidebarState.unreadSessionPaths),
	);
	const [sessionTitleOverrides, setSessionTitleOverrides] = useState<Record<string, string>>(
		initialWorkspaceSidebarState.sessionTitleOverrides,
	);
	const [sidebarSettings, setSidebarSettings] = useState<SidebarSettings>(() => readSidebarSettings());
	const [sidebarNotice, setSidebarNotice] = useState<string | null>(null);
	const [workspaceStateLoadedFor, setWorkspaceStateLoadedFor] = useState(workspace);

	useEffect(() => {
		window.localStorage.setItem("omp.sidebar.organization", sidebarSettings.organization);
		window.localStorage.setItem("omp.sidebar.sortMode", sidebarSettings.sortMode);
		window.localStorage.setItem("omp.sidebar.projectsMovedDown", String(sidebarSettings.projectsMovedDown));
	}, [sidebarSettings]);

	useEffect(() => {
		window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
	}, [sidebarCollapsed]);

	useEffect(() => {
		window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		const state = readWorkspaceSidebarState(workspace);
		setProjectPinned(state.projectPinned);
		setProjectHidden(state.projectHidden);
		setProjectLabel(state.projectLabel);
		setArchivedSessionPaths(new Set(state.archivedSessionPaths));
		setPinnedSessionPaths(new Set(state.pinnedSessionPaths));
		setUnreadSessionPaths(new Set(state.unreadSessionPaths));
		setSessionTitleOverrides(state.sessionTitleOverrides);
		setWorkspaceStateLoadedFor(workspace);
		setSidebarNotice(null);
	}, [workspace]);

	useEffect(() => {
		if (workspaceStateLoadedFor !== workspace) return;
		writeWorkspaceSidebarState(workspace, {
			projectPinned,
			projectHidden,
			projectLabel,
			archivedSessionPaths: [...archivedSessionPaths],
			pinnedSessionPaths: [...pinnedSessionPaths],
			unreadSessionPaths: [...unreadSessionPaths],
			sessionTitleOverrides,
		});
	}, [
		archivedSessionPaths,
		pinnedSessionPaths,
		projectHidden,
		projectLabel,
		projectPinned,
		sessionTitleOverrides,
		unreadSessionPaths,
		workspace,
		workspaceStateLoadedFor,
	]);

	const currentProjectName = projectLabel ?? projectName(workspace);
	const visibleSessions = useMemo(() => {
		const query = historyQuery.trim().toLowerCase();
		const withOverrides = sessions.map((summary, index) => ({
			...summary,
			title:
				sessionTitleOverrides[summary.path] ??
				summary.title ??
				`${currentProjectName} task ${sessions.length - index}`,
		}));
		const filtered = withOverrides.filter(summary => {
			if (archivedSessionPaths.has(summary.path)) return false;
			if (!query) return true;
			const title = summary.title ?? "untitled";
			return title.toLowerCase().includes(query) || summary.id.toLowerCase().includes(query);
		});
		const pinSorted = (list: SessionSummary[]): SessionSummary[] =>
			[...list].sort(
				(left, right) => Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path)),
			);
		switch (sidebarSettings.sortMode) {
			case "created":
				return pinSorted(filtered).sort((left, right) => {
					const pinnedDiff =
						Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path));
					if (pinnedDiff !== 0) return pinnedDiff;
					return new Date(right.created).getTime() - new Date(left.created).getTime();
				});
			case "updated":
				return pinSorted(filtered).sort((left, right) => {
					const pinnedDiff =
						Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path));
					if (pinnedDiff !== 0) return pinnedDiff;
					return new Date(right.modified).getTime() - new Date(left.modified).getTime();
				});
			case "manual":
				return pinSorted(filtered);
		}
	}, [
		archivedSessionPaths,
		historyQuery,
		pinnedSessionPaths,
		currentProjectName,
		sessionTitleOverrides,
		sessions,
		sidebarSettings.sortMode,
	]);

	const historyEmptyLabel = historyQuery.trim()
		? "No matching chats."
		: archivedSessionPaths.size > 0
			? "All visible chats are archived."
			: "No sessions yet.";
	const isProjectContextActive = projectContextEnabled && !projectHidden;
	const composerProjectName = isProjectContextActive ? currentProjectName : "";
	const composerWorkspaceTitle = isProjectContextActive ? workspace : "Choose project";
	const homeHeading = isProjectContextActive
		? `What should we build in ${currentProjectName}?`
		: "What should we work on?";

	useEffect(() => {
		const onWindowResize = (): void => {
			setSidebarWidth(width => clampSidebarWidth(width));
		};
		onWindowResize();
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, []);

	const openTools = (view: WorkspaceToolView = "menu") => {
		setToolsView(view);
		setToolsOpen(true);
	};

	const setSidebarView = (view: SidebarNavView): void => {
		setActiveSidebarView(view);
		setProjectMenuPlacement(null);
		if (view !== "search") setHistoryQuery("");
	};

	const chooseProject = (): void => {
		setProjectContextEnabled(true);
		onChangeFolder();
	};

	const startNewChat = (withProject: boolean): void => {
		setProjectContextEnabled(withProject);
		onNewSession();
	};

	const openWorkspaceInExplorer = (): void => {
		setProjectMenuPlacement(null);
		void revealItemInDir(workspace).catch(() => openPath(workspace).catch(() => undefined));
	};

	const toggleProjectPinned = (): void => {
		setProjectPinned(pinned => !pinned);
		setProjectMenuPlacement(null);
	};

	const archiveSessions = (onlyCurrentProject: boolean): void => {
		const paths = sessions.filter(summary => !summary.active).map(summary => summary.path);
		setArchivedSessionPaths(currentPaths => new Set([...currentPaths, ...paths]));
		setSidebarNotice(
			onlyCurrentProject ? "Archived inactive chats in this project." : "Archived all inactive chats.",
		);
		setProjectMenuPlacement(null);
	};

	const changeOrganization = (organization: SidebarOrganization): void => {
		setSidebarSettings(settings => ({ ...settings, organization }));
	};

	const changeSortMode = (sortMode: SidebarSortMode): void => {
		setSidebarSettings(settings => ({ ...settings, sortMode }));
	};

	const toggleProjectOrder = (): void => {
		setSidebarSettings(settings => ({ ...settings, projectsMovedDown: !settings.projectsMovedDown }));
	};

	const renameProject = (): void => {
		const nextName = window.prompt("Rename project", currentProjectName)?.trim();
		if (nextName) setProjectLabel(nextName);
		setProjectMenuPlacement(null);
	};

	const removeProject = (): void => {
		setProjectHidden(true);
		setProjectContextEnabled(false);
		setProjectMenuPlacement(null);
		setSidebarNotice("Project hidden from sidebar. Use the folder button to choose another project.");
	};

	const createPermanentWorktree = (): void => {
		setProjectMenuPlacement(null);
		setSidebarNotice("Permanent worktree creation needs engine support; UI action is reserved.");
	};

	const copyText = (text: string, label: string): void => {
		void navigator.clipboard?.writeText(text).then(
			() => setSidebarNotice(`${label} copied.`),
			() => setSidebarNotice(`Could not copy ${label.toLowerCase()}.`),
		);
	};

	const selectSessionFromSidebar = (selectedSession: SessionSummary): void => {
		setProjectContextEnabled(true);
		setUnreadSessionPaths(paths => {
			if (!paths.has(selectedSession.path)) return paths;
			const next = new Set(paths);
			next.delete(selectedSession.path);
			return next;
		});
		onSelectSession(selectedSession);
	};

	const chatContextActions: ChatContextActions = {
		isPinned: chat => pinnedSessionPaths.has(chat.path),
		isUnread: chat => unreadSessionPaths.has(chat.path),
		onPin: chat => {
			setPinnedSessionPaths(paths => {
				const next = new Set(paths);
				if (next.has(chat.path)) next.delete(chat.path);
				else next.add(chat.path);
				return next;
			});
		},
		onRename: chat => {
			const currentName = chat.title || "untitled";
			const nextName = window.prompt("Rename chat", currentName)?.trim();
			if (!nextName) return;
			if (chat.active) {
				onRenameSession(nextName);
			}
			setSessionTitleOverrides(overrides => ({ ...overrides, [chat.path]: nextName }));
		},
		onArchive: chat => {
			setArchivedSessionPaths(paths => new Set([...paths, chat.path]));
			setSidebarNotice("Chat archived.");
		},
		onMarkUnread: chat => {
			setUnreadSessionPaths(paths => {
				const next = new Set(paths);
				if (next.has(chat.path)) next.delete(chat.path);
				else next.add(chat.path);
				return next;
			});
		},
		onOpenExplorer: chat => {
			void revealItemInDir(chat.path).catch(() => openPath(chat.path).catch(() => undefined));
		},
		onCopyWorkingDirectory: () => copyText(workspace, "Working directory"),
		onCopySessionId: chat => copyText(chat.id, "Session ID"),
		onCopyDeeplink: chat =>
			copyText(`omp://session/${encodeURIComponent(chat.id)}?path=${encodeURIComponent(chat.path)}`, "Deeplink"),
		onOpenNewWindow: () => {
			setSidebarNotice("Open in new window is reserved for a future desktop window command.");
		},
	};

	const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		if (sidebarCollapsed) return;
		const startX = event.clientX;
		const startWidth = sidebarWidth;
		const onPointerMove = (moveEvent: PointerEvent): void => {
			setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
		};
		const onPointerUp = (): void => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp, { once: true });
	};

	const projectBlock = !projectHidden ? (
		<div className="sidebar-projects sidebar-expanded-only">
			<div className="sidebar-section-head">
				<button
					type="button"
					className="sidebar-section-title-button"
					title="Projects"
					onClick={() => changeOrganization("by-project")}
				>
					<span>Projects</span>
					<ChevronDown size={14} strokeWidth={1.9} />
				</button>
				<div className="sidebar-section-actions">
					<div className="project-menu-anchor">
						<button
							type="button"
							className={`sidebar-mini-button${projectMenuPlacement === "header" ? " sidebar-mini-button--active" : ""}`}
							title="Project options"
							aria-label="Project options"
							onClick={() => setProjectMenuPlacement(placement => (placement === "header" ? null : "header"))}
						>
							<MoreHorizontal size={16} strokeWidth={1.9} />
						</button>
						{projectMenuPlacement === "header" ? (
							<>
								<button
									type="button"
									className="picker-backdrop"
									aria-label="Close project menu"
									onClick={() => setProjectMenuPlacement(null)}
								/>
								<ProjectsHeaderMenu
									settings={sidebarSettings}
									onArchiveAllChats={() => archiveSessions(false)}
									onChangeOrganization={changeOrganization}
									onChangeSortMode={changeSortMode}
									onToggleProjectOrder={toggleProjectOrder}
									onClose={() => setProjectMenuPlacement(null)}
								/>
							</>
						) : null}
					</div>
					<button
						type="button"
						className="sidebar-mini-button"
						title="Create project from folder"
						aria-label="Create project from folder"
						onClick={chooseProject}
					>
						<FolderPlus size={16} strokeWidth={1.9} />
					</button>
				</div>
			</div>
			<div
				className={`project-row${projectMenuPlacement != null ? " project-row--active" : ""}${projectPinned ? " project-row--pinned" : ""}`}
			>
				<button
					type="button"
					className="project-row-main"
					title={workspace}
					onClick={() => setProjectContextEnabled(true)}
				>
					<Box size={17} strokeWidth={1.8} />
					<span className="project-row-name">{currentProjectName}</span>
					<ChevronDown size={14} strokeWidth={1.9} />
				</button>
				<div className="project-row-actions">
					<div className="project-menu-anchor">
						<button
							type="button"
							className="project-row-action"
							title="Project options"
							aria-label="Project options"
							onClick={() => setProjectMenuPlacement(placement => (placement === "row" ? null : "row"))}
						>
							<MoreHorizontal size={16} strokeWidth={1.9} />
						</button>
						{projectMenuPlacement === "row" ? (
							<>
								<button
									type="button"
									className="picker-backdrop"
									aria-label="Close project menu"
									onClick={() => setProjectMenuPlacement(null)}
								/>
								<ProjectMenu
									pinned={projectPinned}
									onTogglePinned={toggleProjectPinned}
									onOpenExplorer={openWorkspaceInExplorer}
									onCreateWorktree={createPermanentWorktree}
									onRenameProject={renameProject}
									onArchiveChats={() => archiveSessions(true)}
									onRemoveProject={removeProject}
								/>
							</>
						) : null}
					</div>
					<button
						type="button"
						className="project-row-action"
						title="New chat in this project"
						aria-label="New chat in this project"
						disabled={disabled}
						onClick={() => startNewChat(true)}
					>
						<Pencil size={15} strokeWidth={1.9} />
					</button>
				</div>
			</div>
		</div>
	) : null;

	const chatsBlock = (
		<div className="sidebar-section">
			<div className="history-title sidebar-expanded-only">
				{activeSidebarView === "search" ? "Search tasks" : "Tasks"}
			</div>
			{activeSidebarView === "search" ? (
				<label className="sidebar-search sidebar-expanded-only">
					<Search size={15} strokeWidth={1.8} />
					<input
						value={historyQuery}
						onChange={event => setHistoryQuery(event.target.value)}
						placeholder="Search chats..."
						autoFocus
					/>
				</label>
			) : null}
			{activeSidebarView === "scheduled" ? (
				<div className="sidebar-notice sidebar-expanded-only">No scheduled tasks yet.</div>
			) : null}
			{activeSidebarView === "plugins" ? (
				<div className="sidebar-notice sidebar-expanded-only">
					Plugin management is available from the active project context.
				</div>
			) : null}
			{sidebarNotice ? (
				<button
					type="button"
					className="sidebar-notice sidebar-notice--button sidebar-expanded-only"
					onClick={() => setSidebarNotice(null)}
				>
					{sidebarNotice}
				</button>
			) : null}
			<SessionHistory
				sessions={visibleSessions}
				loading={historyLoading}
				onSelect={selectSessionFromSidebar}
				emptyLabel={historyEmptyLabel}
				contextActions={chatContextActions}
			/>
		</div>
	);

	const sendWithTaskTitle = (text: string, images: ImageContent[]): void => {
		if (isEmptySession && !session.sessionName && text.trim()) {
			onRenameSession(taskTitleFromPrompt(text));
		}
		onSend(text, images);
	};

	const composerNode = (
		<Composer
			disabled={disabled}
			streaming={vm.streaming}
			injection={injection}
			workspace={composerWorkspaceTitle}
			projectName={composerProjectName}
			model={session.model}
			thinkingLevel={session.thinkingLevel}
			approvalMode={session.approvalMode}
			onSelectThinking={onSelectThinking}
			onSelectApprovalMode={onSelectApprovalMode}
			onChooseProject={chooseProject}
			onSend={sendWithTaskTitle}
			onAbort={onAbort}
		/>
	);

	const submitHomePrompt = (prompt: string): void => {
		if (disabled) return;
		sendWithTaskTitle(prompt, []);
	};

	return (
		<div className="app-shell">
			<aside
				className={`app-sidebar${sidebarCollapsed ? " app-sidebar--collapsed" : ""}`}
				style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
			>
				<div className="sidebar-resize-handle" onPointerDown={startSidebarResize} />
				<div className="sidebar-top">
					<div className="sidebar-menu-bar">
						<button
							type="button"
							className="sidebar-icon-button"
							title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
							aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
							onClick={() => setSidebarCollapsed(collapsed => !collapsed)}
						>
							{sidebarCollapsed ? (
								<PanelLeftOpen size={17} strokeWidth={1.8} />
							) : (
								<PanelLeftClose size={17} strokeWidth={1.8} />
							)}
						</button>
						<button
							type="button"
							className="sidebar-history-button sidebar-expanded-only"
							disabled
							title="Back"
							aria-label="Back"
						>
							<ChevronLeft size={16} strokeWidth={1.8} />
						</button>
						<button
							type="button"
							className="sidebar-history-button sidebar-expanded-only"
							disabled
							title="Forward"
							aria-label="Forward"
						>
							<ChevronRight size={16} strokeWidth={1.8} />
						</button>
						<div className="sidebar-app-menu sidebar-expanded-only" aria-label="Application menu">
							<span>File</span>
							<span>Edit</span>
							<span>View</span>
							<span>Help</span>
						</div>
					</div>
					<div className="sidebar-brand sidebar-expanded-only">
						<div className="sidebar-brand-name">
							<strong>OMP</strong>
							<span>Codex</span>
						</div>
						<button
							type="button"
							className="sidebar-icon-button"
							title="Search"
							aria-label="Search"
							onClick={() => setSidebarView("search")}
						>
							<Search size={17} strokeWidth={1.65} />
						</button>
					</div>
					<nav className="sidebar-nav" aria-label="Primary">
						<button
							type="button"
							className={`sidebar-nav-item${activeSidebarView === "new-task" ? " sidebar-nav-item--active" : ""}`}
							disabled={disabled}
							onClick={() => {
								setSidebarView("new-task");
								startNewChat(false);
							}}
							title="New task"
						>
							<MessageSquarePlus size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">New task</span>
						</button>
						<button
							type="button"
							className="sidebar-nav-item sidebar-nav-item--project"
							title="Projects"
							onClick={chooseProject}
						>
							<FolderOpen size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Projects</span>
							<FolderPlus className="sidebar-nav-tail" size={16} strokeWidth={1.7} />
						</button>
						<button
							type="button"
							className={`sidebar-nav-item${activeSidebarView === "scheduled" ? " sidebar-nav-item--active" : ""}`}
							title="Scheduled"
							onClick={() => setSidebarView("scheduled")}
						>
							<CalendarClock size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Scheduled</span>
						</button>
						<button
							type="button"
							className={`sidebar-nav-item${activeSidebarView === "plugins" ? " sidebar-nav-item--active" : ""}`}
							title="Plugins"
							onClick={() => setSidebarView("plugins")}
						>
							<Plug size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Plugins</span>
						</button>{" "}
						<button
							type="button"
							className={`sidebar-nav-item${activeSidebarView === "chats" ? " sidebar-nav-item--active" : ""}`}
							title="Chat"
							onClick={() => setSidebarView("chats")}
						>
							<CirclePlus size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Chat</span>
						</button>
					</nav>
					{sidebarSettings.projectsMovedDown ? null : projectBlock}
				</div>
				{chatsBlock}
				{sidebarSettings.projectsMovedDown ? projectBlock : null}
				<div className="sidebar-footer">
					<ModelPicker
						current={session.model}
						models={models}
						providers={loginProviders}
						disabled={disabled}
						onSelect={onSelectModel}
					/>
					<ThinkingPicker
						current={session.thinkingLevel}
						model={session.model}
						models={models}
						disabled={disabled}
						onSelect={onSelectThinking}
					/>
					<LoginMenu
						providers={loginProviders}
						disabled={disabled}
						onLogin={onLogin}
						onSetApiKey={onSetApiKey}
						onLogout={onLogout}
					/>
					<ThemeToggle collapsed={sidebarCollapsed} />
				</div>
			</aside>

			<section className={`app-workspace${isEmptySession ? " app-workspace--empty" : ""}`}>
				{isEmptySession ? (
					<div className="empty-window-controls">
						<button
							type="button"
							className="top-icon-button"
							title="Toggle bottom panel"
							aria-label="Toggle bottom panel"
						>
							<PanelBottom size={16} strokeWidth={1.8} />
						</button>
						<button
							type="button"
							className={`top-icon-button${toolsOpen ? " top-icon-button--active" : ""}`}
							title="Toggle side panel"
							aria-label="Toggle side panel"
							onClick={() => {
								if (toolsOpen) setToolsOpen(false);
								else openTools("menu");
							}}
						>
							<PanelRight size={16} strokeWidth={1.8} />
						</button>
					</div>
				) : (
					<header className="app-header">
						<div className="app-heading">
							<SessionName name={session.sessionName} onRename={onRenameSession} />
							{session.messageCount > 0 ? <span className="msg-count">{session.messageCount} msgs</span> : null}
						</div>
						<div className="app-controls">
							<div className="window-tool-controls">
								<button type="button" className="top-icon-button" title="Focus mode" aria-label="Focus mode">
									<Maximize2 size={15} strokeWidth={1.8} />
								</button>
								<button
									type="button"
									className="top-icon-button"
									title="Toggle bottom panel"
									aria-label="Toggle bottom panel"
								>
									<PanelBottom size={16} strokeWidth={1.8} />
								</button>
								<button
									type="button"
									className={`top-icon-button${toolsOpen ? " top-icon-button--active" : ""}`}
									title="Toggle side panel"
									aria-label="Toggle side panel"
									onClick={() => {
										if (toolsOpen) setToolsOpen(false);
										else openTools("menu");
									}}
								>
									<PanelRight size={16} strokeWidth={1.8} />
								</button>
							</div>
						</div>
					</header>
				)}

				{statusDetail && status === "error" ? <div className="error-banner">{statusDetail}</div> : null}

				<main className="app-main">
					<div className="app-center">
						<div className={`app-content${isEmptySession ? " app-content--home" : ""}`}>
							<SubagentPanel subagents={subagents} />
							{isEmptySession ? (
								<div className="home-start">
									<div className="home-mark" aria-hidden="true">
										<Badge size={62} strokeWidth={1.55} />
										<Terminal size={25} strokeWidth={1.7} />
									</div>
									<h1>{homeHeading}</h1>
									<div className="empty-prompts" aria-label="Prompt ideas">
										{HOME_PROMPTS.map(prompt => {
											const PromptIcon = prompt.icon;
											return (
												<button
													type="button"
													key={prompt.label}
													className={`home-prompt-card home-prompt-card--${prompt.tone}`}
													disabled={disabled}
													onClick={() => submitHomePrompt(prompt.label)}
												>
													<PromptIcon size={18} strokeWidth={1.8} />
													<span>{prompt.label}</span>
												</button>
											);
										})}
									</div>
									{composerNode}
								</div>
							) : (
								<Transcript messages={vm.messages} />
							)}
							{status === "error" && vm.stderr.length > 0 ? (
								<details className="stderr-panel">
									<summary>Engine diagnostics ({vm.stderr.length})</summary>
									<pre>{vm.stderr.join("\n")}</pre>
								</details>
							) : null}
						</div>
						{isEmptySession ? null : (
							<footer className="app-footer">
								<StatusBar statuses={statuses} />
								<WidgetArea widgets={widgets} placement="aboveEditor" />
								{composerNode}
								<WidgetArea widgets={widgets} placement="belowEditor" />
							</footer>
						)}
					</div>
					{toolsOpen ? (
						<WorkspaceToolsPanel
							view={toolsView}
							changes={changes}
							disabled={disabled}
							onRefreshChanges={onRefreshChanges}
							onSelectView={setToolsView}
							onClose={() => setToolsOpen(false)}
						/>
					) : null}
				</main>
			</section>

			<DialogHost request={dialog} onRespond={onDialogRespond} />
			<AuthDialog prompt={authPrompt} onOpen={onAuthOpen} onCancel={onAuthCancel} />
			<Toasts toasts={toasts} onDismiss={onDismissToast} />
		</div>
	);
}
