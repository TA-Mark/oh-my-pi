import { Folder, Globe, MessageCircle, PanelRightClose, Plus, SquarePen, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
import type { HunkSelection, WorkspaceFileChange } from "../lib/rpc-protocol";
import { ChangesPanel } from "./ChangesPanel";

export type WorkspaceToolView = "menu" | "review" | "terminal" | "browser" | "files" | "side-chat";

interface WorkspaceToolsPanelProps {
	view: WorkspaceToolView;
	changes: WorkspaceFileChange[];
	disabled: boolean;
	onClose: () => void;
	onRefreshChanges: () => void;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	onSelectView: (view: WorkspaceToolView) => void;
}

interface ToolItem {
	view: WorkspaceToolView;
	label: string;
	shortcut?: string;
	icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const TOOLS: ToolItem[] = [
	{ view: "review", label: "Review", shortcut: "Ctrl+Shift+G", icon: SquarePen },
	{ view: "terminal", label: "Terminal", icon: Terminal },
	{ view: "browser", label: "Browser", shortcut: "Ctrl+T", icon: Globe },
	{ view: "files", label: "Files", shortcut: "Ctrl+P", icon: Folder },
	{ view: "side-chat", label: "Side chat", shortcut: "Ctrl+Alt+S", icon: MessageCircle },
];

const DEFAULT_REVIEW_WIDTH = 820;
const MIN_REVIEW_WIDTH = 360;
const MAX_REVIEW_WIDTH = 1280;
const MIN_MAIN_COLUMN_WIDTH = 320;

function maxReviewWidth(): number {
	return Math.max(MIN_REVIEW_WIDTH, Math.min(MAX_REVIEW_WIDTH, window.innerWidth - MIN_MAIN_COLUMN_WIDTH));
}

function clampReviewWidth(width: number): number {
	return Math.min(maxReviewWidth(), Math.max(MIN_REVIEW_WIDTH, width));
}

function FeatureMenu({ onSelectView }: { onSelectView: (view: WorkspaceToolView) => void }) {
	return (
		<div className="tools-feature-menu">
			{TOOLS.map(tool => {
				const Icon = tool.icon;
				return (
					<button key={tool.view} type="button" className="tools-feature-item" onClick={() => onSelectView(tool.view)}>
						<span className="tools-feature-left">
							<Icon size={16} strokeWidth={1.8} />
							<span>{tool.label}</span>
						</span>
						{tool.shortcut ? <span className="tools-shortcut">{tool.shortcut}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

function PlaceholderView({ title }: { title: string }) {
	return (
		<div className="tools-placeholder">
			<p className="tools-placeholder-title">{title}</p>
			<p className="tools-placeholder-copy">This surface is ready in the panel, but the desktop host has not wired it yet.</p>
		</div>
	);
}

function viewTitle(view: WorkspaceToolView): string {
	switch (view) {
		case "review":
			return "Review";
		case "terminal":
			return "Terminal";
		case "browser":
			return "Browser";
		case "files":
			return "Files";
		case "side-chat":
			return "Side chat";
		default:
			return "Workspace";
	}
}

export function WorkspaceToolsPanel({
	view,
	changes,
	disabled,
	onClose,
	onRefreshChanges,
	onStageHunks,
	onUnstage,
	onSelectView,
}: WorkspaceToolsPanelProps) {
	const isReview = view === "review";
	const [reviewWidth, setReviewWidth] = useState(DEFAULT_REVIEW_WIDTH);

	useEffect(() => {
		if (!isReview) return;
		const onWindowResize = (): void => {
			setReviewWidth(width => clampReviewWidth(width));
		};
		onWindowResize();
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, [isReview]);

	const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = reviewWidth;
		const onMove = (moveEvent: PointerEvent): void => {
			const next = startWidth + startX - moveEvent.clientX;
			setReviewWidth(clampReviewWidth(next));
		};
		const onUp = (): void => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	return (
		<aside
			className={`workspace-tools-panel workspace-tools-panel--${view}`}
			style={isReview ? { width: reviewWidth, flexBasis: reviewWidth } : undefined}
		>
			{isReview ? <div className="tools-panel-resize-handle" onPointerDown={startResize} /> : null}
			<div className={`tools-panel-head${isReview ? " tools-panel-head--review" : ""}`}>
				<div className="tools-panel-title">
					{isReview ? (
						<>
							<span className="tools-review-tab">
								<SquarePen size={15} strokeWidth={1.8} />
								Review
							</span>
							<button type="button" className="tools-review-add" title="New review tab" aria-label="New review tab">
								<Plus size={17} strokeWidth={1.8} />
							</button>
						</>
					) : (
						viewTitle(view)
					)}
				</div>
				<div className="tools-panel-actions">
					{view !== "menu" ? (
						<button type="button" className="tools-panel-link" onClick={() => onSelectView("menu")}>
							All tools
						</button>
					) : null}
					<button type="button" className="top-icon-button" title="Close side panel" aria-label="Close side panel" onClick={onClose}>
						<PanelRightClose size={16} strokeWidth={1.8} />
					</button>
				</div>
			</div>
			<div className="tools-panel-body">
				{view === "menu" ? <FeatureMenu onSelectView={onSelectView} /> : null}
				{view === "review" ? (
					<ChangesPanel
						changes={changes}
						onRefresh={onRefreshChanges}
						onStageHunks={onStageHunks}
						onUnstage={onUnstage}
						disabled={disabled}
					/>
				) : null}
				{view === "terminal" ? <PlaceholderView title="Terminal" /> : null}
				{view === "browser" ? <PlaceholderView title="Browser" /> : null}
				{view === "files" ? <PlaceholderView title="Files" /> : null}
				{view === "side-chat" ? <PlaceholderView title="Side chat" /> : null}
			</div>
		</aside>
	);
}
