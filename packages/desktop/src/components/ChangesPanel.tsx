import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	ExternalLink,
	FileSearch,
	FolderOpen,
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WorkspaceFileChange } from "../lib/rpc-protocol";

interface ChangesPanelProps {
	changes: WorkspaceFileChange[];
	onRefresh: () => void;
	disabled: boolean;
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
	children: FileTreeNode[];
	change?: WorkspaceFileChange;
}

interface FileTreeDraft {
	name: string;
	path: string;
	children: Map<string, FileTreeDraft>;
	change?: WorkspaceFileChange;
}

const DIFF_ROW_HEIGHT = 27;
const HUNK_GAP_HEIGHT = 40;
const DIFF_OVERSCAN_PX = 900;
const INITIAL_DIFF_RENDER_HEIGHT = 1400;

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	return { dir, name };
}

function fileDomId(path: string): string {
	return `review-file-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function jumpToFile(path: string): void {
	document.getElementById(fileDomId(path))?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function fileExtension(path: string): string {
	const name = splitPath(path).name;
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).slice(0, 2).toUpperCase() : "F";
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

function compareChanges(left: WorkspaceFileChange, right: WorkspaceFileChange): number {
	return left.path.localeCompare(right.path);
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

function buildFileTree(changes: WorkspaceFileChange[]): FileTreeNode[] {
	const root: FileTreeDraft = { name: "", path: "", children: new Map() };
	for (const change of changes) {
		const parts = change.path.split("/").filter(Boolean);
		let node = root;
		let path = "";
		for (const part of parts) {
			path = path ? `${path}/${part}` : part;
			const existing = node.children.get(part);
			if (existing) {
				node = existing;
				continue;
			}
			const next: FileTreeDraft = { name: part, path, children: new Map() };
			node.children.set(part, next);
			node = next;
		}
		node.change = change;
	}
	const toNode = (draft: FileTreeDraft): FileTreeNode => ({
		name: draft.name,
		path: draft.path,
		change: draft.change,
		children: Array.from(draft.children.values())
			.sort((left, right) => {
				if (left.change && !right.change) return 1;
				if (!left.change && right.change) return -1;
				return left.name.localeCompare(right.name);
			})
			.map(toNode),
	});
	const compactNode = (node: FileTreeNode): FileTreeNode => {
		let current = node;
		while (!current.change && current.children.length === 1 && !current.children[0]?.change) {
			const child = current.children[0];
			current = { name: `${current.name}/${child.name}`, path: child.path, children: child.children };
		}
		return { ...current, children: current.children.map(compactNode) };
	};

	return Array.from(root.children.values()).sort((left, right) => left.name.localeCompare(right.name)).map(toNode).map(compactNode);
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
	const [range, setRange] = useState<DiffRenderRange>(() => visibleRangeFromOffsets(buildItemOffsets(items), 0, INITIAL_DIFF_RENDER_HEIGHT));
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
			previous.start === nextRange.start && previous.end === nextRange.end && previous.top === nextRange.top && previous.bottom === nextRange.bottom
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
	if (change.truncated) return <div className="changes-note">Diff omitted because this file is binary or too large.</div>;
	if (!change.diff || hunks.length === 0) return <div className="changes-note">No textual diff available.</div>;
	return (
		<div className={`review-diff review-diff--${mode}`}>
			<VirtualizedDiffRows items={items} mode={mode} />
		</div>
	);
}

function FileActions({
	change,
}: {
	change: WorkspaceFileChange;
}): ReactNode {
	return (
		<span className="changes-file-actions">
			<span className="changes-total changes-total--add">+{change.additions.toLocaleString()}</span>
			<span className="changes-total changes-total--del">-{change.deletions.toLocaleString()}</span>
			<button type="button" className="changes-icon-button changes-icon-button--compact" title="Revert file" disabled>
				<Undo2 size={15} />
			</button>
			<button type="button" className="changes-icon-button changes-icon-button--compact" title="Stage file" disabled>
				<Plus size={15} />
			</button>
			<button type="button" className="changes-icon-button changes-icon-button--compact" title="Jump to file" onClick={() => jumpToFile(change.path)}>
				<ExternalLink size={15} />
			</button>
		</span>
	);
}

function FileChangeSection({
	change,
	mode,
	collapsed,
	onToggleCollapsed,
	onSelect,
}: {
	change: WorkspaceFileChange;
	mode: DiffMode;
	collapsed: boolean;
	onToggleCollapsed: (path: string, autoCollapsed: boolean) => void;
	onSelect: (path: string) => void;
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
		<section ref={sectionRef} id={fileDomId(change.path)} className={`changes-file${collapsed ? " changes-file--collapsed" : ""}`}>
			<div className="changes-file-head">
				<button
					type="button"
					className="changes-file-title"
					onClick={() => {
						onSelect(change.path);
						onToggleCollapsed(change.path, autoCollapsed);
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
					<FileActions change={change} />
				</span>
			</div>
			{!collapsed && isDiffNearViewport ? <DiffView change={change} mode={mode} /> : null}
		</section>
	);
}

const MemoizedFileChangeSection = memo(FileChangeSection);

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
			{nodes.map(node =>
				node.change ? (
					<button
						key={node.path}
						type="button"
						className={`review-tree-file${activePath === node.path ? " review-tree-file--active" : ""}`}
						style={{ paddingLeft: 14 + depth * 20 }}
						onClick={() => onJump(node.change?.path ?? node.path)}
					>
						<FileKind path={node.path} />
						<span>{node.name}</span>
					</button>
				) : (
					<div key={node.path} className="review-tree-dir">
						<div className="review-tree-dir-label" style={{ paddingLeft: 12 + depth * 20 }}>
							<ChevronDown size={15} />
							<span>{node.name}</span>
						</div>
						<FileTree nodes={node.children} activePath={activePath} onJump={onJump} depth={depth + 1} />
					</div>
				),
			)}
		</div>
	);
}

function ReviewOptions({
	hiddenCount,
	onShowAll,
	onRefresh,
}: {
	hiddenCount: number;
	onShowAll: () => void;
	onRefresh: () => void;
}): ReactNode {
	return (
		<div className="review-options-menu">
			<button type="button" onClick={onRefresh}>
				<RefreshCw size={14} />
				Refresh
			</button>
			<button type="button" onClick={onShowAll} disabled={hiddenCount === 0}>
				<PanelRightOpen size={14} />
				Show hidden files{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
			</button>
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
		() => (normalizedFilter ? changes.filter(change => change.path.toLowerCase().includes(normalizedFilter)) : changes),
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

export function ChangesPanel({ changes, onRefresh, disabled }: ChangesPanelProps) {
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
	const jumpMenuRef = useRef<HTMLDivElement>(null);
	const additions = changes.reduce((sum, change) => sum + change.additions, 0);
	const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
	const normalizedNavigatorFilter = navigatorFilter.trim().toLowerCase();
	const orderedChanges = useMemo(() => [...changes].sort(compareChanges), [changes]);
	const visibleChanges = useMemo(
		() => orderedChanges.filter(change => !hiddenPaths.has(change.path)),
		[orderedChanges, hiddenPaths],
	);
	const navigatorChanges = useMemo(
		() => (normalizedNavigatorFilter ? visibleChanges.filter(change => change.path.toLowerCase().includes(normalizedNavigatorFilter)) : visibleChanges),
		[visibleChanges, normalizedNavigatorFilter],
	);
	const fileTree = useMemo(() => buildFileTree(navigatorChanges), [navigatorChanges]);
	const activePath = selectedPath && visibleChanges.some(change => change.path === selectedPath) ? selectedPath : visibleChanges[0]?.path ?? null;

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

	const isCollapsed = (change: WorkspaceFileChange): boolean => {
		return shouldAutoCollapse(change) ? !expandedPaths.has(change.path) : collapsedPaths.has(change.path);
	};
	const allDiffsCollapsed = visibleChanges.length > 0 && visibleChanges.every(isCollapsed);

	const selectPath = useCallback((path: string): void => {
		setSelectedPath(path);
	}, []);

	const toggleCollapsed = useCallback((path: string, autoCollapsed: boolean): void => {
		if (autoCollapsed) {
			setExpandedPaths(previous => {
				const next = new Set(previous);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				return next;
			});
			return;
		}
		setCollapsedPaths(previous => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const collapseAll = (): void => {
		setCollapsedPaths(new Set(visibleChanges.map(change => change.path)));
		setExpandedPaths(new Set());
		setMenuOpen(false);
	};

	const expandAll = (): void => {
		setCollapsedPaths(new Set());
		setExpandedPaths(new Set(visibleChanges.filter(shouldAutoCollapse).map(change => change.path)));
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

	const selectFile = useCallback((path: string): void => {
		setSelectedPath(path);
		requestAnimationFrame(() => jumpToFile(path));
	}, []);

	const selectJumpFile = useCallback((path: string): void => {
		selectFile(path);
		setJumpOpen(false);
		setJumpFilter("");
	}, [selectFile]);

	return (
		<section className={`changes-panel${navigatorOpen ? " changes-panel--with-navigator" : ""}`}>
			<div className="changes-head">
				<div className="changes-summary">
					<span className="changes-title">Unstaged</span>
					<span className="changes-count">{changes.length}</span>
					<ChevronDown size={15} strokeWidth={1.9} />
					<span className="changes-total changes-total--add">+{additions.toLocaleString()}</span>
					<span className="changes-total changes-total--del">-{deletions.toLocaleString()}</span>
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
								onShowAll={showAll}
								onRefresh={() => {
									onRefresh();
									setMenuOpen(false);
								}}
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
							setNavigatorOpen(open => !open);
						}}
					>
						<FolderOpen size={16} strokeWidth={1.8} />
					</button>
					<span className="changes-action-divider" />
					<button type="button" className="changes-pill-action" disabled={disabled || visibleChanges.length === 0}>
						<GitCommitHorizontal size={15} strokeWidth={1.8} />
						Commit or push
					</button>
					<button type="button" className="changes-pill-action changes-pill-action--disabled" disabled={disabled || visibleChanges.length === 0}>
						<GitPullRequestCreate size={15} strokeWidth={1.8} />
						Create PR
					</button>
				</div>
			</div>
			<div className="review-workspace">
				<div className="changes-list">
					{visibleChanges.length === 0 ? (
						<p className="changes-empty">{changes.length === 0 ? "No changes yet." : "No files to show."}</p>
					) : (
						visibleChanges.map(change => (
							<MemoizedFileChangeSection
								key={change.path}
								change={change}
								mode={mode}
								collapsed={isCollapsed(change)}
								onToggleCollapsed={toggleCollapsed}
								onSelect={selectPath}
							/>
						))
					)}
				</div>
				{navigatorOpen ? (
					<aside className="review-file-navigator">
						<div className="review-filter">
							<Search size={16} />
							<input value={navigatorFilter} onChange={event => setNavigatorFilter(event.currentTarget.value)} placeholder="Filter files..." />
						</div>
						{fileTree.length === 0 ? (
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
			{visibleChanges.length > 0 ? (
				<div className="review-floating-actions">
					<button type="button" disabled>
						<RotateCcw size={15} />
						Revert all
					</button>
					<button type="button" disabled>
						<Plus size={15} />
						Stage all
					</button>
				</div>
			) : null}
		</section>
	);
}
