import { Pencil } from "lucide-react";
import { useState } from "react";
import { normalizeAgentDisplayName } from "../lib/agent-display-name";

interface AgentNameLabelProps {
	name: string;
	onRename?: (name: string) => void;
}

export function AgentNameLabel({ name, onRename }: AgentNameLabelProps) {
	const [editing, setEditing] = useState(false);

	const commit = (value: string): void => {
		setEditing(false);
		const nextName = normalizeAgentDisplayName(value);
		if (nextName !== name) onRename?.(nextName);
	};

	if (editing) {
		return (
			<input
				className="bubble-role-input"
				autoFocus
				maxLength={40}
				defaultValue={name}
				onBlur={event => commit(event.currentTarget.value)}
				onKeyDown={event => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit(event.currentTarget.value);
					}
					if (event.key === "Escape") {
						setEditing(false);
					}
				}}
				aria-label="Agent display name"
			/>
		);
	}

	return onRename ? (
		<button type="button" className="bubble-role bubble-role-button" title="Rename agent" onClick={() => setEditing(true)}>
			{name}
			<Pencil className="bubble-role-edit-icon" size={10} strokeWidth={1.8} />
		</button>
	) : (
		<div className="bubble-role">{name}</div>
	);
}
