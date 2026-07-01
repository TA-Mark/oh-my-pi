/**
 * File browser — read-only tree + text preview for the session working
 * directory.
 *
 * Path safety: every incoming path is canonicalized (`realpath`) and must
 * resolve under `ctx.config.installDir` — the bridge's own workspace root —
 * or the user's HOME. Anything else is rejected. Symlinks that escape the
 * allowed roots after resolution are also rejected. We refuse to serve
 * binary files or files larger than {@link FILE_PREVIEW_MAX_BYTES}.
 *
 * Route:
 *   GET /api/v1/fs?path=<abs>[&mode=list|read]
 *     list (default) → { entries: FsEntry[], root, path }
 *     read           → { path, content, truncated, size, encoding: "utf-8" }
 */

import { realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BridgeContext } from "../lib/context";
import { errorResponse, jsonResponse } from "../lib/http";

const FILE_PREVIEW_MAX_BYTES = 512 * 1024; // 512 KiB — big enough for source files, small enough to keep the WebView responsive.
const DIR_LISTING_MAX_ENTRIES = 5_000;

interface FsEntry {
	name: string;
	kind: "file" | "dir" | "symlink" | "other";
	size?: number;
	mtime?: number;
}

/**
 * Roots outside of which we refuse to serve anything. installDir is the
 * bridge's own workspace (session cwd for spawned omp processes); homedir()
 * covers `~/.omp/*` diagnostics that a curious user might poke at.
 */
function allowedRoots(ctx: BridgeContext): string[] {
	const roots = [ctx.config.installDir, homedir()];
	// realpath each so equality checks against realpath'd request paths match.
	return roots
		.map(r => {
			try {
				return realpathSync(r);
			} catch {
				return r;
			}
		})
		.filter((r, i, arr) => arr.indexOf(r) === i);
}

function isUnderAny(target: string, roots: readonly string[]): boolean {
	const norm = target.replace(/\\/g, "/");
	return roots.some(root => {
		const r = root.replace(/\\/g, "/");
		return norm === r || norm.startsWith(`${r}/`);
	});
}

function safeResolve(ctx: BridgeContext, input: string): { path: string } | { error: string; status: number } {
	const abs = resolve(input);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch (err) {
		return { error: `path not found: ${err instanceof Error ? err.message : String(err)}`, status: 404 };
	}
	const roots = allowedRoots(ctx);
	if (!isUnderAny(real, roots)) {
		return { error: `path is outside the allowed roots (${roots.join(", ")})`, status: 403 };
	}
	return { path: real };
}

async function listDir(dir: string): Promise<FsEntry[]> {
	const dirents = await readdir(dir, { withFileTypes: true });
	const out: FsEntry[] = [];
	for (const d of dirents) {
		if (out.length >= DIR_LISTING_MAX_ENTRIES) break;
		let kind: FsEntry["kind"] = "other";
		if (d.isDirectory()) kind = "dir";
		else if (d.isSymbolicLink()) kind = "symlink";
		else if (d.isFile()) kind = "file";
		let size: number | undefined;
		let mtime: number | undefined;
		if (kind === "file") {
			try {
				const st = statSync(resolve(dir, d.name));
				size = st.size;
				mtime = st.mtimeMs;
			} catch {
				/* ignore */
			}
		}
		out.push({ name: d.name, kind, size, mtime });
	}
	// Dirs first, then alpha within each.
	out.sort((a, b) => {
		if (a.kind === "dir" && b.kind !== "dir") return -1;
		if (a.kind !== "dir" && b.kind === "dir") return 1;
		return a.name.localeCompare(b.name);
	});
	return out;
}

/** True if the first sniff of a file looks like text (no NULs, mostly printable). */
function looksLikeText(buf: Buffer): boolean {
	if (buf.byteLength === 0) return true;
	const sample = buf.subarray(0, Math.min(4096, buf.byteLength));
	for (const byte of sample) {
		if (byte === 0) return false;
	}
	// Count printable + common whitespace bytes; reject if <90% look textual.
	let printable = 0;
	for (const byte of sample) {
		if (byte >= 0x20 && byte < 0x7f) printable++;
		else if (byte === 0x09 || byte === 0x0a || byte === 0x0d) printable++;
		else if (byte >= 0x80) printable++; // UTF-8 continuation — accept
	}
	return printable / sample.byteLength >= 0.9;
}

export async function handleFs(ctx: BridgeContext, req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET") {
		return errorResponse("METHOD_NOT_ALLOWED", "fs endpoint only supports GET", 405);
	}
	const raw = url.searchParams.get("path");
	if (!raw) return errorResponse("BAD_REQUEST", "?path=<absolute path> is required", 400);

	const resolved = safeResolve(ctx, raw);
	if ("error" in resolved) return errorResponse("FORBIDDEN", resolved.error, resolved.status);
	const path = resolved.path;

	let st: import("node:fs").Stats;
	try {
		st = statSync(path);
	} catch (err) {
		return errorResponse("NOT_FOUND", err instanceof Error ? err.message : String(err), 404);
	}

	const mode = url.searchParams.get("mode") ?? (st.isDirectory() ? "list" : "read");

	if (mode === "list") {
		if (!st.isDirectory()) return errorResponse("BAD_REQUEST", "path is not a directory", 400);
		try {
			const entries = await listDir(path);
			return jsonResponse({ entries, root: path, path });
		} catch (err) {
			return errorResponse("IO_ERROR", err instanceof Error ? err.message : String(err), 500);
		}
	}

	if (mode === "read") {
		if (!st.isFile()) return errorResponse("BAD_REQUEST", "path is not a file", 400);
		if (st.size > FILE_PREVIEW_MAX_BYTES) {
			return jsonResponse({
				path,
				content: "",
				truncated: true,
				size: st.size,
				encoding: "utf-8",
				error: `file too large for preview (${st.size} > ${FILE_PREVIEW_MAX_BYTES} bytes)`,
			});
		}
		try {
			const buf = await readFile(path);
			if (!looksLikeText(buf)) {
				return jsonResponse({
					path,
					content: "",
					truncated: false,
					size: st.size,
					encoding: "binary",
					error: "binary file — preview skipped",
				});
			}
			return jsonResponse({
				path,
				content: buf.toString("utf-8"),
				truncated: false,
				size: st.size,
				encoding: "utf-8",
			});
		} catch (err) {
			return errorResponse("IO_ERROR", err instanceof Error ? err.message : String(err), 500);
		}
	}

	return errorResponse("BAD_REQUEST", `unknown mode: ${mode}`, 400);
}
