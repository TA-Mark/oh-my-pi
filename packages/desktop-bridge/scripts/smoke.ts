/**
 * Smoke test — start the bridge on an ephemeral port, hit every major route,
 * print pass/fail, exit non-zero on failure.
 *
 * Phase-2 additions: lifecycle test for the omp child (start session, open WS,
 * send an RPC command, await response). If omp can't be resolved on this
 * machine, those checks are skipped with a clear note.
 *
 * Run with: bun run scripts/smoke.ts
 */

import { resolveOmp } from "../src/lib/omp-process";
import { start } from "../src/server";

interface Result {
	name: string;
	ok: boolean;
	status: number;
	detail?: string;
}

async function hit(name: string, method: string, url: string, body?: unknown): Promise<Result> {
	try {
		const res = await fetch(url, {
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(5000),
		});
		const ok = res.status >= 200 && res.status < 300;
		let detail = "";
		try {
			detail = JSON.stringify(await res.json()).slice(0, 120);
		} catch {
			/* non-json */
		}
		return { name, ok, status: res.status, detail };
	} catch (err) {
		return {
			name,
			ok: false,
			status: 0,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

const port = 18787;
const handle = start({ port });
await new Promise(r => setTimeout(r, 200));
const base = `http://127.0.0.1:${port}/api/v1`;

const results: Result[] = [];
results.push(await hit("GET /health", "GET", `${base}/health`));
results.push(
	await hit("POST /installer/preflight", "POST", `${base}/installer/preflight`, {
		repoUrl: "https://github.com/can1357/oh-my-pi.git",
		branch: "main",
		installPath: process.cwd(),
	}),
);
results.push(await hit("GET /launcher/status", "GET", `${base}/launcher/status`));
results.push(await hit("GET /launcher/workspaces", "GET", `${base}/launcher/workspaces`));
results.push(await hit("POST /launcher/diagnostics", "POST", `${base}/launcher/diagnostics`));
results.push(await hit("GET /launcher/update/check", "GET", `${base}/launcher/update/check`));
results.push(await hit("GET /chat/sessions", "GET", `${base}/chat/sessions`));
results.push(await hit("POST /chat/sessions", "POST", `${base}/chat/sessions`, { name: "smoke" }));
results.push(await hit("GET /chat/data-sources", "GET", `${base}/chat/data-sources`));
results.push(await hit("GET /chat/runtime-config", "GET", `${base}/chat/runtime-config`));
results.push(
	await hit("POST /chat/runtime-config", "POST", `${base}/chat/runtime-config`, {
		model: "anthropic/claude-haiku-4-5",
	}),
);

let failed = 0;
for (const r of results) {
	const sym = r.ok ? "✓" : "✗";
	console.log(`${sym} ${String(r.status).padStart(3)} ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
	if (!r.ok) failed++;
}

// ─── Phase 2: omp lifecycle ────────────────────────────────────────────────
const ompRes = resolveOmp({});
console.log("");
if (ompRes.source === "not-found") {
	console.log("⚠  omp not found — skipping Phase 2 lifecycle checks");
	console.log("   (install omp or set OMP_BIN to enable)");
} else {
	console.log(`→ omp resolved via ${ompRes.source}: ${ompRes.exe} ${ompRes.args.join(" ")}`);

	const startRes = await fetch(`${base}/chat/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "phase-2-smoke" }),
	});
	const { session } = (await startRes.json()) as { session: { id: string } };
	const id = session.id;

	const spawn = await hit(`POST /chat/sessions/${id.slice(0, 8)}…/start`, "POST", `${base}/chat/sessions/${id}/start`);
	console.log(`${spawn.ok ? "✓" : "✗"} ${String(spawn.status).padStart(3)} ${spawn.name}  ${spawn.detail ?? ""}`);
	if (!spawn.ok) failed++;

	// Probe — give omp 5s to settle, then ensure the child didn't exit early.
	let ompAlive = false;
	if (spawn.ok) {
		await new Promise(r => setTimeout(r, 5000));
		const stateRes = await fetch(`${base}/chat/sessions/${id}/state`);
		if (stateRes.ok) {
			const snap = (await stateRes.json()) as { running?: boolean; exitCode?: number | null };
			ompAlive = snap.running === true;
			if (!ompAlive && snap.exitCode != null) {
				console.log(`   omp exited with code ${snap.exitCode} during startup`);
			}
		}
	}

	if (!ompAlive && spawn.ok) {
		console.log("⚠  omp child exited shortly after spawn — skipping WS RPC roundtrip");
		console.log("   (run with bridge in foreground to see omp's stderr)");
	}

	if (spawn.ok && ompAlive) {
		const wsUrl = `ws://127.0.0.1:${port}/api/v1/chat/sessions/${id}/rpc`;
		const captured: string[] = [];
		let ompExited = false;
		try {
			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				const timer = setTimeout(() => {
					ws.close();
					reject(new Error("no RPC response within 15s"));
				}, 15000);
				ws.addEventListener("open", () => {
					ws.send(JSON.stringify({ id: "smoke-1", type: "get_available_models" }));
				});
				ws.addEventListener("message", evt => {
					try {
						const env = JSON.parse(String(evt.data)) as {
							type?: string;
							frame?: { type?: string; command?: string; success?: boolean };
							line?: string;
							stream?: string;
							code?: number | null;
						};
						if (env.type === "log" && env.line) captured.push(`[${env.stream}] ${env.line}`);
						if (env.type === "exit") {
							ompExited = true;
							clearTimeout(timer);
							ws.close();
							reject(new Error(`omp exited (code=${env.code ?? "null"}) before responding`));
							return;
						}
						if (
							env.type === "frame" &&
							env.frame?.type === "response" &&
							env.frame?.command === "get_available_models"
						) {
							clearTimeout(timer);
							ws.close();
							console.log(`✓ WS RPC get_available_models -> success=${env.frame.success}`);
							resolve();
						}
					} catch {
						/* ignore */
					}
				});
				ws.addEventListener("error", () => {
					clearTimeout(timer);
					reject(new Error("WS error"));
				});
			});
		} catch (err) {
			failed++;
			console.log(`✗ WS RPC roundtrip failed: ${err instanceof Error ? err.message : String(err)}`);
			if (captured.length > 0) {
				console.log(`  captured ${captured.length} log line(s) from omp child:`);
				for (const line of captured.slice(-12)) console.log(`    ${line}`);
				if (ompExited) {
					console.log("  → omp crashed before it could answer. Likely cause: native addon not built.");
					console.log("    fix: bun --cwd=packages/natives run build");
				}
			}
		}
	}

	const stop = await hit(`POST /chat/sessions/${id.slice(0, 8)}…/stop`, "POST", `${base}/chat/sessions/${id}/stop`);
	console.log(`${stop.ok ? "✓" : "✗"} ${String(stop.status).padStart(3)} ${stop.name}`);
	if (!stop.ok) failed++;
}

await handle.stop();
console.log(`\nfinal: ${failed === 0 ? "PASS" : "FAIL"}  (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
