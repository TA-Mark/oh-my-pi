import type { ReactNode } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import type { GuestSnapshot } from "../../../lib/client";
import type { SidebarTab } from "../hooks/useChatStateMachine";
import type { ChatSession, DataSource } from "../types/chat";
import { DataSourcesPanel } from "./DataSourcesPanel";
import { MemoryPanel } from "./MemoryPanel";
import { ProviderSettings } from "./ProviderSettings";
import { SessionList } from "./SessionList";
import { SettingsPanel } from "./SettingsPanel";
import { TodosPanel } from "./TodosPanel";
import { UserControlsPanel } from "./UserControlsPanel";

interface Props {
	open: boolean;
	tab: SidebarTab;
	// Active session bridge (null when no session is selected)
	client: ChatClient | null;
	snapshot: GuestSnapshot | null;
	// sessions
	sessions: ChatSession[];
	activeSessionId: string | null;
	sessionLoading: boolean;
	// data sources
	dataSources: DataSource[];
	// callbacks
	onTabChange(tab: SidebarTab): void;
	onSessionActivate(id: string, link: string): void;
	onSessionDelete(id: string): void;
	onSessionNew(): void;
	onSourceRefresh(id: string): void;
	onSessionRestart: ((id: string) => Promise<void>) | null;
}

const TABS: { id: SidebarTab; label: string }[] = [
	{ id: "controls", label: "Controls" },
	{ id: "providers", label: "Providers" },
	{ id: "settings", label: "Settings" },
	{ id: "memory", label: "Memory" },
	{ id: "todos", label: "Todos" },
	{ id: "sessions", label: "Sessions" },
];

export function LeftSidebar(props: Props): ReactNode {
	const {
		open,
		tab,
		client,
		snapshot,
		sessions,
		activeSessionId,
		sessionLoading,
		dataSources,
		onTabChange,
		onSessionActivate,
		onSessionDelete,
		onSessionNew,
		onSourceRefresh,
		onSessionRestart,
	} = props;

	return (
		<aside className="mc-sidebar" data-open={open ? "true" : "false"} aria-label="Control panel">
			{/* Tab bar */}
			<div className="mc-sidebar-tabs" role="tablist">
				{TABS.map(t => (
					<button
						key={t.id}
						type="button"
						role="tab"
						className="mc-tab"
						data-active={tab === t.id ? "true" : "false"}
						aria-selected={tab === t.id}
						onClick={() => onTabChange(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			{/* Content */}
			<div className="mc-sidebar-content" role="tabpanel">
				{tab === "controls" && <UserControlsPanel client={client} snapshot={snapshot} />}
				{tab === "providers" && <ProviderSettings client={client} />}
				{tab === "settings" && (
					<SettingsPanel
						client={client}
						snapshot={snapshot}
						activeSessionId={activeSessionId}
						onSessionRestart={onSessionRestart}
					/>
				)}
				{tab === "memory" && <MemoryPanel client={client} activeSessionId={activeSessionId} />}
				{tab === "todos" && <TodosPanel phases={snapshot?.todoPhases ?? []} />}
				{tab === "sessions" && (
					<SessionList
						sessions={sessions}
						activeId={activeSessionId}
						loading={sessionLoading}
						onActivate={onSessionActivate}
						onDelete={onSessionDelete}
						onNew={onSessionNew}
					/>
				)}
				{/* Sources tab removed — no OMP RPC backend; use /mcp in chat instead */}
			</div>
		</aside>
	);
}
