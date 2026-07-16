import type { SubagentMessage, SubagentSnapshot } from "../lib/rpc-protocol";

interface SubagentPanelProps {
	subagents: SubagentSnapshot[];
	messages: Record<string, SubagentMessage[]>;
	onLoadMessages: (agent: SubagentSnapshot) => void;
}

const ACTIVE = new Set(["running", "active", "pending", "queued", "working"]);

function messageText(message: SubagentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map(part => {
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string")
					return part.text;
				return "";
			})
			.join("");
	}
	return "";
}

export function SubagentPanel({ subagents, messages, onLoadMessages }: SubagentPanelProps) {
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
							<button type="button" className="subagent-messages-button" onClick={() => onLoadMessages(agent)}>
								Load messages
							</button>
							{messages[agent.id]?.map((message, index) => (
								<span className="subagent-message" key={`${agent.id}-${index}`}>
									<b>{message.role}:</b> {messageText(message)}
								</span>
							))}
						</li>
					);
				})}
			</ul>
		</aside>
	);
}
