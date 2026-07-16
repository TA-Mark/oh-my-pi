import type { SubagentSnapshot } from "../lib/rpc-protocol";

interface SubagentPanelProps {
	subagents: SubagentSnapshot[];
}

const ACTIVE = new Set(["running", "active", "pending", "queued", "working"]);

export function SubagentPanel({ subagents }: SubagentPanelProps) {
	if (subagents.length === 0) return null;
	return (
		<aside className="subagent-panel">
			<div className="subagent-title">Subagents ({subagents.length})</div>
			<ul className="subagent-list">
				{subagents.map(agent => {
					const detail = agent.task ?? agent.assignment ?? agent.description;
					const kind = ACTIVE.has(agent.status) ? "active" : agent.status;
					return (
						<li key={agent.id} className={`subagent-item subagent-${kind}`}>
							<span className="subagent-dot" />
							<span className="subagent-agent">{agent.agent}</span>
							<span className="subagent-status">{agent.status}</span>
							{detail ? <span className="subagent-task">{detail}</span> : null}
						</li>
					);
				})}
			</ul>
		</aside>
	);
}
