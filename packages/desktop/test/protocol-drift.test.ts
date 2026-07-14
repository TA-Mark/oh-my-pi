import { describe, expect, test } from "bun:test";
import * as path from "node:path";

// ── Static drift guard (1.1) ─────────────────────────────────────────────────
// The desktop protocol (src/lib/rpc-protocol.ts) is a hand-authored, DOM-safe
// mirror of a SUBSET of the engine contract (coding-agent rpc-types.ts). This
// test asserts the subset relation structurally, so a command/response the
// desktop declares can't silently drift from an engine type that was renamed or
// removed. It complements scripts/smoke-rpc.ts (runtime), which asserts the
// payload shapes the client actually reads.
//
// Direction of the checks:
//   - Every command `type` the desktop sends MUST exist in the engine (hard fail).
//   - Every response `command` the desktop models MUST exist in the engine (hard fail).
//   - Engine commands the desktop does NOT mirror are listed for visibility
//     (informational — the desktop intentionally covers a subset).

const desktopFile = path.join(import.meta.dir, "..", "src", "lib", "rpc-protocol.ts");
const engineFile = path.join(import.meta.dir, "..", "..", "coding-agent", "src", "modes", "rpc", "rpc-types.ts");

async function read(file: string): Promise<string> {
	return await Bun.file(file).text();
}

/**
 * Extract the body of an `export type X = …` union. Arms span multiple lines and
 * contain their own `;` (e.g. `id?: string;`), so we can't stop at the first
 * line-ending semicolon; instead slice to the next top-level `export ` / `// ===`
 * section boundary, which reliably follows each union in both files.
 */
function unionBody(source: string, name: string): string {
	const marker = `export type ${name} =`;
	const start = source.indexOf(marker);
	if (start === -1) throw new Error(`union ${name} not found`);
	const rest = source.slice(start + marker.length);
	const boundary = rest.search(/\nexport (type|interface|const|function) |\n\/\/ ===/);
	return boundary === -1 ? rest : rest.slice(0, boundary);
}

/** All `type: "literal"` discriminants within a union body. */
function commandTypes(unionBodyText: string): Set<string> {
	const out = new Set<string>();
	for (const m of unionBodyText.matchAll(/\btype:\s*"([a-z_]+)"/g)) out.add(m[1]);
	return out;
}

/** All `command: "literal"` discriminants within a union body (skips the `command: string` error arm). */
function responseCommands(unionBodyText: string): Set<string> {
	const out = new Set<string>();
	for (const m of unionBodyText.matchAll(/\bcommand:\s*"([a-z_]+)"/g)) out.add(m[1]);
	return out;
}

describe("protocol drift guard (desktop ⊆ engine)", () => {
	test("every desktop command type exists in the engine", async () => {
		const [desktop, engine] = await Promise.all([read(desktopFile), read(engineFile)]);
		const desktopCmds = commandTypes(unionBody(desktop, "RpcCommand"));
		const engineCmds = commandTypes(unionBody(engine, "RpcCommand"));

		expect(desktopCmds.size).toBeGreaterThan(0);
		const missing = [...desktopCmds].filter(c => !engineCmds.has(c));
		expect(missing).toEqual([]);
	});

	test("every desktop command has a matching engine response arm", async () => {
		// The desktop keeps a generic RpcResponse (command: string) and doesn't
		// enumerate per-command arms, so we verify from the command side: each
		// command the desktop sends must have a `command: "…"` response arm in the
		// engine union (that's the shape the client awaits via #send).
		const [desktop, engine] = await Promise.all([read(desktopFile), read(engineFile)]);
		const desktopCmds = commandTypes(unionBody(desktop, "RpcCommand"));
		const engineResp = responseCommands(unionBody(engine, "RpcResponse"));

		const missing = [...desktopCmds].filter(c => !engineResp.has(c));
		expect(missing).toEqual([]);
	});

	test("reports engine commands the desktop does not mirror (informational)", async () => {
		const [desktop, engine] = await Promise.all([read(desktopFile), read(engineFile)]);
		const desktopCmds = commandTypes(unionBody(desktop, "RpcCommand"));
		const engineCmds = commandTypes(unionBody(engine, "RpcCommand"));
		const notMirrored = [...engineCmds].filter(c => !desktopCmds.has(c)).sort();
		// Not a failure — the desktop covers a subset by design. Surfaced so a sync
		// reviewer can see what the engine offers that the desktop hasn't adopted.
		console.log(`[drift] engine commands not mirrored by desktop (${notMirrored.length}):`, notMirrored.join(", "));
		expect(Array.isArray(notMirrored)).toBe(true);
	});
});
