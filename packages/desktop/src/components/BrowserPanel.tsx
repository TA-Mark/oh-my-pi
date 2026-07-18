import { ArrowLeft, ArrowRight, ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { BrowserTab } from "../lib/rpc-protocol";

export interface BrowserActivity {
	id: string;
	label: string;
	status: "running" | "done" | "error";
	timestamp: number;
}

interface BrowserPanelProps {
	url: string;
	snapshot: string;
	busy: boolean;
	tabs: BrowserTab[];
	activeTab: string;
	activity: BrowserActivity[];
	downloadPolicy: "deny";
	onOpen: (url: string) => void;
	onNewTab: () => void;
	onSelectTab: (tab: BrowserTab) => void;
	onCloseTab: (name: string) => void;
	onRefreshTabs: () => void;
	onHistory: (direction: "back" | "forward" | "reload") => void;
	onSnapshot: () => void;
	onAddContext: () => void;
	onExternal: (url: string) => void;
}

export function BrowserPanel({
	url,
	snapshot,
	busy,
	tabs,
	activeTab,
	activity,
	downloadPolicy,
	onOpen,
	onNewTab,
	onSelectTab,
	onCloseTab,
	onRefreshTabs,
	onHistory,
	onSnapshot,
	onAddContext,
	onExternal,
}: BrowserPanelProps) {
	const [address, setAddress] = useState(url);
	useEffect(() => setAddress(url), [url]);
	return (
		<div className="browser-panel">
			<div className="browser-tabs" aria-label="Browser tabs">
				{tabs.map(tab => (
					<button
						type="button"
						key={tab.name}
						className={tab.name === activeTab ? "browser-tab browser-tab--active" : "browser-tab"}
						onClick={() => onSelectTab(tab)}
					>
						<span>{tab.title || tab.name}</span>
						<X
							size={12}
							onClick={event => {
								event.stopPropagation();
								onCloseTab(tab.name);
							}}
						/>
					</button>
				))}
				<button type="button" onClick={onNewTab} aria-label="New browser tab">
					<Plus size={13} />
				</button>
				<button type="button" onClick={onRefreshTabs} aria-label="Refresh browser tabs">
					<RefreshCw size={13} />
				</button>
			</div>
			<form
				className="browser-toolbar"
				onSubmit={event => {
					event.preventDefault();
					onOpen(address);
				}}
			>
				<button type="button" disabled={busy || !url} onClick={() => onHistory("back")}>
					<ArrowLeft size={14} />
				</button>
				<button type="button" disabled={busy || !url} onClick={() => onHistory("forward")}>
					<ArrowRight size={14} />
				</button>
				<button type="button" disabled={busy || !url} onClick={() => onHistory("reload")}>
					<RefreshCw size={14} />
				</button>
				<input
					value={address}
					onChange={event => setAddress(event.currentTarget.value)}
					placeholder="https://example.com"
				/>
				<button type="submit" disabled={busy || !address.trim()}>
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
			<section className="browser-activity">
				<header>
					<strong>Activity</strong>
					<span>Download policy from core: {downloadPolicy}.</span>
				</header>
				{activity.length ? (
					activity.slice(-12).map(item => (
						<div className="browser-activity-row" key={item.id}>
							<span className={`browser-activity-status browser-activity-status--${item.status}`} />
							<strong>{item.label}</strong>
							<time>{new Date(item.timestamp).toLocaleTimeString()}</time>
						</div>
					))
				) : (
					<p>No browser activity in this task.</p>
				)}
			</section>
		</div>
	);
}
