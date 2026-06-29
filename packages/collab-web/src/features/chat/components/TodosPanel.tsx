/**
 * TodosPanel — read-only view of omp's session todo phases.
 *
 * Phases come from `snapshot.todoPhases` (populated from get_state). The
 * agent / user can mutate via `/todo` slash commands; this panel just
 * reflects the live state.
 */

import type { ReactNode } from "react";
import type { TodoItem, TodoPhase, TodoStatus } from "../../../lib/client";

interface Props {
	phases: readonly TodoPhase[];
}

function statusIcon(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "◐";
		case "abandoned":
			return "✗";
		default:
			return "○";
	}
}

function statusClass(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "ok";
		case "in_progress":
			return "active";
		case "abandoned":
			return "muted";
		default:
			return "pending";
	}
}

function PhaseBlock({ phase }: { phase: TodoPhase }): ReactNode {
	const total = phase.tasks.length;
	const done = phase.tasks.filter(t => t.status === "completed").length;
	return (
		<div className="mc-todo-phase">
			<div className="mc-todo-phase-head">
				<span className="mc-todo-phase-name">{phase.name}</span>
				<span className="mc-todo-phase-progress">
					{done}/{total}
				</span>
			</div>
			<ul className="mc-todo-list">
				{phase.tasks.map((task: TodoItem, i: number) => (
					<li key={`${phase.name}-${i}-${task.content.slice(0, 32)}`} className="mc-todo-item">
						<span className="mc-todo-icon" data-state={statusClass(task.status)}>
							{statusIcon(task.status)}
						</span>
						<span className="mc-todo-text" data-state={statusClass(task.status)}>
							{task.content}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function TodosPanel({ phases }: Props): ReactNode {
	if (phases.length === 0) {
		return (
			<div className="mc-todos-empty">
				No todos yet. Use <code>/todo append &lt;text&gt;</code> in chat to add one.
			</div>
		);
	}

	return (
		<div className="mc-todos">
			<div className="mc-section-title">Todos</div>
			{phases.map(phase => (
				<PhaseBlock key={phase.name} phase={phase} />
			))}
		</div>
	);
}
