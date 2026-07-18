import { FileCode2, Image, X } from "lucide-react";
import type { ContextBreakdown, ContextUsage, ImageContent } from "../lib/rpc-protocol";

export interface StagedContextItem {
	id: string;
	kind: "file" | "selection";
	path: string;
	content?: string;
}
export function estimateContextTokens(items: readonly StagedContextItem[], images: readonly ImageContent[]): number {
	return (
		Math.ceil(items.reduce((total, item) => total + (item.content?.length ?? item.path.length + 16), 0) / 4) +
		images.length * 1024
	);
}

export function composePromptWithContext(text: string, items: readonly StagedContextItem[]): string {
	return [
		text,
		...items.map(item => (item.kind === "file" ? `@${item.path}` : [item.path, item.content ?? ""].join("\n"))),
	]
		.filter(Boolean)
		.join("\n\n");
}

export function describeContextWarning(
	usage: ContextUsage | undefined,
	stagedTokens: number,
): { danger: boolean; message: string } | null {
	if (usage && usage.percent >= 70) {
		return {
			danger: usage.percent >= 90,
			message: `Authoritative model context is ${Math.round(usage.percent)}% full and may require compaction.`,
		};
	}
	if (stagedTokens < 24_000) return null;
	return {
		danger: stagedTokens >= 48_000,
		message: "Staged context is getting large and may require compaction.",
	};
}

export function contextBreakdownRows(
	breakdown: ContextBreakdown | undefined,
): Array<{ label: string; tokens: number }> {
	if (!breakdown) return [];
	return [
		{ label: "System prompt", tokens: breakdown.systemPromptTokens },
		{ label: "Tools", tokens: breakdown.systemToolsTokens },
		{ label: "System context", tokens: breakdown.systemContextTokens },
		{ label: "Skills", tokens: breakdown.skillsTokens },
		{ label: "Messages", tokens: breakdown.messagesTokens },
	];
}
interface ContextInspectorProps {
	items: StagedContextItem[];
	images: ImageContent[];
	skills: string[];
	memoryBackend: string | null;
	usage?: ContextUsage;
	breakdown?: ContextBreakdown;
	onRemoveItem: (id: string) => void;
	onRemoveImage: (index: number) => void;
	onClear: () => void;
}
export function ContextInspector({
	items,
	images,
	skills,
	memoryBackend,
	usage,
	breakdown,
	onRemoveItem,
	onRemoveImage,
	onClear,
}: ContextInspectorProps) {
	const tokens = estimateContextTokens(items, images);
	const warning = describeContextWarning(usage, tokens);
	const breakdownRows = contextBreakdownRows(breakdown);
	return (
		<div className="context-inspector">
			<header className="context-inspector-summary">
				<div>
					<strong>{items.length + images.length} items</strong>
					<span>≈ {tokens.toLocaleString()} tokens</span>
					{usage ? (
						<span>
							Core: {usage.tokens.toLocaleString()} / {usage.contextWindow.toLocaleString()} (
							{Math.round(usage.percent)}%)
						</span>
					) : null}
				</div>
				<button type="button" onClick={onClear} disabled={!items.length && !images.length}>
					Clear all
				</button>
			</header>
			{warning ? (
				<div className={warning.danger ? "context-warning context-warning--danger" : "context-warning"}>
					{warning.message}
				</div>
			) : null}
			{breakdown ? (
				<section className="context-group">
					<h3>Core context breakdown {breakdown.anchored ? "· provider anchored" : "· estimated"}</h3>
					<div className="context-breakdown">
						{breakdownRows.map(row => (
							<div className="context-breakdown-row" key={row.label}>
								<span>{row.label}</span>
								<div>
									<i
										style={{
											width: `${breakdown.usedTokens > 0 ? Math.min(100, (row.tokens / breakdown.usedTokens) * 100) : 0}%`,
										}}
									/>
								</div>
								<strong>{row.tokens.toLocaleString()}</strong>
							</div>
						))}
					</div>
				</section>
			) : null}
			<section className="context-group">
				<h3>Files and code</h3>
				{items.length ? (
					items.map(item => (
						<div className="context-item" key={item.id}>
							<FileCode2 size={15} />
							<div>
								<strong>{item.path}</strong>
								<span>
									{item.kind === "selection"
										? `${item.content?.length ?? 0} selected characters`
										: "File mention"}
								</span>
							</div>
							<button type="button" onClick={() => onRemoveItem(item.id)} aria-label={`Remove ${item.path}`}>
								<X size={14} />
							</button>
						</div>
					))
				) : (
					<p>No files or code selections staged.</p>
				)}
			</section>
			<section className="context-group">
				<h3>Images</h3>
				{images.length ? (
					images.map((image, index) => (
						<div className="context-item" key={`${image.mimeType}:${index}`}>
							<Image size={15} />
							<div>
								<strong>Image {index + 1}</strong>
								<span>{image.mimeType}</span>
							</div>
							<button
								type="button"
								onClick={() => onRemoveImage(index)}
								aria-label={`Remove image ${index + 1}`}
							>
								<X size={14} />
							</button>
						</div>
					))
				) : (
					<p>No images attached.</p>
				)}
			</section>
			<section className="context-group">
				<h3>Memory</h3>
				<p>{memoryBackend ? `Active backend: ${memoryBackend}` : "No memory backend active."}</p>
			</section>
			<section className="context-group">
				<h3>Skills</h3>
				<p>{skills.length ? skills.join(", ") : "No skills discovered for this workspace."}</p>
			</section>
		</div>
	);
}
