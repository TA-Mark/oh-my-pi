/**
 * Fetch + stage runtime dependencies that the desktop installer needs:
 *
 *   1. **Bun** — sidecar binary. Without Bun on PATH, the Installer page
 *      can't run `bun install`, can't spawn omp.
 *   2. **pi_natives.<triple>.node** — precompiled native addon for omp.
 *      Built locally via `bun --cwd=../../natives run build`.
 *
 * Output:
 *   src-tauri/binaries/bun-<rust-target-triple>.exe          (Tauri sidecar)
 *   src-tauri/resources/native/pi_natives.<triple>.node      (Tauri resource file)
 *
 * Idempotent: skips downloads if cached version-files match.
 * Runs once during `bun run dev` / `bun run build` (see package.json).
 *
 * Note: MinGit was previously bundled (~30MB) but has zero consumers in the
 * bridge codebase — `OMP_BUNDLED_GIT_DIR` was never read. Dropped per plan D1.
 */

import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { copyFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";

const SHELL_DIR = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const NATIVES_DIR = resolve(SHELL_DIR, "..", "natives");
const BINARIES_DIR = join(SHELL_DIR, "src-tauri", "binaries");
const RESOURCES_DIR = join(SHELL_DIR, "src-tauri", "resources");
const CACHE_DIR = join(SHELL_DIR, ".dep-cache");

// Pin known-good versions so builds are reproducible across machines.
const BUN_VERSION = "1.3.14";
// Must match the workspace catalog version in root package.json (currently
// 16.1.20). The compiled bridge exe embeds a version sentinel
// (`__piNativesV<n>`) and refuses to load a .node with a different one.
// Bump both together when upgrading pi-natives.
const PI_NATIVES_NPM_VERSION = "16.1.20";

interface PlatformAsset {
	bun: { url: string; archiveExePath: string };
}

const ASSETS: Record<string, PlatformAsset> = {
	"x86_64-pc-windows-msvc": {
		bun: {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`,
			archiveExePath: "bun-windows-x64/bun.exe",
		},
	},
	"aarch64-pc-windows-msvc": {
		bun: {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`,
			archiveExePath: "bun-windows-x64/bun.exe",
		},
	},
	"x86_64-apple-darwin": {
		bun: {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-x64.zip`,
			archiveExePath: "bun-darwin-x64/bun",
		},
	},
	"aarch64-apple-darwin": {
		bun: {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-aarch64.zip`,
			archiveExePath: "bun-darwin-aarch64/bun",
		},
	},
	"x86_64-unknown-linux-gnu": {
		bun: {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`,
			archiveExePath: "bun-linux-x64/bun",
		},
	},
};

function deriveTripleFromHost(): string {
	const a = process.arch;
	const p = process.platform;
	if (p === "win32") return a === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
	if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	if (p === "linux") return "x86_64-unknown-linux-gnu";
	throw new Error(`unsupported host: ${p}/${a}`);
}

async function detectTripleViaRustc(): Promise<string | null> {
	return new Promise((res) => {
		const c = spawn("rustc", ["-vV"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let out = "";
		c.stdout.on("data", (b: Buffer) => {
			out += b.toString("utf8");
		});
		c.on("error", () => res(null));
		c.on("exit", () => res(/^host:\s*(.+)$/m.exec(out)?.[1]?.trim() ?? null));
	});
}

async function download(url: string, dest: string): Promise<void> {
	const cached = `${dest}.url`;
	if (existsSync(dest) && existsSync(cached) && readFileSync(cached, "utf8") === url) {
		console.log(`  [cache] ${dest}`);
		return;
	}
	console.log(`  [fetch] ${url}`);
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`);
	mkdirSync(resolve(dest, ".."), { recursive: true });
	await new Promise<void>((resolveStream, rejectStream) => {
		const out = createWriteStream(dest);
		Readable.fromWeb(res.body as never).pipe(out);
		out.on("finish", () => resolveStream());
		out.on("error", rejectStream);
	});
	writeFileSync(cached, url, "utf8");
}

async function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((res, rej) => {
		const c = spawn(cmd, args, { cwd, stdio: "inherit", windowsHide: true });
		c.on("error", rej);
		c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exit ${code}`))));
	});
}

async function unzip(zipPath: string, outDir: string): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	// Bun on Windows ships with tar that handles zip via `-x`.
	// We use PowerShell Expand-Archive on Windows for reliability.
	if (process.platform === "win32") {
		const ps = [
			"-NoProfile",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
		];
		await runCmd("powershell.exe", ps, SHELL_DIR);
	} else {
		await runCmd("unzip", ["-oq", zipPath, "-d", outDir], SHELL_DIR);
	}
}

async function stageBun(triple: string): Promise<void> {
	const asset = ASSETS[triple]?.bun;
	if (!asset) throw new Error(`no Bun asset for ${triple}`);
	const ext = triple.includes("windows") ? ".exe" : "";
	const sidecarPath = join(BINARIES_DIR, `bun-${triple}${ext}`);
	mkdirSync(BINARIES_DIR, { recursive: true });

	const zipDest = join(CACHE_DIR, `bun-${triple}.zip`);
	const extractDir = join(CACHE_DIR, `bun-${triple}-extracted`);
	await download(asset.url, zipDest);
	if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
	await unzip(zipDest, extractDir);

	const extractedBun = join(extractDir, asset.archiveExePath);
	if (!existsSync(extractedBun)) throw new Error(`bun not found in archive: ${extractedBun}`);
	copyFileSync(extractedBun, sidecarPath);
	console.log(`  [stage] ${sidecarPath}`);
}

async function stageNative(triple: string): Promise<void> {
	const mapping = mapTripleToNative(triple);
	if (!mapping) {
		console.log(`  [skip] pi_natives (no mapping for ${triple})`);
		return;
	}

	// Try precompiled npm tarball first — building from source requires
	// nightly Rust + MSVC and is far slower.
	const tarUrl = `https://registry.npmjs.org/@oh-my-pi/pi-natives-${mapping.npmSuffix}/-/pi-natives-${mapping.npmSuffix}-${PI_NATIVES_NPM_VERSION}.tgz`;
	const tarDest = join(CACHE_DIR, `pi-natives-${mapping.npmSuffix}.tgz`);
	const extractDir = join(CACHE_DIR, `pi-natives-${mapping.npmSuffix}-extracted`);
	await download(tarUrl, tarDest);
	if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
	mkdirSync(extractDir, { recursive: true });
	// Use Windows' built-in BSD tar (System32\tar.exe) — MSYS tar misparses
	// `C:\…` paths as SSH-style `host:path`.
	const tarBin = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "tar";
	await runCmd(tarBin, ["-xzf", tarDest, "-C", extractDir], SHELL_DIR);

	const candidates = [
		join(extractDir, "package", mapping.nodeFile),
		join(extractDir, "package", "native", mapping.nodeFile),
	];
	const extracted = candidates.find((p) => existsSync(p));
	if (!extracted) {
		throw new Error(`could not find ${mapping.nodeFile} in extracted tarball under ${extractDir}`);
	}

	const dest = join(RESOURCES_DIR, "native", mapping.nodeFile);
	mkdirSync(resolve(dest, ".."), { recursive: true });
	copyFileSync(extracted, dest);
	console.log(`  [stage] ${dest}`);
	void NATIVES_DIR;
}

interface NativeMapping {
	/** filename inside packages/natives/native/ that loader-state.js searches for */
	nodeFile: string;
	/** npm package suffix after `@oh-my-pi/pi-natives-` */
	npmSuffix: string;
}

function mapTripleToNative(triple: string): NativeMapping | null {
	// Loader (packages/natives/native/loader-state.js) tries -baseline / -msvc /
	// no-suffix. Published packages ship the `-baseline` variant on Windows.
	switch (triple) {
		case "x86_64-pc-windows-msvc":
			return { nodeFile: "pi_natives.win32-x64-baseline.node", npmSuffix: "win32-x64" };
		case "x86_64-apple-darwin":
			return { nodeFile: "pi_natives.darwin-x64.node", npmSuffix: "darwin-x64" };
		case "aarch64-apple-darwin":
			return { nodeFile: "pi_natives.darwin-arm64.node", npmSuffix: "darwin-arm64" };
		case "x86_64-unknown-linux-gnu":
			return { nodeFile: "pi_natives.linux-x64-gnu.node", npmSuffix: "linux-x64" };
		case "aarch64-unknown-linux-gnu":
			return { nodeFile: "pi_natives.linux-arm64-gnu.node", npmSuffix: "linux-arm64" };
		default:
			return null;
	}
}

async function main(): Promise<void> {
	const triple = (await detectTripleViaRustc()) ?? deriveTripleFromHost();
	console.log(`[deps] target triple: ${triple}`);
	mkdirSync(CACHE_DIR, { recursive: true });

	console.log("[deps] (1/2) Bun");
	await stageBun(triple);
	console.log("[deps] (2/2) pi_natives");
	await stageNative(triple);

	console.log("[deps] ✓ all bundled deps staged");
}

await main();
