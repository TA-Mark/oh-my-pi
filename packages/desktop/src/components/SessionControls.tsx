import { useState } from "react";
import type { BranchMessage, SessionStats, TodoPhase } from "../lib/rpc-protocol";

interface SessionControlsProps {
	stats: SessionStats | null;
	loading: boolean;
	compacting: boolean;
	autoRetry: boolean;
	onRefresh: () => void;
	onCompact: () => void;
	onSetAutoRetry: (enabled: boolean) => void;
	onAbortRetry: () => void;
	canCompact: boolean;
	canAutoRetry: boolean;
	canAbortRetry: boolean;
	branchMessages: BranchMessage[];
	actionRunning: boolean;
	canBranch: boolean;
	canCopyLast: boolean;
	canExport: boolean;
	canHandoff: boolean;
	onBranch: (entryId: string) => void;
	onCopyLast: () => void;
	onExport: () => void;
	onHandoff: () => void;
	thinkingLevel?: string;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	autoCompaction: boolean;
	todoPhases: TodoPhase[];
	canAgentControls: boolean;
	onCycleThinking: () => void;
	onSetSteering: (mode: "all" | "one-at-a-time") => void;
	onSetFollowUp: (mode: "all" | "one-at-a-time") => void;
	onSetInterrupt: (mode: "immediate" | "wait") => void;
	onSetAutoCompaction: (enabled: boolean) => void;
}

export function SessionControls(props: SessionControlsProps) {
	const [branchEntryId, setBranchEntryId] = useState("");
	return (
		<div className="session-controls">
			<div className="session-controls-head">
				<strong>Session usage</strong>
				<button type="button" onClick={props.onRefresh} disabled={props.loading}>
					{props.loading ? "Refreshing…" : "Refresh"}
				</button>
			</div>
			{props.stats ? (
				<div className="session-stats-grid">
					<span>
						Messages <b>{props.stats.totalMessages}</b>
					</span>
					<span>
						Tool calls <b>{props.stats.toolCalls}</b>
					</span>
					<span>
						Tokens <b>{props.stats.tokens.total.toLocaleString()}</b>
					</span>
					<span>
						Cost <b>${props.stats.cost.toFixed(4)}</b>
					</span>
				</div>
			) : (
				<p>No session statistics loaded.</p>
			)}
			<div className="session-controls-actions">
				<button
					type="button"
					onClick={props.onCompact}
					disabled={!props.canCompact || props.compacting || !props.stats?.totalMessages}
				>
					{props.compacting ? "Compacting…" : "Compact context"}
				</button>
				<label>
					<input
						type="checkbox"
						checked={props.autoRetry}
						disabled={!props.canAutoRetry}
						onChange={event => props.onSetAutoRetry(event.target.checked)}
					/>{" "}
					Auto retry
				</label>
				<button type="button" onClick={props.onAbortRetry} disabled={!props.canAbortRetry}>
					Abort retry
				</button>
			</div>
			<div className="session-advanced-actions">
				<strong>Session actions</strong>
				<select
					value={branchEntryId}
					onChange={event => setBranchEntryId(event.target.value)}
					disabled={!props.canBranch || props.actionRunning}
				>
					<option value="">Choose a message to branch from</option>
					{props.branchMessages.map(message => (
						<option key={message.entryId} value={message.entryId}>
							{message.text}
						</option>
					))}
				</select>
				<button
					type="button"
					disabled={!branchEntryId || props.actionRunning}
					onClick={() => props.onBranch(branchEntryId)}
				>
					Create branch
				</button>
				<button type="button" disabled={!props.canCopyLast || props.actionRunning} onClick={props.onCopyLast}>
					Copy last response
				</button>
				<button type="button" disabled={!props.canExport || props.actionRunning} onClick={props.onExport}>
					Export HTML
				</button>
				<button type="button" disabled={!props.canHandoff || props.actionRunning} onClick={props.onHandoff}>
					Handoff
				</button>
			</div>
			<div className="agent-controls">
				<strong>Agent controls</strong>
				<button type="button" onClick={props.onCycleThinking} disabled={!props.canAgentControls}>
					Thinking: {props.thinkingLevel ?? "unknown"}
				</button>
				<label>
					Steering{" "}
					<select
						value={props.steeringMode ?? "all"}
						disabled={!props.canAgentControls}
						onChange={event => props.onSetSteering(event.target.value as "all" | "one-at-a-time")}
					>
						<option value="all">All</option>
						<option value="one-at-a-time">One at a time</option>
					</select>
				</label>
				<label>
					Follow-up{" "}
					<select
						value={props.followUpMode ?? "all"}
						disabled={!props.canAgentControls}
						onChange={event => props.onSetFollowUp(event.target.value as "all" | "one-at-a-time")}
					>
						<option value="all">All</option>
						<option value="one-at-a-time">One at a time</option>
					</select>
				</label>
				<label>
					Interrupt{" "}
					<select
						value={props.interruptMode ?? "wait"}
						disabled={!props.canAgentControls}
						onChange={event => props.onSetInterrupt(event.target.value as "immediate" | "wait")}
					>
						<option value="immediate">Immediate</option>
						<option value="wait">Wait</option>
					</select>
				</label>
				<label>
					<input
						type="checkbox"
						checked={props.autoCompaction}
						disabled={!props.canAgentControls}
						onChange={event => props.onSetAutoCompaction(event.target.checked)}
					/>{" "}
					Auto compact
				</label>
				{props.todoPhases.length > 0 ? (
					<div className="agent-todos">
						{props.todoPhases.map(phase => (
							<div key={phase.name}>
								<b>{phase.name}</b>
								{phase.tasks.map(task => (
									<span key={task.content} data-status={task.status}>
										{task.status === "completed" ? "✓" : "•"} {task.content}
									</span>
								))}
							</div>
						))}
					</div>
				) : (
					<p>No active todos.</p>
				)}
			</div>
		</div>
	);
}
