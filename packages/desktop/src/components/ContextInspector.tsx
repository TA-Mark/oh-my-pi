import { FileCode2, Image, X } from "lucide-react";
import type { ImageContent } from "../lib/rpc-protocol";

export interface StagedContextItem {
	id: string;
	kind: "file" | "selection";
	path: string;
	content?: string;
}

interface ContextInspectorProps {
	items: StagedContextItem[];
	images: ImageContent[];
	skills: string[];
	memoryBackend: string | null;
	skillDetails?: Array<{ name: string; description: string; filePath: string; source: string; hidden?: boolean }>;
	skillWarnings?: Array<{ skillPath: string; message: string }>;
	onRemoveItem: (id: string) => void;
	onRemoveImage: (index: number) => void;
	onClear: () => void;
}

export function estimateContextTokens(items: readonly StagedContextItem[], images: readonly ImageContent[]): number {
	const textCharacters = items.reduce((total, item) => total + (item.content?.length ?? item.path.length + 16), 0);
	return Math.ceil(textCharacters / 4) + images.length * 1024;
}

export function ContextInspector({
	items,
	images,
	skills,
	memoryBackend,
	skillDetails,
	skillWarnings,
	onRemoveItem,
	onRemoveImage,
	onClear,
}: ContextInspectorProps) {
	const tokens = estimateContextTokens(items, images);
	const warning =
		tokens >= 48_000
			? "Context is very large and may require compaction."
			: tokens >= 24_000
				? "Context is getting large."
				: null;
	return (
		<div className="context-inspector">
			<header className="context-inspector-summary">
				<div>
					<strong>{items.length + images.length} items</strong>
					<span>≈ {tokens.toLocaleString()} tokens</span>
				</div>
				<button type="button" disabled={items.length + images.length === 0} onClick={onClear}>
					Clear all
				</button>
			</header>
			{warning ? (
				<div className={tokens >= 48_000 ? "context-warning context-warning--danger" : "context-warning"}>
					{warning}
				</div>
			) : null}
			<section className="context-group">
				<h3>Files and code</h3>
				{items.length === 0 ? (
					<p>No files or code selections staged.</p>
				) : (
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
							<button type="button" aria-label={`Remove ${item.path}`} onClick={() => onRemoveItem(item.id)}>
								<X size={14} />
							</button>
						</div>
					))
				)}
			</section>
			<section className="context-group">
				<h3>Images</h3>
				{images.length === 0 ? (
					<p>No images attached.</p>
				) : (
					images.map((image, index) => (
						<div className="context-item" key={`${image.mimeType}:${index}`}>
							<Image size={15} />
							<div>
								<strong>Image {index + 1}</strong>
								<span>
									{image.mimeType} · {Math.ceil(image.data.length * 0.75).toLocaleString()} bytes
								</span>
							</div>
							<button
								type="button"
								aria-label={`Remove image ${index + 1}`}
								onClick={() => onRemoveImage(index)}
							>
								<X size={14} />
							</button>
						</div>
					))
				)}
			</section>
			<section className="context-group">
				<h3>Memory</h3>
				<p>{memoryBackend ? `Active backend: ${memoryBackend}` : "No memory backend active."}</p>
			</section>
			<section className="context-group">
				<h3>Skills</h3>
				<p>{skills.length > 0 ? skills.join(", ") : "No skills discovered for this workspace."}</p>
				{skillDetails?.length ? (
					<ul className="context-inspector-list">
						{skillDetails.map(skill => (
							<li key={skill.name}>
								<strong>{skill.name}</strong>
								<span>
									{skill.description} Â· {skill.source}
								</span>
							</li>
						))}
					</ul>
				) : null}
				{skillWarnings?.length ? (
					<p className="context-inspector-warning">{skillWarnings.length} skill warning(s) detected.</p>
				) : null}
			</section>
		</div>
	);
}
