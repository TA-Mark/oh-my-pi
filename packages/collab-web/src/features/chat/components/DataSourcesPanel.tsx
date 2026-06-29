import type { ReactNode } from "react";
import type { DataSource } from "../types/chat";

interface Props {
	sources: DataSource[];
	onRefresh(id: string): void;
}

export function DataSourcesPanel({ sources, onRefresh }: Props): ReactNode {
	return (
		<div>
			<div className="mc-section-title">Data Sources</div>

			{sources.length === 0 && (
				<div style={{ fontSize: 12, color: "var(--fg-faint)" }}>No data sources configured.</div>
			)}

			<div className="mc-source-list">
				{sources.map(src => (
					<div key={src.id} className="mc-source-item">
						<span className="mc-source-dot" data-status={src.status} />
						<span className="mc-source-name" title={src.detail}>
							{src.name}
						</span>
						<span className="mc-source-type">{src.type}</span>
						<button
							type="button"
							className="mc-source-refresh"
							title="Refresh source"
							aria-label={`Refresh ${src.name}`}
							onClick={() => onRefresh(src.id)}
						>
							↻
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
