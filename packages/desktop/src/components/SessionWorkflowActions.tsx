import { Download, GitBranchPlus, Handshake, Pause, Play, Target, Trash2 } from "lucide-react";
import type { GoalModeState } from "../lib/rpc-protocol";

interface SessionWorkflowActionsProps {
	disabled: boolean;
	goalMode?: GoalModeState;
	onBranch: () => void;
	onExport: () => void;
	onHandoff: () => void;
	onCreateGoal: () => void;
	onPauseGoal: () => void;
	onResumeGoal: () => void;
	onDropGoal: () => void;
}

export function SessionWorkflowActions({
	disabled,
	goalMode,
	onBranch,
	onExport,
	onHandoff,
	onCreateGoal,
	onPauseGoal,
	onResumeGoal,
	onDropGoal,
}: SessionWorkflowActionsProps) {
	const goalTerminal = goalMode?.goal.status === "complete" || goalMode?.goal.status === "dropped";
	const activeGoal = goalMode && !goalTerminal ? goalMode : null;
	const goalAction = activeGoal?.enabled ? onPauseGoal : onResumeGoal;
	const goalActionLabel = activeGoal?.enabled ? "Pause goal" : "Resume goal";
	const goalActionTitle = activeGoal
		? `${goalActionLabel}: ${activeGoal.goal.objective}`
		: "Start a durable goal that can continue across multiple turns";

	return (
		<nav className="session-workflow-actions" aria-label="Task actions">
			<span className="session-workflow-title">Task actions</span>
			<button
				type="button"
				className="session-workflow-button"
				title="Branch this task from an earlier user message"
				disabled={disabled}
				onClick={onBranch}
			>
				<GitBranchPlus size={14} strokeWidth={1.9} />
				<span>Branch</span>
			</button>
			<button
				type="button"
				className="session-workflow-button"
				title="Export this task as a standalone HTML file"
				disabled={disabled}
				onClick={onExport}
			>
				<Download size={14} strokeWidth={1.9} />
				<span>Export</span>
			</button>
			<button
				type="button"
				className="session-workflow-button"
				title="Create a continuation brief and hand this task to a fresh session"
				disabled={disabled}
				onClick={onHandoff}
			>
				<Handshake size={14} strokeWidth={1.9} />
				<span>Handoff</span>
			</button>
			<span className="session-workflow-divider" aria-hidden="true" />
			<button
				type="button"
				className={`session-workflow-button session-workflow-button--goal${activeGoal ? " session-workflow-button--active" : ""}`}
				title={goalActionTitle}
				disabled={disabled}
				onClick={activeGoal ? goalAction : onCreateGoal}
			>
				{activeGoal?.enabled ? (
					<Pause size={14} strokeWidth={1.9} />
				) : activeGoal ? (
					<Play size={14} strokeWidth={1.9} />
				) : (
					<Target size={14} strokeWidth={1.9} />
				)}
				<span>{activeGoal ? goalActionLabel : "Start goal"}</span>
				{activeGoal ? (
					<span className={`session-workflow-status session-workflow-status--${activeGoal.goal.status}`}>
						{activeGoal.goal.status}
					</span>
				) : null}
			</button>
			{activeGoal ? (
				<button
					type="button"
					className="session-workflow-button session-workflow-button--danger"
					title={`Drop goal: ${activeGoal.goal.objective}`}
					aria-label="Drop goal"
					disabled={disabled}
					onClick={onDropGoal}
				>
					<Trash2 size={14} strokeWidth={1.9} />
					<span>Drop</span>
				</button>
			) : null}
		</nav>
	);
}
