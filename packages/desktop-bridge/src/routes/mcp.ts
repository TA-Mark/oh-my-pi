/**
 * MCP server manager — CRUD over `~/.omp/agent/mcp.json`.
 *
 * OMP reads MCP server entries from `mcpServers` in this file (see
 * `packages/coding-agent/src/discovery/builtin.ts:100-200`). The bridge
 * exposes GET / POST / DELETE surfaces so the React UI can list, add, edit,
 * or remove entries without leaving the desktop app.
 *
 * Route surface:
 *   GET    /api/v1/mcp             → { servers: McpServer[], path }
 *   POST   /api/v1/mcp             → upsert (body: McpServer with `name`)
 *   DELETE /api/v1/mcp/{name}      → remove
 *
 * Changes take effect the next time an omp session spawns. We don't hot-swap
 * a running TUI — the caller can restart the session via
 * `POST /chat/sessions/{id}/stop-pty` + `/start-pty` to pick up new servers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorResponse, jsonResponse } from "../lib/http";

export interface McpServer {
	name: string;
	enabled?: boolean;
	timeout?: number;
	/** stdio transport: shell command + args (mutually exclusive with `url`). */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** http transport: server URL (mutually exclusive with `command`). */
	url?: string;
	headers?: Record<string, string>;
}

interface McpFile {
	mcpServers?: Record<string, Omit<McpServer, "name">>;
	[key: string]: unknown;
}

/** Compute the OMP agent-config directory (mirrors packages/utils/src/dirs.ts:478). */
function agentDir(): string {
	// Respect $OMP_HOME (OMP's env override) first so a portable install works.
	const ompHome = process.env.OMP_HOME;
	if (ompHome) return join(ompHome, "agent");
	return join(homedir(), ".omp", "agent");
}

function mcpConfigPath(): string {
	return join(agentDir(), "mcp.json");
}

function readMcpFile(): McpFile {
	const p = mcpConfigPath();
	if (!existsSync(p)) return {};
	try {
		const raw = readFileSync(p, "utf-8");
		return JSON.parse(raw) as McpFile;
	} catch {
		return {};
	}
}

function writeMcpFile(data: McpFile): void {
	const p = mcpConfigPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function fileToList(file: McpFile): McpServer[] {
	const servers = file.mcpServers ?? {};
	return Object.entries(servers).map(([name, cfg]) => ({ name, ...cfg }));
}

/** Validate a POSTed server entry. Return null when OK, or an error message. */
function validate(body: unknown): { server: McpServer } | { error: string } {
	if (!body || typeof body !== "object") return { error: "body must be an object" };
	const b = body as Record<string, unknown>;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!name) return { error: "name is required" };
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
		return { error: `name may only contain letters, digits, _ . - (got: ${name})` };
	}
	const hasCommand = typeof b.command === "string" && b.command.length > 0;
	const hasUrl = typeof b.url === "string" && b.url.length > 0;
	if (!hasCommand && !hasUrl) return { error: "provide either `command` (stdio) or `url` (http)" };
	if (hasCommand && hasUrl) return { error: "`command` and `url` are mutually exclusive" };

	const server: McpServer = { name };
	if (typeof b.enabled === "boolean") server.enabled = b.enabled;
	if (typeof b.timeout === "number" && Number.isFinite(b.timeout) && b.timeout >= 0) server.timeout = b.timeout;
	if (hasCommand) {
		server.command = b.command as string;
		if (Array.isArray(b.args) && b.args.every(a => typeof a === "string")) server.args = b.args as string[];
		if (b.env && typeof b.env === "object") server.env = b.env as Record<string, string>;
		if (typeof b.cwd === "string") server.cwd = b.cwd;
	} else {
		server.url = b.url as string;
		if (b.headers && typeof b.headers === "object") server.headers = b.headers as Record<string, string>;
	}
	return { server };
}

export async function handleMcp(req: Request, url: URL): Promise<Response> {
	const p = url.pathname;

	if (p === "/api/v1/mcp" && req.method === "GET") {
		const file = readMcpFile();
		return jsonResponse({ servers: fileToList(file), path: mcpConfigPath() });
	}

	if (p === "/api/v1/mcp" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const result = validate(body);
		if ("error" in result) return errorResponse("BAD_REQUEST", result.error, 400);
		const file = readMcpFile();
		const map = file.mcpServers ?? {};
		const { name, ...cfg } = result.server;
		map[name] = cfg;
		file.mcpServers = map;
		writeMcpFile(file);
		return jsonResponse({ ok: true, server: result.server });
	}

	const deleteMatch = /^\/api\/v1\/mcp\/([A-Za-z0-9_.-]+)$/.exec(p);
	if (deleteMatch && req.method === "DELETE") {
		const name = deleteMatch[1] as string;
		const file = readMcpFile();
		if (file.mcpServers?.[name]) {
			delete file.mcpServers[name];
			writeMcpFile(file);
			return jsonResponse({ ok: true, name });
		}
		return errorResponse("NOT_FOUND", `no mcp server named "${name}"`, 404);
	}

	return errorResponse("NOT_FOUND", `No route for ${req.method} ${p}`, 404);
}
