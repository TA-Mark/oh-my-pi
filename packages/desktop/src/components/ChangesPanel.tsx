import {
	ArrowRight,
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	ExternalLink,
	FileSearch,
	FolderOpen,
	GitBranch,
	GitCommitHorizontal,
	GitPullRequestCreate,
	ListCollapse,
	MoreHorizontal,
	PanelRightOpen,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	SquareSplitHorizontal,
	Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	GitStatus,
	HunkSelection,
	ReviewCommit,
	ReviewScope,
	WorkspaceEntry,
	WorkspaceFileChange,
} from "../lib/rpc-protocol";

interface ChangesPanelProps {
	changes: WorkspaceFileChange[];
	workspaceEntries: WorkspaceEntry[];
	workspaceFilesLoading: boolean;
	workspaceFilesTruncated: boolean;
	onRefreshWorkspaceFiles: (query?: string) => void;
	gitStatus: GitStatus;
	onRefresh: () => void;
	onLoadReview: (scope: ReviewScope, ref?: string) => Promise<WorkspaceFileChange[]>;
	onLoadReviewCommits: () => Promise<ReviewCommit[]>;
	onStageHunks: (selections: HunkSelection[]) => void;
	onUnstage: (files?: string[]) => void;
	onRevertFiles: (files: string[]) => void;
	onCommit: () => void;
	onPush: () => void;
	onCreatePullRequest: () => void;
	disabled: boolean;
}

export function stageSelectionsForChanges(changes: readonly WorkspaceFileChange[]): HunkSelection[] {
	return changes.map(change => ({ path: change.path, hunks: { type: "all" } }));
}

type DiffMode = "unified" | "split";
type DiffLineKind = "context" | "add" | "del" | "note";

interface DiffLine {
	key: string;
	kind: DiffLineKind;
	oldLine: number | null;
	newLine: number | null;
	content: string;
}

interface DiffHunk {
	key: string;
	hiddenBefore: number;
	rows: DiffLine[];
}

type DiffRenderItem =
	| {
			type: "gap";
			key: string;
			height: number;
			count: number;
	  }
	| {
			type: "row";
			key: string;
			height: number;
			row: DiffLine;
	  };

interface DiffRenderRange {
	start: number;
	end: number;
	top: number;
	bottom: number;
}

interface FileTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: FileTreeNode[];
	change?: WorkspaceFileChange;
	hasChanges: boolean;
}

interface FileTreeDraft {
	name: string;
	path: string;
	type: "file" | "directory";
	children: Map<string, FileTreeDraft>;
	change?: WorkspaceFileChange;
}

const DIFF_ROW_HEIGHT = 24;
const HUNK_GAP_HEIGHT = 32;
const DIFF_OVERSCAN_PX = 900;
const INITIAL_DIFF_RENDER_HEIGHT = 1400;

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	return { dir, name };
}

function fileDomId(scope: string, path: string): string {
	return `review-file-${scope}-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function jumpToFile(scope: string, path: string): void {
	document.getElementById(fileDomId(scope, path))?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function sectionStateKey(scope: string, path: string): string {
	return `${scope}:${path}`;
}

function fileExtension(path: string): string {
	const name = splitPath(path).name;
	const dot = name.lastIndexOf(".");
	return dot >= 0
		? name
				.slice(dot + 1)
				.slice(0, 2)
				.toUpperCase()
		: "F";
}

function statusLabel(status: WorkspaceFileChange["status"]): string | null {
	switch (status) {
		case "added":
			return "new";
		case "untracked":
			return "untracked";
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		default:
			return null;
	}
}

function relativeCommitTime(committedAt: number): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - committedAt) / 1000));
	if (elapsedSeconds < 60) return "now";
	const minutes = Math.floor(elapsedSeconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

function shouldAutoCollapse(change: WorkspaceFileChange): boolean {
	return change.status === "untracked" || change.additions + change.deletions > 220;
}

function parseRange(value: string | undefined): number {
	if (!value) return 1;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : 1;
}

function parseUnifiedDiff(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	const lines = diff.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	let currentRows: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let previousOldEnd = 0;
	let previousNewEnd = 0;
	let currentHiddenBefore = 0;
	let hunkIndex = 0;

	const finishHunk = (): void => {
		if (currentRows.length === 0) return;
		hunks.push({ key: `hunk-${hunkIndex}`, hiddenBefore: currentHiddenBefore, rows: currentRows });
		currentRows = [];
		previousOldEnd = Math.max(previousOldEnd, oldLine - 1);
		previousNewEnd = Math.max(previousNewEnd, newLine - 1);
		hunkIndex += 1;
	};

	for (const line of lines) {
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			finishHunk();
			const oldStart = parseRange(hunk[1]);
			const newStart = parseRange(hunk[3]);
			oldLine = oldStart;
			newLine = newStart;
			const oldGap = oldStart > 0 ? oldStart - previousOldEnd - 1 : 0;
			const newGap = newStart > 0 ? newStart - previousNewEnd - 1 : 0;
			currentHiddenBefore = Math.max(oldGap, newGap, 0);
			continue;
		}
		if (currentRows.length === 0 && oldLine === 0 && newLine === 0) continue;
		const key = `row-${hunkIndex}-${currentRows.length}`;
		if (line.startsWith("+")) {
			currentRows.push({ key, kind: "add", oldLine: null, newLine, content: line.slice(1) });
			newLine += 1;
		} else if (line.startsWith("-")) {
			currentRows.push({ key, kind: "del", oldLine, newLine: null, content: line.slice(1) });
			oldLine += 1;
		} else if (line.startsWith("\\")) {
			currentRows.push({ key, kind: "note", oldLine: null, newLine: null, content: line });
		} else {
			const content = line.startsWith(" ") ? line.slice(1) : line;
			currentRows.push({ key, kind: "context", oldLine, newLine, content });
			oldLine += 1;
			newLine += 1;
		}
	}
	finishHunk();
	return hunks;
}

function flattenDiffHunks(hunks: DiffHunk[]): DiffRenderItem[] {
	const items: DiffRenderItem[] = [];
	for (const hunk of hunks) {
		if (hunk.hiddenBefore > 0) {
			items.push({ type: "gap", key: `${hunk.key}-gap`, height: HUNK_GAP_HEIGHT, count: hunk.hiddenBefore });
		}
		for (const row of hunk.rows) {
			items.push({ type: "row", key: row.key, height: DIFF_ROW_HEIGHT, row });
		}
	}
	return items;
}

function buildItemOffsets(items: DiffRenderItem[]): number[] {
	const offsets = new Array<number>(items.length + 1);
	offsets[0] = 0;
	for (let index = 0; index < items.length; index += 1) {
		offsets[index + 1] = offsets[index] + items[index].height;
	}
	return offsets;
}

function findOffsetIndex(offsets: number[], value: number): number {
	let low = 0;
	let high = Math.max(0, offsets.length - 1);
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (offsets[mid + 1] <= value) low = mid + 1;
		else high = mid;
	}
	return low;
}

function visibleRangeFromOffsets(offsets: number[], top: number, bottom: number): DiffRenderRange {
	const itemCount = Math.max(0, offsets.length - 1);
	const totalHeight = offsets[itemCount] ?? 0;
	const safeTop = Math.max(0, Math.min(top, totalHeight));
	const safeBottom = Math.max(safeTop, Math.min(bottom, totalHeight));
	const start = Math.min(itemCount, findOffsetIndex(offsets, safeTop));
	const end = Math.min(itemCount, findOffsetIndex(offsets, safeBottom) + 1);
	return {
		start,
		end,
		top: offsets[start] ?? 0,
		bottom: totalHeight - (offsets[end] ?? totalHeight),
	};
}

function findScrollRoot(element: HTMLElement): HTMLElement | Window {
	let current = element.parentElement;
	while (current) {
		const style = window.getComputedStyle(current);
		if (style.overflowY === "auto" || style.overflowY === "scroll") return current;
		current = current.parentElement;
	}
	return window;
}

function scrollRootBounds(scrollRoot: HTMLElement | Window): { top: number; bottom: number } {
	if (scrollRoot instanceof Window) return { top: 0, bottom: scrollRoot.innerHeight };
	const rect = scrollRoot.getBoundingClientRect();
	return { top: rect.top, bottom: rect.bottom };
}

function buildFileTree(entries: WorkspaceEntry[], changes: WorkspaceFileChange[]): FileTreeNode[] {
	const root: FileTreeDraft = { name: "", path: "", type: "directory", children: new Map() };
	const changesByPath = new Map(changes.map(change => [change.path, change]));
	const addPath = (entryPath: string, type: "file" | "directory", change?: WorkspaceFileChange): void => {
		const parts = entryPath.split("/").filter(Boolean);
		let node = root;
		let path = "";
		for (const part of parts) {
			path = path ? `${path}/${part}` : part;
			const existing = node.children.get(part);
			if (existing) {
				node = existing;
				continue;
			}
			const next: FileTreeDraft = {
				name: part,
				path,
				type: "directory",
				children: new Map(),
			};
			node.children.set(part, next);
			node = next;
		}
		node.type = type;
		node.change = change;
	};
	for (const entry of entries) addPath(entry.path, entry.type, changesByPath.get(entry.path));
	for (const change of changes) {
		if (!entries.some(entry => entry.path === change.path)) addPath(change.path, "file", change);
	}
	const toNode = (draft: FileTreeDraft): FileTreeNode => {
		const children = Array.from(draft.children.values())
			.map(toNode)
			.sort((left, right) => {
				if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
				if (left.change && !right.change) return -1;
				if (!left.change && right.change) return 1;
				return left.name.localeCompare(right.name);
			});
		return {
			name: draft.name,
			path: draft.path,
			type: draft.type,
			change: draft.change,
			children,
			hasChanges: Boolean(draft.change) || children.some(child => child.hasChanges),
		};
	};
	const compactNode = (node: FileTreeNode): FileTreeNode => {
		let current = node;
		while (
			current.type === "directory" &&
			!current.change &&
			current.children.length === 1 &&
			!current.children[0]?.change
		) {
			const child = current.children[0];
			if (child.type !== "directory") break;
			current = { ...child, name: `${current.name}/${child.name}` };
		}
		return { ...current, children: current.children.map(compactNode) };
	};

	return Array.from(root.children.values()).map(toNode).map(compactNode);
}

function ChangeBadge({ tone, children }: { tone?: "add" | "del" | "muted"; children: ReactNode }): ReactNode {
	return <span className={`review-badge${tone ? ` review-badge--${tone}` : ""}`}>{children}</span>;
}

function FileKind({ path }: { path: string }): ReactNode {
	return <span className="changes-kind">{fileExtension(path)}</span>;
}

function FilePath({ path }: { path: string }): ReactNode {
	const { dir, name } = splitPath(path);
	return (
		<span className="changes-path">
			{dir && <span className="changes-path-dir">{dir}</span>}
			<span className="changes-path-name">{name}</span>
		</span>
	);
}

function LineNumber({ value }: { value: number | null }): ReactNode {
	return <span className="review-line-no">{value == null ? "" : value}</span>;
}

function HunkGap({ count }: { count: number }): ReactNode {
	if (count <= 0) return null;
	return (
		<div className="review-hunk-gap">
			<span className="review-hunk-gap-controls" aria-hidden="true">
				<ChevronDown size={15} strokeWidth={1.9} />
				<ChevronUp size={15} strokeWidth={1.9} />
			</span>
			<span className="review-hunk-gap-label">{count.toLocaleString()} unmodified lines</span>
		</div>
	);
}

function UnifiedDiffRow({ row }: { row: DiffLine }): ReactNode {
	const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : "";
	return (
		<div className={`review-diff-row review-diff-row--${row.kind}`}>
			<LineNumber value={row.oldLine} />
			<LineNumber value={row.newLine} />
			<span className="review-line-sign">{sign}</span>
			<code className="review-code">{row.content || " "}</code>
		</div>
	);
}

function SplitDiffRow({ row }: { row: DiffLine }): ReactNode {
	const leftContent = row.kind === "add" ? "" : row.content;
	const rightContent = row.kind === "del" ? "" : row.content;
	return (
		<div className={`review-split-row review-split-row--${row.kind}`}>
			<div className="review-split-side review-split-side--old">
				<LineNumber value={row.oldLine} />
				<span className="review-line-sign">{row.kind === "del" ? "-" : ""}</span>
				<code className="review-code">{leftContent || " "}</code>
			</div>
			<div className="review-split-side review-split-side--new">
				<LineNumber value={row.newLine} />
				<span className="review-line-sign">{row.kind === "add" ? "+" : ""}</span>
				<code className="review-code">{rightContent || " "}</code>
			</div>
		</div>
	);
}

function DiffRenderNode({ item, mode }: { item: DiffRenderItem; mode: DiffMode }): ReactNode {
	if (item.type === "gap") return <HunkGap count={item.count} />;
	return mode === "split" ? <SplitDiffRow row={item.row} /> : <UnifiedDiffRow row={item.row} />;
}

function VirtualizedDiffRows({ items, mode }: { items: DiffRenderItem[]; mode: DiffMode }): ReactNode {
	const diffRef = useRef<HTMLDivElement>(null);
	const animationFrameRef = useRef<number | null>(null);
	const offsets = useMemo(() => buildItemOffsets(items), [items]);
	const [range, setRange] = useState<DiffRenderRange>(() =>
		visibleRangeFromOffsets(buildItemOffsets(items), 0, INITIAL_DIFF_RENDER_HEIGHT),
	);
	const updateRange = useCallback((): void => {
		const diffElement = diffRef.current;
		if (!diffElement) return;
		const scrollRoot = findScrollRoot(diffElement);
		const rootBounds = scrollRootBounds(scrollRoot);
		const diffBounds = diffElement.getBoundingClientRect();
		const top = rootBounds.top - diffBounds.top - DIFF_OVERSCAN_PX;
		const bottom = rootBounds.bottom - diffBounds.top + DIFF_OVERSCAN_PX;
		const nextRange = visibleRangeFromOffsets(offsets, top, bottom);
		setRange(previous =>
			previous.start === nextRange.start &&
			previous.end === nextRange.end &&
			previous.top === nextRange.top &&
			previous.bottom === nextRange.bottom
				? previous
				: nextRange,
		);
	}, [offsets]);
	const scheduleRangeUpdate = useCallback((): void => {
		if (animationFrameRef.current != null) return;
		animationFrameRef.current = window.requestAnimationFrame(() => {
			animationFrameRef.current = null;
			updateRange();
		});
	}, [updateRange]);

	useEffect(() => {
		const diffElement = diffRef.current;
		if (!diffElement) return;
		const scrollRoot = findScrollRoot(diffElement);
		const resizeObserver = new ResizeObserver(scheduleRangeUpdate);
		const target = scrollRoot instanceof Window ? window : scrollRoot;
		target.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
		window.addEventListener("resize", scheduleRangeUpdate);
		resizeObserver.observe(diffElement);
		if (scrollRoot instanceof HTMLElement) resizeObserver.observe(scrollRoot);
		scheduleRangeUpdate();
		return () => {
			target.removeEventListener("scroll", scheduleRangeUpdate);
			window.removeEventListener("resize", scheduleRangeUpdate);
			resizeObserver.disconnect();
			if (animationFrameRef.current != null) {
				window.cancelAnimationFrame(animationFrameRef.current);
				animationFrameRef.current = null;
			}
		};
	}, [scheduleRangeUpdate]);

	useEffect(() => {
		scheduleRangeUpdate();
	}, [items, mode, scheduleRangeUpdate]);

	const visibleItems = items.slice(range.start, range.end);
	return (
		<div ref={diffRef}>
			{range.top > 0 ? <div className="review-diff-spacer" style={{ height: range.top }} /> : null}
			{visibleItems.map(item => (
				<DiffRenderNode key={item.key} item={item} mode={mode} />
			))}
			{range.bottom > 0 ? <div className="review-diff-spacer" style={{ height: range.bottom }} /> : null}
		</div>
	);
}

function DiffView({ change, mode }: { change: WorkspaceFileChange; mode: DiffMode }): ReactNode {
	const hunks = useMemo(() => parseUnifiedDiff(change.diff), [change.diff]);
	const items = useMemo(() => flattenDiffHunks(hunks), [hunks]);
	if (change.truncated)
		return <div className="changes-note">Diff omitted because this file is binary or too large.</div>;
	if (!change.diff || hunks.length === 0) return <div className="changes-note">No textual diff available.</div>;
	return (
		<div className={`review-diff review-diff--${mode}`}>
			<VirtualizedDiffRows items={items} mode={mode} />
		</div>
	);
}

function FileActions({
	change,
	disabled,
	scopeKey,
	action,
	onAction,
}: {
	change: WorkspaceFileChange;
	disabled: boolean;
	scopeKey: string;
	action: "stage" | "unstage" | null;
	onAction: (path: string) => void;
}): ReactNode {
	return (
		<span className="changes-file-actions">
			<span className="changes-total changes-total--add">+{change.additions.toLocaleString()}</span>
			<span className="changes-total changes-total--del">-{change.deletions.toLocaleString()}</span>
			<button
				type="button"
				className="changes-icon-button changes-icon-button--compact"
				title="Revert file"
				disabled
			>
				<Undo2 size={15} />
			</button>
			{action ? (
				<button
					type="button"
					className="changes-icon-button changes-icon-button--compact"
					title={action === "stage" ? "Stage file" : "Unstage file"}
					disabled={disabled}
					onClick={event => {
						event.stopPropagation();
						onAction(change.path);
					}}
				>
					{action === "stage" ? <Plus size={15} /> : <Undo2 size={15} />}
				</button>
			) : null}
			<button
				type="button"
				className="changes-icon-button changes-icon-button--compact"
				title="Jump to file"
				onClick={() => jumpToFile(scopeKey, change.path)}
			>
				<ExternalLink size={15} />
			</button>
		</span>
	);
}

function FileChangeSection({
	scopeKey,
	change,
	mode,
	collapsed,
	disabled,
	onToggleCollapsed,
	onSelect,
	action,
	onAction,
}: {
	scopeKey: string;
	change: WorkspaceFileChange;
	mode: DiffMode;
	collapsed: boolean;
	disabled: boolean;
	onToggleCollapsed: (scopeKey: string, path: string, autoCollapsed: boolean) => void;
	onSelect: (path: string) => void;
	action: "stage" | "unstage" | null;
	onAction: (path: string) => void;
}): ReactNode {
	const label = statusLabel(change.status);
	const sectionRef = useRef<HTMLElement>(null);
	const [isDiffNearViewport, setIsDiffNearViewport] = useState(false);
	const autoCollapsed = shouldAutoCollapse(change);
	useEffect(() => {
		if (collapsed || isDiffNearViewport) return;
		const section = sectionRef.current;
		if (!section) {
			setIsDiffNearViewport(true);
			return;
		}
		const observer = new IntersectionObserver(
			entries => {
				if (entries.some(entry => entry.isIntersecting)) setIsDiffNearViewport(true);
			},
			{ rootMargin: "900px 0px" },
		);
		observer.observe(section);
		return () => observer.disconnect();
	}, [collapsed, isDiffNearViewport]);
	return (
		<section
			ref={sectionRef}
			id={fileDomId(scopeKey, change.path)}
			className={`changes-file${collapsed ? " changes-file--collapsed" : ""}`}
		>
			<div className="changes-file-head">
				<button
					type="button"
					className="changes-file-title"
					onClick={() => {
						onSelect(change.path);
						onToggleCollapsed(scopeKey, change.path, autoCollapsed);
					}}
				>
					<FileKind path={change.path} />
					<FilePath path={change.path} />
					<span className="changes-file-caret">
						{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
					</span>
				</button>
				<span className="changes-file-meta">
					{label ? <ChangeBadge tone={change.status === "deleted" ? "del" : "add"}>{label}</ChangeBadge> : null}
					<FileActions
						change={change}
						disabled={disabled}
						scopeKey={scopeKey}
						action={action}
						onAction={onAction}
					/>
				</span>
			</div>
			{!collapsed && isDiffNearViewport ? <DiffView change={change} mode={mode} /> : null}
		</section>
	);
}
const MemoizedFileChangeSection = memo(FileChangeSection);

function ChangeSection({
	title,
	scopeKey,
	changes,
	mode,
	disabled,
	allActionLabel,
	allActionDisabled,
	onAllAction,
	rowAction,
	onRowAction,
	isCollapsed,
	onToggleCollapsed,
	onSelect,
	emptyMessage,
}: {
	title: string;
	scopeKey: string;
	changes: WorkspaceFileChange[];
	mode: DiffMode;
	disabled: boolean;
	allActionLabel?: string;
	allActionDisabled?: boolean;
	onAllAction?: () => void;
	rowAction: "stage" | "unstage" | null;
	onRowAction: (path: string) => void;
	isCollapsed: (scopeKey: string, change: WorkspaceFileChange) => boolean;
	onToggleCollapsed: (scopeKey: string, path: string, autoCollapsed: boolean) => void;
	onSelect: (path: string) => void;
	emptyMessage: string;
}): ReactNode {
	return (
		<section className="changes-section">
			<div className="changes-section-head">
				<div className="changes-section-title">
					<h3>{title}</h3>
					<span>
						{changes.length} file{changes.length === 1 ? "" : "s"}
					</span>
				</div>
				{onAllAction && allActionLabel ? (
					<button
						type="button"
						className="changes-section-action"
						onClick={onAllAction}
						disabled={allActionDisabled}
					>
						{allActionLabel}
					</button>
				) : null}
			</div>
			{changes.length === 0 ? (
				<p className="changes-empty">{emptyMessage}</p>
			) : (
				changes.map(change => (
					<MemoizedFileChangeSection
						key={`${scopeKey}:${change.path}`}
						scopeKey={scopeKey}
						change={change}
						mode={mode}
						collapsed={isCollapsed(scopeKey, change)}
						disabled={disabled}
						onToggleCollapsed={onToggleCollapsed}
						onSelect={onSelect}
						action={rowAction}
						onAction={onRowAction}
					/>
				))
			)}
		</section>
	);
}

function FileTreeNodeView({
	node,
	activePath,
	onJump,
	depth,
}: {
	node: FileTreeNode;
	activePath: string | null;
	onJump: (path: string) => void;
	depth: number;
}): ReactNode {
	const [expanded, setExpanded] = useState(() => node.hasChanges);
	if (node.type === "file") {
		const marker =
			node.change?.status === "added" || node.change?.status === "untracked"
				? "+"
				: node.change?.status === "deleted"
					? "−"
					: node.change?.status === "renamed"
						? "R"
						: node.change
							? "M"
							: "";
		return (
			<button
				type="button"
				className={`review-tree-file${activePath === node.path ? " review-tree-file--active" : ""}${node.change ? " review-tree-file--changed" : ""}`}
				style={{ paddingLeft: 14 + depth * 20 }}
				disabled={!node.change}
				onClick={() => node.change && onJump(node.path)}
				title={node.change ? node.path : `${node.path} (unchanged)`}
			>
				<FileKind path={node.path} />
				<span>{node.name}</span>
				{marker ? (
					<span className={`review-tree-status review-tree-status--${node.change?.status}`}>{marker}</span>
				) : null}
			</button>
		);
	}
	return (
		<div className="review-tree-dir">
			<button
				type="button"
				className={`review-tree-dir-label${node.hasChanges ? " review-tree-dir-label--changed" : ""}`}
				style={{ paddingLeft: 12 + depth * 20 }}
				onClick={() => setExpanded(value => !value)}
				aria-expanded={expanded}
				aria-label={`${expanded ? "Collapse" : "Expand"} ${node.path}`}
				title={node.path}
			>
				{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
				<span>{node.name}</span>
				{node.hasChanges ? <span className="review-tree-dir-dot" aria-label="Contains changed files" /> : null}
			</button>
			{expanded ? (
				<FileTree nodes={node.children} activePath={activePath} onJump={onJump} depth={depth + 1} />
			) : null}
		</div>
	);
}

function FileTree({
	nodes,
	activePath,
	onJump,
	depth = 0,
}: {
	nodes: FileTreeNode[];
	activePath: string | null;
	onJump: (path: string) => void;
	depth?: number;
}): ReactNode {
	return (
		<div className="review-tree-group">
			{nodes.map(node => (
				<FileTreeNodeView key={node.path} node={node} activePath={activePath} onJump={onJump} depth={depth} />
			))}
		</div>
	);
}

function ReviewOptions({
	hiddenCount,
	revertDisabled,
	refreshDisabled,
	onShowAll,
	onRefresh,
	onRevertAll,
	showUnstageAll,
	onUnstageAll,
	showStageAll,
	onStageAll,
}: {
	hiddenCount: number;
	revertDisabled: boolean;
	refreshDisabled: boolean;
	onShowAll: () => void;
	onRefresh: () => void;
	onRevertAll: () => void;
	showUnstageAll: boolean;
	onUnstageAll: () => void;
	showStageAll: boolean;
	onStageAll: () => void;
}): ReactNode {
	return (
		<div className="review-options-menu">
			<button type="button" onClick={onRefresh} disabled={refreshDisabled}>
				<RefreshCw className={refreshDisabled ? "spin" : ""} size={14} />
				Refresh
			</button>
			{showUnstageAll ? (
				<button type="button" onClick={onUnstageAll}>
					<Undo2 size={14} />
					Unstage all
				</button>
			) : null}
			<button type="button" onClick={onRevertAll} disabled={revertDisabled}>
				<RotateCcw size={14} />
				Revert all
			</button>
			{showStageAll ? (
				<button type="button" onClick={onStageAll}>
					<Plus size={14} />
					Stage all
				</button>
			) : null}
			<button type="button" onClick={onShowAll} disabled={hiddenCount === 0}>
				<PanelRightOpen size={14} />
				Show hidden files{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
			</button>
		</div>
	);
}

function CommitOrPushControl({
	disabled,
	commitDisabled,
	pushDisabled,
	prDisabled,
	onCommit,
	onPush,
	onCreatePullRequest,
}: {
	disabled: boolean;
	commitDisabled: boolean;
	pushDisabled: boolean;
	prDisabled: boolean;
	onCommit: () => void;
	onPush: () => void;
	onCreatePullRequest: () => void;
}): ReactNode {
	const menuRef = useRef<HTMLDetailsElement>(null);
	const closeMenu = (): void => menuRef.current?.removeAttribute("open");
	return (
		<details ref={menuRef} className="review-commit-control">
			<summary className="review-commit-primary" aria-label="Commit or push">
				<GitCommitHorizontal size={15} strokeWidth={1.8} />
				<span>Commit or push</span>
				<ChevronDown size={14} strokeWidth={1.8} />
			</summary>
			<div className="review-commit-menu">
				<button
					type="button"
					disabled={disabled || commitDisabled}
					onClick={() => {
						closeMenu();
						onCommit();
					}}
				>
					<GitCommitHorizontal size={14} />
					Commit staged
				</button>
				<button
					type="button"
					disabled={disabled || pushDisabled}
					onClick={() => {
						closeMenu();
						onPush();
					}}
				>
					<GitPullRequestCreate size={14} />
					Push branch
				</button>
				<button
					type="button"
					disabled={disabled || prDisabled}
					onClick={() => {
						closeMenu();
						onCreatePullRequest();
					}}
				>
					<GitPullRequestCreate size={14} />
					Create pull request
				</button>
			</div>
		</details>
	);
}

interface ReviewSelection {
	scope: ReviewScope;
	ref?: string;
	label: string;
}

interface CommitFlyoutPosition {
	top: number;
	left: number;
	width: number;
}

function BranchSelector({
	branch,
	branches,
	loading,
	onSelect,
}: {
	branch: string | null;
	branches: string[];
	loading: boolean;
	onSelect: (branch: string) => void;
}): ReactNode {
	const [filter, setFilter] = useState("");
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const normalizedFilter = filter.trim().toLowerCase();
	const options = useMemo(
		() =>
			[...(branch ? [branch] : []), ...branches]
				.filter((name, index, all) => all.indexOf(name) === index)
				.filter(name => !name.endsWith("/HEAD"))
				.filter(name => name !== "origin" && name !== "upstream")
				.filter(name => !normalizedFilter || name.toLowerCase().includes(normalizedFilter))
				.sort((left, right) => {
					const score = (name: string): number => {
						if (name === branch) return 0;
						if (name === "origin/main" || name === "main") return 1;
						if (!name.includes("/")) return 2;
						if (name.startsWith("origin/")) return 3;
						return 4;
					};
					return score(left) - score(right) || left.localeCompare(right);
				})
				.slice(0, normalizedFilter ? 100 : 50),
		[branch, branches, normalizedFilter],
	);
	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent): void => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			setOpen(false);
		};
		const handleEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [open]);
	return (
		<div ref={menuRef} className={`changes-branch-selector${open ? " changes-branch-selector--open" : ""}`}>
			<button
				type="button"
				className="changes-branch-button"
				aria-label="Select branch"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<GitBranch size={14} strokeWidth={1.8} />
				<span>{branch ?? "Branch"}</span>
				<ChevronDown size={14} strokeWidth={1.9} />
			</button>
			{open ? (
				<div className="changes-branch-menu">
					<label className="changes-branch-search">
						<Search size={14} strokeWidth={1.8} />
						<input
							value={filter}
							onChange={event => setFilter(event.currentTarget.value)}
							placeholder="Search branches"
						/>
					</label>
					<div className="changes-branch-menu-label">Branches</div>
					<div className="changes-branch-list" role="listbox" aria-label="Branches">
						{options.length === 0 ? (
							<div className="changes-branch-empty">No matching branches.</div>
						) : (
							options.map(name => (
								<button
									key={name}
									type="button"
									className="changes-branch-option"
									role="option"
									aria-selected={name === branch}
									disabled={loading}
									onClick={() => {
										setOpen(false);
										onSelect(name);
									}}
								>
									<GitBranch size={14} strokeWidth={1.7} />
									<span>{name}</span>
									{name === branch ? <Check size={14} strokeWidth={2} /> : null}
								</button>
							))
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}

function ReviewScopeMenu({
	selection,
	commits,
	commitsLoading,
	reviewLoading,
	onLoadCommits,
	onSelect,
}: {
	selection: ReviewSelection;
	commits: ReviewCommit[];
	commitsLoading: boolean;
	reviewLoading: boolean;
	onLoadCommits: () => void;
	onSelect: (selection: ReviewSelection) => void;
}): ReactNode {
	const menuRef = useRef<HTMLDivElement>(null);
	const commitMenuRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [commitOpen, setCommitOpen] = useState(false);
	const [commitPosition, setCommitPosition] = useState<CommitFlyoutPosition | null>(null);
	const closeMenu = (): void => {
		setOpen(false);
		setCommitOpen(false);
	};
	const select = (next: ReviewSelection): void => {
		closeMenu();
		onSelect(next);
	};
	const toggleCommitMenu = (): void => {
		const nextOpen = !commitOpen;
		setCommitOpen(nextOpen);
		if (!nextOpen) return;

		const anchor = menuRef.current?.getBoundingClientRect();
		if (anchor) {
			const width = Math.min(520, window.innerWidth - 16);
			const preferredLeft = anchor.left - width - 8;
			const fallbackLeft = Math.min(window.innerWidth - width - 8, anchor.right + 8);
			setCommitPosition({
				top: anchor.bottom + 6,
				left: preferredLeft >= 8 ? preferredLeft : Math.max(8, fallbackLeft),
				width,
			});
		}
		onLoadCommits();
	};
	const options: Array<{ label: string; selection?: ReviewSelection }> = [
		{ label: "Split", selection: { scope: "all", label: "Split" } },
		{ label: "Unstaged", selection: { scope: "unstaged", label: "Unstaged" } },
		{ label: "Staged", selection: { scope: "staged", label: "Staged" } },
		{ label: "Commit" },
		{ label: "Branch", selection: { scope: "branch", label: "Branch" } },
		{ label: "Last Turn" },
	];
	const isActiveScope = (scope: ReviewScope | undefined): boolean =>
		scope === selection.scope || (selection.scope === "all" && scope === "all");
	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent): void => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			if (event.target instanceof Node && commitMenuRef.current?.contains(event.target)) return;
			closeMenu();
		};
		const handleEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") closeMenu();
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [open]);
	return (
		<div ref={menuRef} className={`changes-scope-selector${open ? " changes-scope-selector--open" : ""}`}>
			<button
				type="button"
				className="changes-scope-button"
				aria-label="Review scope"
				aria-expanded={open}
				onClick={() => {
					if (open) closeMenu();
					else setOpen(true);
				}}
			>
				<span>{selection.label}</span>
				<ChevronDown size={14} strokeWidth={1.9} />
			</button>
			{open ? (
				<div className="changes-scope-menu">
					{options.map(option => (
						<button
							key={option.label}
							type="button"
							className={
								isActiveScope(option.selection?.scope) || (option.label === "Commit" && commitOpen)
									? "changes-scope-option changes-scope-option--active"
									: "changes-scope-option"
							}
							disabled={reviewLoading || option.label === "Last Turn"}
							title={option.label === "Last Turn" ? "Requires a per-turn workspace checkpoint" : undefined}
							onClick={() => {
								if (option.label === "Commit") {
									toggleCommitMenu();
									return;
								}
								if (option.selection) select(option.selection);
							}}
						>
							<span>{option.label}</span>
							{isActiveScope(option.selection?.scope) ? (
								<Check size={14} strokeWidth={2} />
							) : option.label === "Commit" ? (
								<ChevronRight size={14} />
							) : null}
						</button>
					))}
					{commitOpen && commitPosition
						? createPortal(
								<div
									ref={commitMenuRef}
									className="changes-recent-commits"
									style={{ top: commitPosition.top, left: commitPosition.left, width: commitPosition.width }}
								>
									{commitsLoading ? (
										<div className="changes-commit-empty">Loading commits…</div>
									) : commits.length === 0 ? (
										<div className="changes-commit-empty">No commits found.</div>
									) : (
										commits.map(commit => (
											<button
												key={commit.hash}
												type="button"
												className="changes-commit-option"
												title={`${commit.subject} (${commit.hash})`}
												onClick={() => select({ scope: "commit", ref: commit.hash, label: commit.subject })}
											>
												<span>{commit.subject}</span>
												<time dateTime={new Date(commit.committedAt).toISOString()}>
													{relativeCommitTime(commit.committedAt)}
												</time>
											</button>
										))
									)}
								</div>,
								document.body,
							)
						: null}
				</div>
			) : null}
		</div>
	);
}

function JumpToFileMenu({
	changes,
	activePath,
	filter,
	onFilterChange,
	onSelect,
}: {
	changes: WorkspaceFileChange[];
	activePath: string | null;
	filter: string;
	onFilterChange: (value: string) => void;
	onSelect: (path: string) => void;
}): ReactNode {
	const normalizedFilter = filter.trim().toLowerCase();
	const matches = useMemo(
		() =>
			normalizedFilter ? changes.filter(change => change.path.toLowerCase().includes(normalizedFilter)) : changes,
		[changes, normalizedFilter],
	);
	const selectFirst = (): void => {
		const first = matches[0];
		if (first) onSelect(first.path);
	};
	return (
		<div className="review-jump-menu">
			<label className="review-jump-search">
				<Search size={16} strokeWidth={1.8} />
				<input
					autoFocus
					value={filter}
					onChange={event => onFilterChange(event.currentTarget.value)}
					onKeyDown={event => {
						if (event.key === "Enter") selectFirst();
					}}
					placeholder="Jump to file"
				/>
			</label>
			<div className="review-jump-list">
				{matches.length === 0 ? (
					<div className="review-jump-empty">No matching files.</div>
				) : (
					matches.map(change => {
						const { dir, name } = splitPath(change.path);
						return (
							<button
								key={change.path}
								type="button"
								className={`review-jump-item${activePath === change.path ? " review-jump-item--active" : ""}`}
								onClick={() => onSelect(change.path)}
							>
								<span className="review-jump-name">{name}</span>
								{dir ? <span className="review-jump-dir">{dir.slice(0, -1)}</span> : null}
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}

export function ChangesPanel({
	changes,
	workspaceEntries,
	workspaceFilesLoading,
	workspaceFilesTruncated,
	onRefreshWorkspaceFiles,
	gitStatus,
	onRefresh,
	onLoadReview,
	onLoadReviewCommits,
	onStageHunks,
	onUnstage,
	onRevertFiles,
	onCommit,
	onPush,
	onCreatePullRequest,
	disabled,
}: ChangesPanelProps) {
	const [mode, setMode] = useState<DiffMode>("split");
	const [menuOpen, setMenuOpen] = useState(false);
	const [jumpOpen, setJumpOpen] = useState(false);
	const [navigatorOpen, setNavigatorOpen] = useState(false);
	const [navigatorFilter, setNavigatorFilter] = useState("");
	const [jumpFilter, setJumpFilter] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(() => new Set());
	const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
	const [mutating, setMutating] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [reviewSelection, setReviewSelection] = useState<ReviewSelection>({ scope: "all", label: "Split" });
	const [reviewChanges, setReviewChanges] = useState<WorkspaceFileChange[] | null>(null);
	const [splitUnstagedChanges, setSplitUnstagedChanges] = useState<WorkspaceFileChange[] | null>(null);
	const [splitStagedChanges, setSplitStagedChanges] = useState<WorkspaceFileChange[] | null>(null);
	const [splitLoading, setSplitLoading] = useState(true);
	const [splitError, setSplitError] = useState<string | null>(null);
	const [reviewLoading, setReviewLoading] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [recentCommits, setRecentCommits] = useState<ReviewCommit[]>([]);
	const [commitsLoading, setCommitsLoading] = useState(false);
	const jumpMenuRef = useRef<HTMLDivElement>(null);
	const splitView = reviewSelection.scope === "all";
	const summaryChanges = splitView ? changes : (reviewChanges ?? changes);
	const additions = summaryChanges.reduce((sum, change) => sum + change.additions, 0);
	const deletions = summaryChanges.reduce((sum, change) => sum + change.deletions, 0);
	const normalizedNavigatorFilter = navigatorFilter.trim().toLowerCase();
	const renderedItems = useMemo(() => {
		if (splitView) {
			return [
				...(splitUnstagedChanges ?? []).map(change => ({ scope: "unstaged" as const, change })),
				...(splitStagedChanges ?? []).map(change => ({ scope: "staged" as const, change })),
			];
		}
		const scope = reviewSelection.scope;
		return (reviewChanges ?? changes).map(change => ({ scope, change }));
	}, [changes, reviewChanges, reviewSelection.scope, splitStagedChanges, splitUnstagedChanges, splitView]);
	const visibleItems = useMemo(
		() => renderedItems.filter(item => !hiddenPaths.has(sectionStateKey(item.scope, item.change.path))),
		[hiddenPaths, renderedItems],
	);
	const visibleChanges = useMemo(() => visibleItems.map(item => item.change), [visibleItems]);
	const revertibleChanges = useMemo(
		() => visibleChanges.filter(change => change.status !== "untracked"),
		[visibleChanges],
	);
	const navigatorEntries = useMemo(
		() =>
			normalizedNavigatorFilter
				? workspaceEntries.filter(entry => entry.path.toLowerCase().includes(normalizedNavigatorFilter))
				: workspaceEntries,
		[workspaceEntries, normalizedNavigatorFilter],
	);
	const navigatorChanges = useMemo(
		() =>
			normalizedNavigatorFilter
				? visibleChanges.filter(change => change.path.toLowerCase().includes(normalizedNavigatorFilter))
				: visibleChanges,
		[normalizedNavigatorFilter, visibleChanges],
	);
	const fileTree = useMemo(
		() => buildFileTree(navigatorEntries, navigatorChanges),
		[navigatorEntries, navigatorChanges],
	);
	const activePath =
		selectedPath && visibleChanges.some(change => change.path === selectedPath)
			? selectedPath
			: (visibleChanges[0]?.path ?? null);
	const reviewReadOnly =
		reviewSelection.scope === "commit" || reviewSelection.scope === "branch" || reviewSelection.scope === "last_turn";
	const loadDefaultSplit = useCallback(async (): Promise<void> => {
		setSplitLoading(true);
		setSplitError(null);
		try {
			const [unstaged, staged] = await Promise.all([onLoadReview("unstaged"), onLoadReview("staged")]);
			setSplitUnstagedChanges(unstaged);
			setSplitStagedChanges(staged);
			setSelectedPath(null);
		} catch (error) {
			setSplitError(error instanceof Error ? error.message : String(error));
		} finally {
			setSplitLoading(false);
		}
	}, [onLoadReview]);
	const loadSelection = useCallback(
		async (next: ReviewSelection): Promise<void> => {
			const effective =
				next.scope === "branch" && !next.ref
					? { ...next, ref: gitStatus.baseBranch ?? gitStatus.upstream ?? gitStatus.branch ?? undefined }
					: next;
			if (effective.scope === "branch" && !effective.ref) {
				setReviewError("No base branch is configured for this repository.");
				return;
			}
			setReviewSelection(effective);
			if (effective.scope === "all") {
				await loadDefaultSplit();
				return;
			}
			setReviewLoading(true);
			setReviewError(null);
			try {
				setReviewChanges(await onLoadReview(effective.scope, effective.ref));
				setHiddenPaths(new Set());
				setCollapsedPaths(new Set());
				setExpandedPaths(new Set());
				setSelectedPath(null);
			} catch (error) {
				setReviewError(error instanceof Error ? error.message : String(error));
			} finally {
				setReviewLoading(false);
			}
		},
		[gitStatus.baseBranch, gitStatus.branch, gitStatus.upstream, loadDefaultSplit, onLoadReview],
	);
	const loadCommits = useCallback(async (): Promise<void> => {
		if (commitsLoading) return;
		setCommitsLoading(true);
		setReviewError(null);
		try {
			setRecentCommits(await onLoadReviewCommits());
		} catch (error) {
			setReviewError(error instanceof Error ? error.message : String(error));
		} finally {
			setCommitsLoading(false);
		}
	}, [commitsLoading, onLoadReviewCommits]);

	const splitUnstagedVisibleItems = visibleItems.filter(item => item.scope === "unstaged");
	const splitStagedVisibleItems = visibleItems.filter(item => item.scope === "staged");

	useEffect(() => {
		if (!splitView) return;
		void loadDefaultSplit();
	}, [changes, loadDefaultSplit, splitView]);
	useEffect(() => {
		const paths = new Set(renderedItems.map(item => sectionStateKey(item.scope, item.change.path)));
		setHiddenPaths(previous => new Set([...previous].filter(path => paths.has(path))));
		setCollapsedPaths(previous => new Set([...previous].filter(path => paths.has(path))));
		setExpandedPaths(previous => new Set([...previous].filter(path => paths.has(path))));
	}, [renderedItems]);
	useEffect(() => {
		if (!jumpOpen) return;
		const handlePointerDown = (event: PointerEvent): void => {
			if (event.target instanceof Node && jumpMenuRef.current?.contains(event.target)) return;
			setJumpOpen(false);
		};
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setJumpOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [jumpOpen]);
	const isCollapsed = (scopeKey: string, change: WorkspaceFileChange): boolean => {
		const key = sectionStateKey(scopeKey, change.path);
		return shouldAutoCollapse(change) ? !expandedPaths.has(key) : collapsedPaths.has(key);
	};
	const allDiffsCollapsed =
		visibleItems.length > 0 && visibleItems.every(item => isCollapsed(item.scope, item.change));
	const toggleCollapsed = useCallback((scopeKey: string, path: string, autoCollapsed: boolean): void => {
		const key = sectionStateKey(scopeKey, path);
		if (autoCollapsed) {
			setExpandedPaths(previous => {
				const next = new Set(previous);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				return next;
			});
			return;
		}
		setCollapsedPaths(previous => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const collapseAll = (): void => {
		setCollapsedPaths(new Set(renderedItems.map(item => sectionStateKey(item.scope, item.change.path))));
		setExpandedPaths(new Set());
		setMenuOpen(false);
	};
	const expandAll = (): void => {
		setCollapsedPaths(new Set());
		setExpandedPaths(
			new Set(
				renderedItems
					.filter(item => shouldAutoCollapse(item.change))
					.map(item => sectionStateKey(item.scope, item.change.path)),
			),
		);
		setMenuOpen(false);
	};
	const toggleAllDiffs = (): void => {
		if (allDiffsCollapsed) expandAll();
		else collapseAll();
	};
	const showAll = (): void => {
		setHiddenPaths(new Set());
		setMenuOpen(false);
	};
	const preferredJumpScope = splitView ? "unstaged" : reviewSelection.scope;
	const selectFile = useCallback(
		(path: string): void => {
			setSelectedPath(path);
			requestAnimationFrame(() => jumpToFile(preferredJumpScope, path));
		},
		[preferredJumpScope],
	);
	const selectJumpFile = useCallback(
		(path: string): void => {
			selectFile(path);
			setJumpOpen(false);
			setJumpFilter("");
		},
		[selectFile],
	);
	const runMutation = useCallback(
		(action: () => void): void => {
			if (disabled || mutating) return;
			setMutating(true);
			Promise.resolve()
				.then(action)
				.finally(() => setMutating(false));
		},
		[disabled, mutating],
	);
	const stageFile = useCallback(
		(path: string): void => {
			runMutation(() => onStageHunks([{ path, hunks: { type: "all" } }]));
		},
		[onStageHunks, runMutation],
	);
	const unstageFile = useCallback(
		(path: string): void => {
			runMutation(() => onUnstage([path]));
		},
		[onUnstage, runMutation],
	);
	const stageAll = useCallback(
		(changes: WorkspaceFileChange[]): void => {
			if (changes.length === 0) return;
			runMutation(() => onStageHunks(stageSelectionsForChanges(changes)));
		},
		[onStageHunks, runMutation],
	);
	const unstageAll = useCallback(
		(changes: WorkspaceFileChange[]): void => {
			if (changes.length === 0) return;
			runMutation(() => onUnstage(changes.map(change => change.path)));
		},
		[onUnstage, runMutation],
	);
	const refresh = useCallback((): void => {
		if (refreshing) return;
		setRefreshing(true);
		Promise.resolve()
			.then(() => {
				if (reviewSelection.scope === "all") {
					setSplitLoading(true);
					onRefresh();
					return;
				}
				return loadSelection(reviewSelection);
			})
			.finally(() => setRefreshing(false));
	}, [loadSelection, onRefresh, refreshing, reviewSelection]);

	const splitUnstagedVisibleChanges = splitUnstagedVisibleItems.map(item => item.change);
	const splitStagedVisibleChanges = splitStagedVisibleItems.map(item => item.change);
	const sectionVisibleItems = splitView
		? [
				{ scope: "unstaged" as const, title: "Unstaged", changes: splitUnstagedVisibleChanges },
				{ scope: "staged" as const, title: "Staged", changes: splitStagedVisibleChanges },
			]
		: [
				{
					scope: reviewSelection.scope,
					title: reviewSelection.label,
					changes: visibleChanges,
				},
			];

	return (
		<section
			className={`changes-panel${navigatorOpen ? " changes-panel--with-navigator" : ""}`}
			aria-busy={mutating || refreshing || reviewLoading || splitLoading}
		>
			<div className="changes-head">
				<div className="changes-overview">
					<div className="changes-summary">
						<ReviewScopeMenu
							selection={reviewSelection}
							commits={recentCommits}
							commitsLoading={commitsLoading}
							reviewLoading={reviewLoading || splitLoading}
							onLoadCommits={loadCommits}
							onSelect={selection => void loadSelection(selection)}
						/>
						<span className="changes-total changes-total--add">+{additions.toLocaleString()}</span>
						<span className="changes-total changes-total--del">-{deletions.toLocaleString()}</span>
					</div>
					<div className="changes-branch-context" aria-label="Branch tracking">
						<span>{gitStatus.branch ?? "Detached HEAD"}</span>
						<ArrowRight size={13} strokeWidth={1.8} />
						<BranchSelector
							branch={
								reviewSelection.scope === "branch"
									? (reviewSelection.ref ?? gitStatus.baseBranch)
									: gitStatus.baseBranch
							}
							branches={gitStatus.localBranches.filter(branch => branch !== gitStatus.branch)}
							loading={reviewLoading || splitLoading}
							onSelect={branch => void loadSelection({ scope: "branch", ref: branch, label: "Branch" })}
						/>
					</div>
					{hiddenPaths.size > 0 ? (
						<button type="button" className="changes-hidden-pill" onClick={showAll}>
							{hiddenPaths.size} hidden / show
						</button>
					) : null}
				</div>
				<div className="changes-actions">
					<div className="review-menu-anchor">
						<button
							type="button"
							className="changes-icon-button"
							title="Review options"
							aria-label="Review options"
							onClick={() => {
								setJumpOpen(false);
								setMenuOpen(open => !open);
							}}
						>
							<MoreHorizontal size={17} strokeWidth={1.8} />
						</button>
						{menuOpen ? (
							<ReviewOptions
								hiddenCount={hiddenPaths.size}
								revertDisabled={disabled || mutating || reviewReadOnly || revertibleChanges.length === 0}
								refreshDisabled={refreshing || reviewLoading || splitLoading}
								onShowAll={showAll}
								onRefresh={() => {
									refresh();
									setMenuOpen(false);
								}}
								onRevertAll={() => {
									runMutation(() => onRevertFiles(revertibleChanges.map(change => change.path)));
									setMenuOpen(false);
								}}
								showUnstageAll={false}
								onUnstageAll={() => {}}
								showStageAll={false}
								onStageAll={() => {}}
							/>
						) : null}
					</div>
					<button
						type="button"
						className="changes-icon-button"
						title={allDiffsCollapsed ? "Expand all diffs" : "Collapse all diffs"}
						aria-label={allDiffsCollapsed ? "Expand all diffs" : "Collapse all diffs"}
						onClick={toggleAllDiffs}
					>
						<ListCollapse size={16} strokeWidth={1.8} />
					</button>
					<div className="review-jump-anchor" ref={jumpMenuRef}>
						<button
							type="button"
							className={`changes-icon-button${jumpOpen ? " changes-icon-button--active" : ""}`}
							title="Jump to file"
							aria-label="Jump to file"
							onClick={() => {
								setMenuOpen(false);
								setJumpOpen(open => !open);
							}}
						>
							<FileSearch size={16} strokeWidth={1.8} />
						</button>
						{jumpOpen ? (
							<JumpToFileMenu
								changes={visibleChanges}
								activePath={activePath}
								filter={jumpFilter}
								onFilterChange={setJumpFilter}
								onSelect={selectJumpFile}
							/>
						) : null}
					</div>
					<button
						type="button"
						className={`changes-icon-button${mode === "split" ? " changes-icon-button--active" : ""}`}
						title={mode === "split" ? "Switch to unified diff" : "Switch to split diff"}
						aria-label={mode === "split" ? "Switch to unified diff" : "Switch to split diff"}
						onClick={() => setMode(current => (current === "split" ? "unified" : "split"))}
					>
						<SquareSplitHorizontal size={16} strokeWidth={1.8} />
					</button>
					<button
						type="button"
						className={`changes-icon-button${navigatorOpen ? " changes-icon-button--active" : ""}`}
						title={navigatorOpen ? "Hide files" : "Show files"}
						aria-label={navigatorOpen ? "Hide files" : "Show files"}
						onClick={() => {
							setJumpOpen(false);
							if (!navigatorOpen && workspaceEntries.length === 0) onRefreshWorkspaceFiles();
							setNavigatorOpen(open => !open);
						}}
					>
						<FolderOpen size={16} strokeWidth={1.8} />
					</button>
					<span className="changes-action-divider" />
					<CommitOrPushControl
						disabled={disabled || mutating}
						commitDisabled={gitStatus.staged === 0}
						pushDisabled={!gitStatus.branch}
						prDisabled={!gitStatus.branch}
						onCommit={onCommit}
						onPush={onPush}
						onCreatePullRequest={onCreatePullRequest}
					/>
				</div>
			</div>
			<div className="review-workspace">
				<div className="changes-list">
					{splitView ? (
						<>
							{splitLoading && splitUnstagedChanges === null && splitStagedChanges === null ? (
								<div className="changes-review-state">Loading staged and unstaged diffs…</div>
							) : null}
							{splitError ? (
								<div className="changes-review-state changes-review-state--error">{splitError}</div>
							) : null}
							{sectionVisibleItems.map(section => (
								<ChangeSection
									key={section.scope}
									title={section.title}
									scopeKey={section.scope}
									changes={section.changes}
									mode={mode}
									disabled={disabled || mutating}
									allActionLabel={section.scope === "unstaged" ? "Stage all" : "Unstage all"}
									allActionDisabled={disabled || mutating || reviewReadOnly || section.changes.length === 0}
									onAllAction={() => {
										if (section.scope === "unstaged") stageAll(section.changes);
										else unstageAll(section.changes);
									}}
									rowAction={section.scope === "unstaged" ? "stage" : "unstage"}
									onRowAction={section.scope === "unstaged" ? stageFile : unstageFile}
									isCollapsed={isCollapsed}
									onToggleCollapsed={toggleCollapsed}
									onSelect={selectFile}
									emptyMessage={section.scope === "unstaged" ? "No unstaged changes." : "No staged changes."}
								/>
							))}
						</>
					) : (
						<>
							{reviewLoading && reviewChanges === null ? (
								<div className="changes-review-state">Loading {reviewSelection.label} diff…</div>
							) : null}
							{reviewError ? (
								<div className="changes-review-state changes-review-state--error">{reviewError}</div>
							) : null}
							{sectionVisibleItems.length === 0 ? (
								<p className="changes-empty">
									{visibleChanges.length === 0
										? `No changes in ${reviewSelection.label}.`
										: "No files to show."}
								</p>
							) : (
								sectionVisibleItems.map(section => (
									<ChangeSection
										key={section.scope}
										title={section.title}
										scopeKey={section.scope}
										changes={section.changes}
										mode={mode}
										disabled={disabled || mutating || reviewReadOnly}
										allActionLabel={
											section.scope === "unstaged"
												? "Stage all"
												: section.scope === "staged"
													? "Unstage all"
													: undefined
										}
										allActionDisabled={disabled || mutating || reviewReadOnly || section.changes.length === 0}
										onAllAction={
											section.scope === "unstaged"
												? () => stageAll(section.changes)
												: section.scope === "staged"
													? () => unstageAll(section.changes)
													: undefined
										}
										rowAction={
											section.scope === "unstaged" ? "stage" : section.scope === "staged" ? "unstage" : null
										}
										onRowAction={
											section.scope === "unstaged"
												? stageFile
												: section.scope === "staged"
													? unstageFile
													: stageFile
										}
										isCollapsed={isCollapsed}
										onToggleCollapsed={toggleCollapsed}
										onSelect={selectFile}
										emptyMessage={`No files in ${section.title}.`}
									/>
								))
							)}
						</>
					)}
				</div>
				{navigatorOpen ? (
					<aside className="review-file-navigator">
						<div className="review-filter">
							<Search size={16} />
							<input
								value={navigatorFilter}
								onChange={event => setNavigatorFilter(event.currentTarget.value)}
								placeholder="Filter files..."
							/>
						</div>
						{workspaceFilesTruncated ? (
							<div className="review-tree-warning">Workspace tree reached the safety limit.</div>
						) : null}
						{workspaceFilesLoading && fileTree.length === 0 ? (
							<div className="review-tree-empty">Loading files…</div>
						) : fileTree.length === 0 ? (
							<div className="review-tree-empty">No files to show.</div>
						) : (
							<FileTree
								nodes={fileTree}
								activePath={activePath}
								onJump={path => {
									selectFile(path);
								}}
							/>
						)}
					</aside>
				) : null}
			</div>
		</section>
	);
}
