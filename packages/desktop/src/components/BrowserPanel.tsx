import { ArrowLeft, ArrowRight, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

interface BrowserPanelProps {
	url: string;
	snapshot: string;
	busy: boolean;
	onOpen: (url: string) => void;
	onHistory: (direction: "back" | "forward" | "reload") => void;
	onSnapshot: () => void;
	onAddContext: () => void;
	onExternal: (url: string) => void;
}

export function BrowserPanel({
	url,
	snapshot,
	busy,
	onOpen,
	onHistory,
	onSnapshot,
	onAddContext,
	onExternal,
}: BrowserPanelProps) {
	const [address, setAddress] = useState(url);
	return (
		<div className="browser-panel">
			<form
				className="browser-toolbar"
				onSubmit={event => {
					event.preventDefault();
					onOpen(address);
				}}
			>
				<button type="button" disabled={busy} onClick={() => onHistory("back")}>
					<ArrowLeft size={14} />
				</button>
				<button type="button" disabled={busy} onClick={() => onHistory("forward")}>
					<ArrowRight size={14} />
				</button>
				<button type="button" disabled={busy} onClick={() => onHistory("reload")}>
					<RefreshCw size={14} />
				</button>
				<input
					value={address}
					onChange={event => setAddress(event.currentTarget.value)}
					placeholder="https://example.com"
				/>
				<button type="submit" disabled={busy}>
					Go
				</button>
				<button type="button" disabled={!url} onClick={() => onExternal(url)}>
					<ExternalLink size={14} />
				</button>
			</form>
			<div className="browser-snapshot-actions">
				<button type="button" disabled={busy || !url} onClick={onSnapshot}>
					Refresh snapshot
				</button>
				<button type="button" disabled={!snapshot} onClick={onAddContext}>
					<Plus size={14} /> Add snapshot to context
				</button>
			</div>
			<pre className="browser-snapshot">
				{snapshot || "Open an https URL to inspect its accessibility snapshot."}
			</pre>
		</div>
	);
}
