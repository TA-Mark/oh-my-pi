/**
 * Build the `omp` engine binary and stage it as a Tauri external sidecar.
 *
 * Tauri's `externalBin` contract: for `"binaries/omp"` in tauri.conf.json it
 * expects a file named `binaries/omp-<RUST_TARGET_TRIPLE>[.exe]` at build time,
 * and strips the triple when placing it next to the app binary in the bundle
 * (so rpc.rs resolves plain `omp[.exe]` beside current_exe at runtime).
 *
 * Env:
 *   CROSS_TARGET=<platform>-<arch>  cross-compile the engine (linux-arm64, darwin-arm64, …).
 *   SKIP_BUILD=1                    stage an already-built dist/omp[.exe] without rebuilding.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const desktopDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(desktopDir, "..", "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const crossTarget = Bun.env.CROSS_TARGET || null;
const skipBuild = Bun.env.SKIP_BUILD === "1";

/** CROSS_TARGET (<platform>-<arch>, as build-binary.ts uses) → Rust target triple. */
const CROSS_TO_TRIPLE: Record<string, string> = {
	"linux-x64": "x86_64-unknown-linux-gnu",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
	"windows-x64": "x86_64-pc-windows-msvc",
};

async function rustHostTriple(): Promise<string> {
	const result = await $`rustc -vV`.quiet().nothrow();
	const match = result.text().match(/host:\s*(\S+)/);
	if (!match) throw new Error("could not determine rustc host triple (is Rust installed?)");
	return match[1];
}

async function firstExisting(paths: string[]): Promise<string | null> {
	for (const candidate of paths) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// not this candidate; try the next
		}
	}
	return null;
}

async function main(): Promise<void> {
	let triple: string;
	if (crossTarget) {
		const mapped = CROSS_TO_TRIPLE[crossTarget];
		if (!mapped)
			throw new Error(`Unknown CROSS_TARGET "${crossTarget}". Known: ${Object.keys(CROSS_TO_TRIPLE).join(", ")}`);
		triple = mapped;
	} else {
		triple = await rustHostTriple();
	}
	const exe = triple.includes("windows") ? ".exe" : "";

	if (!skipBuild) {
		console.log(`Building omp engine${crossTarget ? ` for ${crossTarget}` : ""}…`);
		const env = crossTarget ? { ...process.env, CROSS_TARGET: crossTarget } : process.env;
		const build = Bun.spawn(["bun", "run", "build"], {
			cwd: codingAgentDir,
			env,
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await build.exited) !== 0) throw new Error("engine build failed");
	}

	const outName = crossTarget ? `omp-${crossTarget}` : "omp";
	const distDir = path.join(codingAgentDir, "dist");
	const src = await firstExisting([
		path.join(distDir, `${outName}${exe}`),
		path.join(distDir, outName),
		path.join(distDir, `${outName}.exe`),
	]);
	if (!src) {
		throw new Error(`Engine binary not found in ${distDir} (looked for ${outName}${exe}). Did the build succeed?`);
	}

	const binariesDir = path.join(desktopDir, "src-tauri", "binaries");
	await fs.mkdir(binariesDir, { recursive: true });
	const dest = path.join(binariesDir, `omp-${triple}${exe}`);
	await fs.copyFile(src, dest);
	if (!exe) await fs.chmod(dest, 0o755);

	console.log(`Sidecar staged: ${path.relative(repoRoot, dest)}`);
}

await main();
