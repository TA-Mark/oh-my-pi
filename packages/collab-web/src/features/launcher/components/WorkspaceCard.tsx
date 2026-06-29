import type { ReactNode } from "react";
import type { WorkspaceProfile } from "../types/launcher";

interface Props {
	workspaces: WorkspaceProfile[];
	activeId: string | null;
	onActivate(id: string): void;
}

export function WorkspaceCard({ workspaces, activeId, onActivate }: Props): ReactNode {
	return (
		<div className="lnc-card">
			<div className="lnc-card-title">Workspace / Session</div>

			{workspaces.length === 0 ? (
				<div style={{ fontSize: 12, color: "var(--fg-faint)" }}>
					No workspaces found. Start the service to load workspaces.
				</div>
			) : (
				<div className="lnc-workspace-list">
					{workspaces.map(ws => (
						<div
							key={ws.id}
							className="lnc-workspace-item"
							data-active={ws.id === activeId ? "true" : "false"}
							onClick={() => onActivate(ws.id)}
							role="button"
							tabIndex={0}
							onKeyDown={e => e.key === "Enter" && onActivate(ws.id)}
						>
							<span className="lnc-workspace-name">{ws.name}</span>
							<span className="lnc-workspace-path">{ws.path}</span>
							{ws.id === activeId && <span className="lnc-workspace-badge">Active</span>}
							{ws.lastOpenedAt && ws.id !== activeId && (
								<span style={{ fontSize: 10, color: "var(--fg-faint)", flexShrink: 0 }}>
									{new Date(ws.lastOpenedAt).toLocaleDateString()}
								</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
