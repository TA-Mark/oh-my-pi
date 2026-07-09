import {
	Archive,
	Box,
	CalendarClock,
	Check,
	ChevronDown,
	ChevronRight,
	CirclePlus,
	GripVertical,
	FolderOpen,
	FolderPlus,
	GitBranchPlus,
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
	Search,
	SortDesc,
	X,
} from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ViewModel } from "../lib/reducer";
import type { EngineStatus } from "../lib/rpc-client";
import type {
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
import { ModelPicker } from "./ModelPicker";
import { SessionHistory, type ChatContextActions } from "./SessionHistory";
import { SubagentPanel } from "./SubagentPanel";
import { ThinkingPicker } from "./ThinkingPicker";
import { type Toast, Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { WorkspaceToolsPanel, type WorkspaceToolView } from "./WorkspaceToolsPanel";

export interface SessionInfo {
	model?: string;
	thinkingLevel?: ThinkingLevel;
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

const STATUS_LABEL: Record<EngineStatus, string> = {
	idle: "Idle",
	starting: "Starting engine…",
	ready: "Ready",
	error: "Error",
	stopped: "Engine stopped",
};

function projectName(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? p;
}

const DEFAULT_SIDEBAR_WIDTH = 374;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_MAIN_WORKSPACE_WIDTH = 360;

function maxSidebarWidth(): number {
	return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_WORKSPACE_WIDTH));
}

function clampSidebarWidth(width: number): number {
	return Math.min(maxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, width));
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
type SidebarNavView = "chats" | "search" | "scheduled" | "plugins";
type SidebarOrganization = "by-project" | "recent-projects" | "chronological";
type SidebarSortMode = "manual" | "created" | "updated";

interface SidebarSettings {
	organization: SidebarOrganization;
	sortMode: SidebarSortMode;
	projectsMovedDown: boolean;
}

const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
	organization: "by-project",
	sortMode: "manual",
	projectsMovedDown: false,
};

function readSidebarSettings(): SidebarSettings {
	const organization = window.localStorage.getItem("omp.sidebar.organization");
	const sortMode = window.localStorage.getItem("omp.sidebar.sortMode");
	const projectsMovedDown = window.localStorage.getItem("omp.sidebar.projectsMovedDown") === "true";
	return {
		organization: organization === "recent-projects" || organization === "chronological" || organization === "by-project" ? organization : DEFAULT_SIDEBAR_SETTINGS.organization,
		sortMode: sortMode === "created" || sortMode === "updated" || sortMode === "manual" ? sortMode : DEFAULT_SIDEBAR_SETTINGS.sortMode,
		projectsMovedDown,
	};
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
			<button type="button" className={`project-menu-item${submenu === "organize" ? " project-menu-item--active" : ""}`} onMouseEnter={() => showSubmenu("organize")}>
				<PanelLeftClose size={16} strokeWidth={1.8} />
				<span>Organize sidebar</span>
				<ChevronRight className="project-menu-arrow" size={15} strokeWidth={1.9} />
			</button>
			<button type="button" className={`project-menu-item${submenu === "sort" ? " project-menu-item--active" : ""}`} onMouseEnter={() => showSubmenu("sort")}>
				<CalendarClock size={16} strokeWidth={1.8} />
				<span>Sort by</span>
				<ChevronRight className="project-menu-arrow" size={15} strokeWidth={1.9} />
			</button>
			</div>
			{submenu === "organize" ? (
				<div className={`project-submenu project-submenu--${submenuPlacement}`}>
					<button type="button" className={`project-menu-item${settings.organization === "by-project" ? " project-menu-item--selected" : ""}`} onClick={() => selectOrganization("by-project")}>
						<Archive size={16} strokeWidth={1.8} />
						<span>By project</span>
						{settings.organization === "by-project" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
					</button>
					<button type="button" className={`project-menu-item${settings.organization === "recent-projects" ? " project-menu-item--selected" : ""}`} onClick={() => selectOrganization("recent-projects")}>
						<FolderOpen size={16} strokeWidth={1.8} />
						<span>Recent projects</span>
						{settings.organization === "recent-projects" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
					</button>
					<button type="button" className={`project-menu-item${settings.organization === "chronological" ? " project-menu-item--selected" : ""}`} onClick={() => selectOrganization("chronological")}>
						<History size={16} strokeWidth={1.8} />
						<span>Chronological list</span>
						{settings.organization === "chronological" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
					</button>
					<button type="button" className="project-menu-item" onClick={onToggleProjectOrder}>
						<SortDesc size={16} strokeWidth={1.8} />
						<span>{settings.projectsMovedDown ? "Move up" : "Move down"}</span>
					</button>
				</div>
			) : null}
			{submenu === "sort" ? (
				<div className={`project-submenu project-submenu--${submenuPlacement}`}>
					<button type="button" className={`project-menu-item${settings.sortMode === "manual" ? " project-menu-item--selected" : ""}`} onClick={() => selectSortMode("manual")}>
						<GripVertical size={16} strokeWidth={1.8} />
						<span>Manual order</span>
						{settings.sortMode === "manual" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
					</button>
					<button type="button" className={`project-menu-item${settings.sortMode === "created" ? " project-menu-item--selected" : ""}`} onClick={() => selectSortMode("created")}>
						<CirclePlus size={16} strokeWidth={1.8} />
						<span>Created</span>
						{settings.sortMode === "created" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
					</button>
					<button type="button" className={`project-menu-item${settings.sortMode === "updated" ? " project-menu-item--selected" : ""}`} onClick={() => selectSortMode("updated")}>
						<Pencil size={16} strokeWidth={1.8} />
						<span>Last updated</span>
						{settings.sortMode === "updated" ? <Check className="project-menu-check" size={15} strokeWidth={2} /> : null}
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
	const [toolsOpen, setToolsOpen] = useState(false);
	const [toolsView, setToolsView] = useState<WorkspaceToolView>("menu");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
	const [projectMenuPlacement, setProjectMenuPlacement] = useState<"header" | "row" | null>(null);
	const [projectPinned, setProjectPinned] = useState(false);
	const [projectHidden, setProjectHidden] = useState(false);
	const [projectLabel, setProjectLabel] = useState<string | null>(null);
	const [activeSidebarView, setActiveSidebarView] = useState<SidebarNavView>("chats");
	const [historyQuery, setHistoryQuery] = useState("");
	const [archivedSessionPaths, setArchivedSessionPaths] = useState<Set<string>>(() => new Set());
	const [pinnedSessionPaths, setPinnedSessionPaths] = useState<Set<string>>(() => new Set());
	const [unreadSessionPaths, setUnreadSessionPaths] = useState<Set<string>>(() => new Set());
	const [sessionTitleOverrides, setSessionTitleOverrides] = useState<Record<string, string>>({});
	const [sidebarSettings, setSidebarSettings] = useState<SidebarSettings>(() => readSidebarSettings());
	const [sidebarNotice, setSidebarNotice] = useState<string | null>(null);

	useEffect(() => {
		window.localStorage.setItem("omp.sidebar.organization", sidebarSettings.organization);
		window.localStorage.setItem("omp.sidebar.sortMode", sidebarSettings.sortMode);
		window.localStorage.setItem("omp.sidebar.projectsMovedDown", String(sidebarSettings.projectsMovedDown));
	}, [sidebarSettings]);

	useEffect(() => {
		setProjectHidden(false);
		setProjectLabel(null);
		setArchivedSessionPaths(new Set());
		setPinnedSessionPaths(new Set());
		setUnreadSessionPaths(new Set());
		setSessionTitleOverrides({});
		setSidebarNotice(null);
	}, [workspace]);

	const visibleSessions = useMemo(() => {
		const query = historyQuery.trim().toLowerCase();
		const withOverrides = sessions.map(summary => ({
			...summary,
			title: sessionTitleOverrides[summary.path] ?? summary.title,
		}));
		const filtered = withOverrides.filter(summary => {
			if (archivedSessionPaths.has(summary.path)) return false;
			if (!query) return true;
			const title = summary.title ?? "untitled";
			return title.toLowerCase().includes(query) || summary.id.toLowerCase().includes(query);
		});
		const pinSorted = (list: SessionSummary[]): SessionSummary[] =>
			[...list].sort((left, right) => Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path)));
		switch (sidebarSettings.sortMode) {
			case "created":
				return pinSorted(filtered).sort((left, right) => {
					const pinnedDiff = Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path));
					if (pinnedDiff !== 0) return pinnedDiff;
					return new Date(right.created).getTime() - new Date(left.created).getTime();
				});
			case "updated":
				return pinSorted(filtered).sort((left, right) => {
					const pinnedDiff = Number(pinnedSessionPaths.has(right.path)) - Number(pinnedSessionPaths.has(left.path));
					if (pinnedDiff !== 0) return pinnedDiff;
					return new Date(right.modified).getTime() - new Date(left.modified).getTime();
				});
			case "manual":
				return pinSorted(filtered);
		}
	}, [archivedSessionPaths, historyQuery, pinnedSessionPaths, sessionTitleOverrides, sessions, sidebarSettings.sortMode]);

	const historyEmptyLabel = historyQuery.trim() ? "No matching chats." : archivedSessionPaths.size > 0 ? "All visible chats are archived." : "No sessions yet.";
	const currentProjectName = projectLabel ?? projectName(workspace);

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
		setSidebarNotice(onlyCurrentProject ? "Archived inactive chats in this project." : "Archived all inactive chats.");
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
		onCopyDeeplink: chat => copyText(`omp://session/${encodeURIComponent(chat.id)}`, "Deeplink"),
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
				<button type="button" className="sidebar-section-title-button" title="Projects" onClick={() => changeOrganization("by-project")}>
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
								<button type="button" className="picker-backdrop" aria-label="Close project menu" onClick={() => setProjectMenuPlacement(null)} />
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
					<button type="button" className="sidebar-mini-button" title="Create project from folder" aria-label="Create project from folder" onClick={onChangeFolder}>
						<FolderPlus size={16} strokeWidth={1.9} />
					</button>
				</div>
			</div>
			<div className={`project-row${projectMenuPlacement != null ? " project-row--active" : ""}${projectPinned ? " project-row--pinned" : ""}`}>
				<button type="button" className="project-row-main" title={workspace}>
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
								<button type="button" className="picker-backdrop" aria-label="Close project menu" onClick={() => setProjectMenuPlacement(null)} />
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
						onClick={onNewSession}
					>
						<Pencil size={15} strokeWidth={1.9} />
					</button>
				</div>
			</div>
		</div>
	) : null;

	const chatsBlock = (
		<div className="sidebar-section">
			<div className="history-title sidebar-expanded-only">{activeSidebarView === "search" ? "Search chats" : "Chats"}</div>
			{activeSidebarView === "search" ? (
				<label className="sidebar-search sidebar-expanded-only">
					<Search size={15} strokeWidth={1.8} />
					<input value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} placeholder="Search chats..." autoFocus />
				</label>
			) : null}
			{activeSidebarView === "scheduled" ? <div className="sidebar-notice sidebar-expanded-only">No scheduled tasks yet.</div> : null}
			{activeSidebarView === "plugins" ? <div className="sidebar-notice sidebar-expanded-only">Plugin management is available from the active project context.</div> : null}
			{sidebarNotice ? (
				<button type="button" className="sidebar-notice sidebar-notice--button sidebar-expanded-only" onClick={() => setSidebarNotice(null)}>
					{sidebarNotice}
				</button>
			) : null}
			<SessionHistory
				sessions={visibleSessions}
				loading={historyLoading}
				onSelect={onSelectSession}
				emptyLabel={historyEmptyLabel}
				contextActions={chatContextActions}
			/>
		</div>
	);

	return (
		<div className="app-shell">
			<aside className={`app-sidebar${sidebarCollapsed ? " app-sidebar--collapsed" : ""}`} style={sidebarCollapsed ? undefined : { width: sidebarWidth }}>
				<div className="sidebar-resize-handle" onPointerDown={startSidebarResize} />
				<div className="sidebar-top">
					<div className="sidebar-window-row">
						<button
							type="button"
							className="sidebar-icon-button"
							title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
							aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
							onClick={() => setSidebarCollapsed(collapsed => !collapsed)}
						>
							{sidebarCollapsed ? <PanelLeftOpen size={17} strokeWidth={1.8} /> : <PanelLeftClose size={17} strokeWidth={1.8} />}
						</button>
						<span className="brand-mark sidebar-expanded-only">OMP</span>
						<div className={`status status-${status}`} title={statusDetail ?? STATUS_LABEL[status]}>
							<span className="status-dot" />
							<span className="status-label">{STATUS_LABEL[status]}</span>
						</div>
					</div>
					<nav className="sidebar-nav" aria-label="Primary">
						<button
							type="button"
							className={`sidebar-nav-item${activeSidebarView === "chats" ? " sidebar-nav-item--active" : ""}`}
							disabled={disabled}
							onClick={() => {
								setSidebarView("chats");
								onNewSession();
							}}
							title="New chat"
						>
							<MessageSquarePlus size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">New chat</span>
						</button>
						<button type="button" className={`sidebar-nav-item${activeSidebarView === "search" ? " sidebar-nav-item--active" : ""}`} title="Search" onClick={() => setSidebarView("search")}>
							<Search size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Search</span>
						</button>
						<button type="button" className={`sidebar-nav-item${activeSidebarView === "scheduled" ? " sidebar-nav-item--active" : ""}`} title="Scheduled" onClick={() => setSidebarView("scheduled")}>
							<CalendarClock size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Scheduled</span>
						</button>
						<button type="button" className={`sidebar-nav-item${activeSidebarView === "plugins" ? " sidebar-nav-item--active" : ""}`} title="Plugins" onClick={() => setSidebarView("plugins")}>
							<Plug size={18} strokeWidth={1.8} />
							<span className="sidebar-nav-label">Plugins</span>
						</button>
					</nav>
					{sidebarSettings.projectsMovedDown ? null : projectBlock}
				</div>
				{chatsBlock}
				{sidebarSettings.projectsMovedDown ? projectBlock : null}
				<div className="sidebar-footer">
					<ModelPicker current={session.model} models={models} providers={loginProviders} disabled={disabled} onSelect={onSelectModel} />
					<ThinkingPicker current={session.thinkingLevel} model={session.model} models={models} disabled={disabled} onSelect={onSelectThinking} />
					<LoginMenu providers={loginProviders} disabled={disabled} onLogin={onLogin} onSetApiKey={onSetApiKey} onLogout={onLogout} />
				</div>
			</aside>

			<section className="app-workspace">
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
							<button type="button" className="top-icon-button" title="Toggle bottom panel" aria-label="Toggle bottom panel">
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

				{statusDetail && status === "error" ? <div className="error-banner">{statusDetail}</div> : null}

				<main className="app-main">
					<div className="app-center">
						<div className="app-content">
							<SubagentPanel subagents={subagents} />
							<Transcript messages={vm.messages} />
							{status === "error" && vm.stderr.length > 0 ? (
								<details className="stderr-panel">
									<summary>Engine diagnostics ({vm.stderr.length})</summary>
									<pre>{vm.stderr.join("\n")}</pre>
								</details>
							) : null}
						</div>
						<footer className="app-footer">
							<StatusBar statuses={statuses} />
							<WidgetArea widgets={widgets} placement="aboveEditor" />
							<Composer
								disabled={disabled}
								streaming={vm.streaming}
								injection={injection}
								onSend={onSend}
								onAbort={onAbort}
							/>
							<WidgetArea widgets={widgets} placement="belowEditor" />
						</footer>
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
