import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ChatClient } from "../../../lib/chat-client";
import { getConfigKey, setConfigKey } from "../api/configApi";
import { memoryAction } from "../api/chatApi";

type MemoryBackend = "off" | "local" | "hindsight" | "mnemopi";

interface Props {
	client: ChatClient | null;
	activeSessionId: string | null;
}

const BACKENDS: { id: MemoryBackend; label: string; desc: string }[] = [
	{ id: "off", label: "Off", desc: "Memory disabled" },
	{ id: "local", label: "Local", desc: "File-based memory_summary.md" },
	{ id: "hindsight", label: "Hindsight", desc: "Auto-summarise after each turn" },
	{ id: "mnemopi", label: "Mnemopi", desc: "Cloud-backed semantic memory" },
];

export function MemoryPanel({ client, activeSessionId }: Props): ReactNode {
	const [backend, setBackend] = useState<MemoryBackend | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getConfigKey("memory.backend")
			.then(res => {
				if (!cancelled) {
					const v = res.value;
					setBackend((typeof v === "string" ? v : "off") as MemoryBackend);
				}
			})
			.catch(() => {
				if (!cancelled) setBackend("off");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => { cancelled = true; };
	}, []);

	const handleBackendChange = useCallback(async (next: MemoryBackend) => {
		setSaving(true);
		setError(null);
		try {
			await setConfigKey("memory.backend", next);
			setBackend(next);
			setStatus(`Backend set to "${next}"`);
			setTimeout(() => setStatus(null), 3000);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, []);

	const handleAction = useCallback(async (action: "view" | "clear" | "enqueue" | "stats" | "diagnose") => {
		if (!activeSessionId) {
			setError("No active session — open a chat session first");
			return;
		}
		setError(null);
		try {
			await memoryAction(activeSessionId, action);
			setStatus(`/memory ${action} sent — see chat for output`);
			setTimeout(() => setStatus(null), 4000);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [activeSessionId]);

	if (loading) {
		return (
			<div className="mc-sidebar-panel">
				<div className="mc-providers-hint">Loading memory config…</div>
			</div>
		);
	}

	return (
		<div className="mc-sidebar-panel">
			<div className="mc-section-title">Memory Backend</div>

			<div className="mc-segmented" role="group" aria-label="Memory backend">
				{BACKENDS.map(b => (
					<button
						key={b.id}
						type="button"
						className="mc-segmented-btn"
						data-active={backend === b.id ? "true" : "false"}
						disabled={saving}
						title={b.desc}
						onClick={() => void handleBackendChange(b.id)}
					>
						{b.label}
					</button>
				))}
			</div>

			{backend && (
				<div className="mc-providers-hint">
					{BACKENDS.find(b => b.id === backend)?.desc}
				</div>
			)}

			<div className="mc-section-title" style={{ marginTop: 16 }}>Memory Actions</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ display: "flex", gap: 6 }}>
					<button
						type="button"
						className="mc-btn mc-btn-primary"
						disabled={!activeSessionId}
						title="Show current memory contents in chat"
						onClick={() => void handleAction("view")}
					>
						View
					</button>
					<button
						type="button"
						className="mc-btn"
						disabled={!activeSessionId}
						title="Show memory stats in chat"
						onClick={() => void handleAction("stats")}
					>
						Stats
					</button>
					<button
						type="button"
						className="mc-btn"
						disabled={!activeSessionId}
						title="Run memory diagnostics in chat"
						onClick={() => void handleAction("diagnose")}
					>
						Diagnose
					</button>
				</div>
				<div style={{ display: "flex", gap: 6 }}>
					<button
						type="button"
						className="mc-btn"
						disabled={!activeSessionId}
						title="Enqueue a memory rebuild"
						onClick={() => void handleAction("enqueue")}
					>
						Rebuild
					</button>
					<button
						type="button"
						className="mc-btn"
						disabled={!activeSessionId}
						style={{ color: "var(--error, #e55)" }}
						title="Clear all memory for this session's working directory"
						onClick={() => void handleAction("clear")}
					>
						Clear
					</button>
				</div>
			</div>

			{!activeSessionId && (
				<div className="mc-providers-hint" style={{ marginTop: 8 }}>
					Open a chat session to use memory actions.
				</div>
			)}

			{status && (
				<div className="mc-providers-hint" style={{ marginTop: 8, color: "var(--accent)" }}>
					{status}
				</div>
			)}
			{error && (
				<div className="mc-providers-hint" style={{ marginTop: 8, color: "var(--error, #e55)" }}>
					{error}
				</div>
			)}
		</div>
	);
}
