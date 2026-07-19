import {
	Activity,
	ArrowUpRight,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleDot,
	Code2,
	Copy,
	Cpu,
	FileCode2,
	FolderOpen,
	GitBranch,
	Image,
	Layers3,
	Plus,
	RefreshCw,
	Server,
	TerminalSquare,
	X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { EngineStatus } from "../lib/rpc-client";
import type { ChatMessage, ViewModel } from "../lib/reducer";
import type {
	GitStatus,
	ImageContent,
	ScheduledTask,
	SubagentSnapshot,
	WorkspaceFileChange,
} from "../lib/rpc-protocol";
import type { StagedContextItem } from "./ContextInspector";

interface PinnedSummaryProps {
	workspace: string;
	projectName: string;
	gitStatus: GitStatus;
	changes: WorkspaceFileChange[];
	status: EngineStatus;
	statusDetail?: string;
	vm: Pick<ViewModel, "messages" | "streaming">;
	subagents: SubagentSnapshot[];
	scheduledTasks: ScheduledTask[];
	sideChatReady: boolean;
	sideChatBusy: boolean;
	contextItems: StagedContextItem[];
	contextImages: ImageContent[];
	contextSkills: string[];
	contextMemoryBackend: string | null;
	sessionModel?: string;
	sessionName?: string;
	sessionMessageCount: number;
	onCopy: (text: string, label: string) => void;
	onOpenContext: () => void;
	onOpenTerminal: () => void;
	onCommit: () => void;
	onPush: () => void;
	onClose: () => void;
}

type SummarySectionKey = "environment" | "processes" | "sources";

function toolLabel(message: ChatMessage): string {
	return message.toolName || message.toolIntent || "Tool";
}

function statusLabel(status: EngineStatus): string {
	switch (status) {
		case "ready":
			return "Ready";
		case "starting":
			return "Starting";
		case "error":
			return "Error";
		case "stopped":
			return "Stopped";
		default:
			return "Idle";
	}
}

function Section({
	title,
	open,
	onToggle,
	action,
	children,
}: {
	title: string;
	open: boolean;
	onToggle: () => void;
	action?: () => void;
	children: ReactNode;
}) {
	return (
		<section className="pinned-summary-section">
			<div className="pinned-summary-section-head">
				<button type="button" className="pinned-summary-section-toggle" onClick={onToggle} aria-expanded={open}>
					{open ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}
					<strong>{title}</strong>
				</button>
				{action ? (
					<button type="button" className="pinned-summary-add" onClick={action} aria-label={`Add ${title.toLowerCase()}`}>
						<Plus size={15} strokeWidth={1.8} />
					</button>
				) : null}
			</div>
			{open ? <div className="pinned-summary-section-body">{children}</div> : null}
		</section>
	);
}

function SummaryRow({
	icon: Icon,
	label,
	value,
	tone,
	onClick,
	children,
}: {
	icon: typeof FolderOpen;
	label: string;
	value?: string;
	tone?: "muted" | "success" | "warning" | "danger";
	onClick?: () => void;
	children?: ReactNode;
}) {
	const content = (
		<>
			<Icon size={15} strokeWidth={1.7} />
			<span className="pinned-summary-row-label">{label}</span>
			{value ? <span className={`pinned-summary-row-value${tone ? ` pinned-summary-row-value--${tone}` : ""}`}>{value}</span> : null}
			{children}
		</>
	);
	return onClick ? (
		<button type="button" className="pinned-summary-row pinned-summary-row--button" onClick={onClick} title={value}>
			{content}
		</button>
	) : (
		<div className="pinned-summary-row" title={value}>
			{content}
		</div>
	);
}

export function PinnedSummary({
	workspace,
	projectName,
	gitStatus,
	status,
	statusDetail,
	vm,
	subagents,
	scheduledTasks,
	sideChatReady,
	sideChatBusy,
	contextItems,
	contextImages,
	contextSkills,
	contextMemoryBackend,
	sessionModel,
	sessionName,
	sessionMessageCount,
	onCopy,
	onOpenContext,
	onOpenTerminal,
	onCommit,
	onPush,
	onClose,
}: PinnedSummaryProps) {
	const [openSections, setOpenSections] = useState<Record<SummarySectionKey, boolean>>({
		environment: true,
		processes: true,
		sources: true,
	});

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const runningTools = vm.messages.filter(message => message.role === "tool" && message.toolRunning);
	const enabledSchedules = scheduledTasks.filter(task => task.enabled);
	const sourceCount = contextItems.length + contextImages.length + contextSkills.length + (contextMemoryBackend ? 1 : 0);
	const changeCount = gitStatus.staged + gitStatus.unstaged + gitStatus.untracked;
	const toggle = (section: SummarySectionKey): void => {
		setOpenSections(current => ({ ...current, [section]: !current[section] }));
	};

	return (
		<>
			<button type="button" className="pinned-summary-backdrop" aria-label="Close pinned summary" onClick={onClose} />
			<aside className="pinned-summary" aria-label="Pinned summary">
				<header className="pinned-summary-header">
					<div>
						<strong>Workspace summary</strong>
						<span>{projectName}</span>
					</div>
					<button type="button" className="pinned-summary-close" onClick={onClose} aria-label="Close pinned summary">
						<X size={16} strokeWidth={1.8} />
					</button>
				</header>

				<Section
					title="Environment"
					open={openSections.environment}
					onToggle={() => toggle("environment")}
					action={() => onCopy(workspace, "Workspace path")}
				>
					<SummaryRow icon={FolderOpen} label="Workspace" value={workspace} onClick={() => onCopy(workspace, "Workspace path")} />
					<SummaryRow icon={GitBranch} label="Branch" value={gitStatus.branch ?? "No Git branch"}>
						{changeCount > 0 ? <span className="pinned-summary-change-count">+{changeCount}</span> : null}
					</SummaryRow>
					<SummaryRow icon={Cpu} label="Engine" value={statusLabel(status)} tone={status === "error" ? "danger" : status === "ready" ? "success" : "muted"} />
					<SummaryRow icon={Code2} label="Model" value={sessionModel ?? "Default model"} />
					<SummaryRow icon={Layers3} label="Session" value={`${sessionName || "untitled"} · ${sessionMessageCount} msgs`} />
					{statusDetail ? <p className="pinned-summary-note pinned-summary-note--danger">{statusDetail}</p> : null}
					{changeCount > 0 ? (
						<div className="pinned-summary-actions">
							<button type="button" onClick={onCommit} disabled={status !== "ready"}>
								Commit
							</button>
							<button type="button" onClick={onPush} disabled={status !== "ready"}>
								Push
							</button>
						</div>
					) : null}
				</Section>

				<Section title="Background processes" open={openSections.processes} onToggle={() => toggle("processes")}>
					{vm.streaming ? (
						<SummaryRow icon={Activity} label="Agent turn" value={runningTools.length ? `${runningTools.length} tool(s) running` : "Thinking"} tone="warning" />
					) : null}
					{runningTools.map(message => (
						<SummaryRow key={message.id} icon={TerminalSquare} label={toolLabel(message)} value="Running" tone="warning" onClick={onOpenTerminal} />
					))}
					{subagents.map(agent => (
						<SummaryRow key={agent.id} icon={Server} label={agent.agent} value={agent.status} tone={agent.status === "completed" ? "success" : "warning"} />
					))}
					{sideChatBusy || sideChatReady ? <SummaryRow icon={CircleDot} label="Side chat" value={sideChatBusy ? "Running" : "Ready"} tone={sideChatBusy ? "warning" : "success"} /> : null}
					{enabledSchedules.map(task => (
						<SummaryRow key={task.id} icon={RefreshCw} label={task.name} value="Scheduled" tone="muted" />
					))}
					{!vm.streaming && runningTools.length === 0 && subagents.length === 0 && !sideChatReady && enabledSchedules.length === 0 ? (
						<p className="pinned-summary-empty">No background processes.</p>
					) : null}
				</Section>

				<Section title={`Sources${sourceCount ? ` · ${sourceCount}` : ""}`} open={openSections.sources} onToggle={() => toggle("sources")} action={onOpenContext}>
					{contextItems.map(item => (
						<SummaryRow key={item.id} icon={FileCode2} label={item.path} value={item.kind === "selection" ? "Selection" : "File"} onClick={onOpenContext} />
					))}
					{contextImages.map((image, index) => (
						<SummaryRow key={`${image.mimeType}-${index}`} icon={Image} label={`Image ${index + 1}`} value={image.mimeType} onClick={onOpenContext} />
					))}
					{contextSkills.map(skill => <SummaryRow key={skill} icon={CircleCheck} label={skill} value="Skill" onClick={onOpenContext} />)}
					{contextMemoryBackend ? <SummaryRow icon={Server} label="Memory" value={contextMemoryBackend} onClick={onOpenContext} /> : null}
					{sourceCount === 0 ? <p className="pinned-summary-empty">No sources attached.</p> : null}
					{sourceCount > 0 ? <button type="button" className="pinned-summary-view-all" onClick={onOpenContext}><ArrowUpRight size={14} strokeWidth={1.8} /> View all</button> : null}
				</Section>

				<footer className="pinned-summary-footer">
					<button type="button" onClick={() => onCopy(`${workspace}\n${gitStatus.branch ?? "No branch"}`, "Environment")}>
						<Copy size={14} strokeWidth={1.8} /> Copy environment
					</button>
				</footer>
			</aside>
		</>
	);
}
