/**
 * McpManagerPanel — CRUD over `~/.omp/agent/mcp.json` via the bridge's
 * `/api/v1/mcp` endpoints. Add/edit/delete MCP servers without leaving the
 * app; OMP picks changes up on the next session spawn (restart via the
 * Sessions tab or `POST /stop-pty` + `/start-pty` from another panel).
 */

import { type ChangeEvent, type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";

interface McpServer {
	name: string;
	enabled?: boolean;
	timeout?: number;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

interface McpListResponse {
	servers: McpServer[];
	path: string;
}

const BASE = "http://127.0.0.1:8787/api/v1";

interface FormState {
	name: string;
	transport: "stdio" | "http";
	command: string;
	argsText: string;
	envText: string;
	url: string;
	enabled: boolean;
}

const EMPTY_FORM: FormState = {
	name: "",
	transport: "stdio",
	command: "",
	argsText: "",
	envText: "",
	url: "",
	enabled: true,
};

function parseArgs(text: string): string[] | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	// One arg per line, whitespace-preserving (users often paste multi-token args).
	return trimmed
		.split("\n")
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

function parseEnv(text: string): Record<string, string> | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const out: Record<string, string> = {};
	for (const line of trimmed.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const k = line.slice(0, eq).trim();
		const v = line.slice(eq + 1);
		if (k) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

export function McpManagerPanel(): ReactNode {
	const [servers, setServers] = useState<McpServer[] | null>(null);
	const [path, setPath] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [formOpen, setFormOpen] = useState(false);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const res = await fetch(`${BASE}/mcp`);
			if (!res.ok) throw new Error(await res.text());
			const body = (await res.json()) as McpListResponse;
			setServers(body.servers);
			setPath(body.path);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setServers([]);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleSubmit = useCallback(
		async (ev: FormEvent) => {
			ev.preventDefault();
			setBusy(true);
			setError(null);
			try {
				const body: Record<string, unknown> = { name: form.name.trim(), enabled: form.enabled };
				if (form.transport === "stdio") {
					if (!form.command.trim()) throw new Error("command is required for stdio transport");
					body.command = form.command.trim();
					const args = parseArgs(form.argsText);
					if (args) body.args = args;
					const env = parseEnv(form.envText);
					if (env) body.env = env;
				} else {
					if (!form.url.trim()) throw new Error("url is required for http transport");
					body.url = form.url.trim();
				}
				const res = await fetch(`${BASE}/mcp`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const errBody = (await res.json().catch(() => ({ message: res.statusText }))) as { message?: string };
					throw new Error(errBody.message ?? res.statusText);
				}
				setForm(EMPTY_FORM);
				setFormOpen(false);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[form, refresh],
	);

	const handleDelete = useCallback(
		async (name: string) => {
			if (!confirm(`Remove MCP server "${name}"?`)) return;
			setBusy(true);
			setError(null);
			try {
				const res = await fetch(`${BASE}/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
				if (!res.ok) throw new Error(await res.text());
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	const updateForm = (patch: Partial<FormState>) => setForm(prev => ({ ...prev, ...patch }));

	return (
		<div className="mc-mcp-panel">
			<div className="mc-panel-head">
				<span className="mc-panel-title">MCP servers</span>
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => setFormOpen(v => !v)}
					disabled={busy}
				>
					{formOpen ? "Cancel" : "+ Add"}
				</button>
			</div>
			{path && <div className="mc-panel-hint">Config: {path}</div>}
			{error && <div className="mc-panel-error">{error}</div>}

			{formOpen && (
				<form className="mc-mcp-form" onSubmit={handleSubmit}>
					<label className="mc-form-row">
						<span>Name</span>
						<input
							type="text"
							value={form.name}
							required
							pattern="[A-Za-z0-9_.\-]+"
							onChange={(ev: ChangeEvent<HTMLInputElement>) => updateForm({ name: ev.target.value })}
						/>
					</label>
					<label className="mc-form-row">
						<span>Transport</span>
						<select
							value={form.transport}
							onChange={(ev: ChangeEvent<HTMLSelectElement>) =>
								updateForm({ transport: ev.target.value as "stdio" | "http" })
							}
						>
							<option value="stdio">stdio (command)</option>
							<option value="http">http (url)</option>
						</select>
					</label>
					{form.transport === "stdio" ? (
						<>
							<label className="mc-form-row">
								<span>Command</span>
								<input
									type="text"
									value={form.command}
									placeholder="npx"
									onChange={(ev: ChangeEvent<HTMLInputElement>) => updateForm({ command: ev.target.value })}
								/>
							</label>
							<label className="mc-form-row">
								<span>Args (one per line)</span>
								<textarea
									rows={3}
									value={form.argsText}
									placeholder="-y&#10;@modelcontextprotocol/server-filesystem"
									onChange={(ev: ChangeEvent<HTMLTextAreaElement>) =>
										updateForm({ argsText: ev.target.value })
									}
								/>
							</label>
							<label className="mc-form-row">
								<span>Env (KEY=value per line)</span>
								<textarea
									rows={2}
									value={form.envText}
									placeholder="API_TOKEN=xxx"
									onChange={(ev: ChangeEvent<HTMLTextAreaElement>) => updateForm({ envText: ev.target.value })}
								/>
							</label>
						</>
					) : (
						<label className="mc-form-row">
							<span>URL</span>
							<input
								type="url"
								value={form.url}
								placeholder="https://mcp.example.com/rpc"
								onChange={(ev: ChangeEvent<HTMLInputElement>) => updateForm({ url: ev.target.value })}
							/>
						</label>
					)}
					<label className="mc-form-row mc-form-row-inline">
						<input
							type="checkbox"
							checked={form.enabled}
							onChange={(ev: ChangeEvent<HTMLInputElement>) => updateForm({ enabled: ev.target.checked })}
						/>
						<span>Enabled</span>
					</label>
					<div className="mc-form-actions">
						<button type="submit" className="sh-btn sh-btn-primary" disabled={busy}>
							{busy ? "Saving…" : "Save"}
						</button>
					</div>
				</form>
			)}

			{servers === null ? (
				<div className="mc-panel-empty">Loading…</div>
			) : servers.length === 0 ? (
				<div className="mc-panel-empty">No MCP servers configured.</div>
			) : (
				<ul className="mc-mcp-list">
					{servers.map(server => (
						<li key={server.name} className="mc-mcp-item">
							<div className="mc-mcp-item-head">
								<span className="mc-mcp-item-name">{server.name}</span>
								<span className="mc-mcp-item-badge" data-enabled={server.enabled === false ? "false" : "true"}>
									{server.enabled === false ? "disabled" : "enabled"}
								</span>
							</div>
							<div className="mc-mcp-item-body">
								{server.command && (
									<code>
										{server.command} {(server.args ?? []).join(" ")}
									</code>
								)}
								{server.url && <code>{server.url}</code>}
							</div>
							<div className="mc-mcp-item-actions">
								<button
									type="button"
									className="sh-btn"
									onClick={() => handleDelete(server.name)}
									disabled={busy}
								>
									Remove
								</button>
							</div>
						</li>
					))}
				</ul>
			)}
			<div className="mc-panel-hint">
				Changes take effect on the next omp session spawn. Restart via the Sessions tab.
			</div>
		</div>
	);
}
