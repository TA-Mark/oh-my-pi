import { useEffect, useState } from "react";
import type { ScheduledTask, ScheduledTaskInput } from "../lib/rpc-protocol";

interface ScheduledTasksPanelProps {
	tasks: ScheduledTask[];
	defaultWorkspace: string;
	onSave: (input: ScheduledTaskInput) => void;
	onRemove: (id: string) => void;
	onRunNow: (id: string) => void;
}

export function ScheduledTasksPanel({ tasks, defaultWorkspace, onSave, onRemove, onRunNow }: ScheduledTasksPanelProps) {
	const [editing, setEditing] = useState<ScheduledTask | null>(null);
	const [name, setName] = useState("");
	const [workspace, setWorkspace] = useState(defaultWorkspace);
	const [prompt, setPrompt] = useState("");
	const [intervalMinutes, setIntervalMinutes] = useState(60);
	const [maxRetries, setMaxRetries] = useState(2);
	const [enabled, setEnabled] = useState(true);
	useEffect(() => {
		if (!editing) return;
		setName(editing.name);
		setWorkspace(editing.workspace);
		setPrompt(editing.prompt);
		setIntervalMinutes(editing.intervalMinutes);
		setMaxRetries(editing.maxRetries);
		setEnabled(editing.enabled);
	}, [editing]);
	useEffect(() => {
		if (!editing && !workspace) setWorkspace(defaultWorkspace);
	}, [defaultWorkspace, editing, workspace]);
	const reset = () => {
		setEditing(null);
		setName("");
		setWorkspace(defaultWorkspace);
		setPrompt("");
		setIntervalMinutes(60);
		setMaxRetries(2);
		setEnabled(true);
	};
	return (
		<div className="scheduled-tasks-panel">
			<header>
				<div>
					<h3>Scheduled Tasks</h3>
					<p>Runs through the persistent Electron background scheduler.</p>
				</div>
				<button type="button" onClick={reset}>
					New task
				</button>
			</header>
			<form
				className="scheduled-task-form"
				onSubmit={event => {
					event.preventDefault();
					if (!name.trim() || !workspace.trim() || !prompt.trim()) return;
					onSave({ id: editing?.id, name, workspace, prompt, intervalMinutes, maxRetries, enabled });
					reset();
				}}
			>
				<input value={name} onChange={event => setName(event.currentTarget.value)} placeholder="Task name" />
				<input
					value={workspace}
					onChange={event => setWorkspace(event.currentTarget.value)}
					placeholder="Absolute workspace path"
				/>
				<textarea
					value={prompt}
					onChange={event => setPrompt(event.currentTarget.value)}
					placeholder="Prompt to run"
					rows={3}
				/>
				<label>
					Every{" "}
					<input
						type="number"
						min={1}
						value={intervalMinutes}
						onChange={event => setIntervalMinutes(Number(event.currentTarget.value))}
					/>{" "}
					minutes
				</label>
				<label>
					Retries{" "}
					<input
						type="number"
						min={0}
						max={5}
						value={maxRetries}
						onChange={event => setMaxRetries(Number(event.currentTarget.value))}
					/>
				</label>
				<label>
					<input type="checkbox" checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} />{" "}
					Enabled
				</label>
				<button type="submit">{editing ? "Update task" : "Create task"}</button>
			</form>
			<div className="scheduled-task-list">
				{tasks.length === 0 ? (
					<p className="tools-placeholder-copy">No scheduled tasks.</p>
				) : (
					tasks.map(task => (
						<article key={task.id}>
							<div>
								<strong>{task.name}</strong>
								<span>
									{task.enabled ? "enabled" : "paused"} · every {task.intervalMinutes}m · next{" "}
									{new Date(task.nextRunAt).toLocaleString()}
								</span>
							</div>
							<div>
								<span className={`scheduled-task-status scheduled-task-status--${task.lastStatus ?? "idle"}`}>
									{task.lastStatus ?? "idle"}
								</span>
								<button type="button" onClick={() => setEditing(task)}>
									Edit
								</button>
								<button type="button" onClick={() => onRunNow(task.id)}>
									Run now
								</button>
								<button type="button" onClick={() => onRemove(task.id)}>
									Remove
								</button>
							</div>
							{task.lastError ? <small>{task.lastError}</small> : null}
							{task.runs.length ? (
								<small>
									Last diagnostic: {new Date(task.runs.at(-1)?.at ?? 0).toLocaleString()} ·{" "}
									{task.runs.at(-1)?.status}
								</small>
							) : null}
						</article>
					))
				)}
			</div>
		</div>
	);
}
