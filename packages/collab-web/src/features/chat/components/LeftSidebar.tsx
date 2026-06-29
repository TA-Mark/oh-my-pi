import type { ReactNode } from "react";
import type { SidebarTab } from "../hooks/useChatStateMachine";
import type { ChatSession, DataSource, RuntimeConfig } from "../types/chat";
import { DataSourcesPanel } from "./DataSourcesPanel";
import { SessionList } from "./SessionList";
import { UserControlsPanel } from "./UserControlsPanel";

interface Props {
	open: boolean;
	tab: SidebarTab;
	// sessions
	sessions: ChatSession[];
	activeSessionId: string | null;
	sessionLoading: boolean;
	// data sources
	dataSources: DataSource[];
	// config
	runtimeConfig: RuntimeConfig | null;
	availableModels: string[];
	configLoading: boolean;
	// callbacks
	onTabChange(tab: SidebarTab): void;
	onSessionActivate(id: string, link: string): void;
	onSessionDelete(id: string): void;
	onSessionNew(): void;
	onSourceRefresh(id: string): void;
	onConfigUpdate(patch: Partial<RuntimeConfig>): void;
}

const TABS: { id: SidebarTab; label: string }[] = [
	{ id: "controls", label: "Controls" },
	{ id: "sessions", label: "Sessions" },
	{ id: "sources", label: "Sources" },
];

export function LeftSidebar(props: Props): ReactNode {
	const {
		open,
		tab,
		sessions,
		activeSessionId,
		sessionLoading,
		dataSources,
		runtimeConfig,
		availableModels,
		configLoading,
		onTabChange,
		onSessionActivate,
		onSessionDelete,
		onSessionNew,
		onSourceRefresh,
		onConfigUpdate,
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
				{tab === "controls" && (
					<UserControlsPanel
						config={runtimeConfig}
						availableModels={availableModels}
						loading={configLoading}
						onUpdate={onConfigUpdate}
					/>
				)}

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

				{tab === "sources" && <DataSourcesPanel sources={dataSources} onRefresh={onSourceRefresh} />}
			</div>
		</aside>
	);
}
