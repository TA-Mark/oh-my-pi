/**
 * Compile the bridge to a standalone Bun-embedded binary.
 *
 * Output: dist/omp-bridge-<rust-target-triple>{.exe}
 *
 * The Rust target triple is required because Tauri's sidecar resolution looks
 * up `<configured>-<host-triple>{.exe}`. Pass it explicitly via
 *   --target=<triple>
 * or set $RUST_TARGET_TRIPLE. If neither is provided we derive one from
 * process.platform + process.arch.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE_DIR = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const ENTRY = join(PACKAGE_DIR, "src", "server.ts");
const DIST = join(PACKAGE_DIR, "dist");

function deriveTripleFromHost(): string {
	const a = process.arch;
	const p = process.platform;
	if (p === "win32") {
		if (a === "arm64") return "aarch64-pc-windows-msvc";
		return "x86_64-pc-windows-msvc";
	}
	if (p === "darwin") {
		if (a === "arm64") return "aarch64-apple-darwin";
		return "x86_64-apple-darwin";
	}
	if (p === "linux") {
		if (a === "arm64") return "aarch64-unknown-linux-gnu";
		return "x86_64-unknown-linux-gnu";
	}
	throw new Error(`unsupported host: ${p}/${a}`);
}

function parseArgs(argv: readonly string[]): { target: string } {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--target") return { target: argv[i + 1] ?? "" };
		if (a.startsWith("--target=")) return { target: a.slice("--target=".length) };
	}
	return { target: process.env.RUST_TARGET_TRIPLE ?? deriveTripleFromHost() };
}

async function main(): Promise<void> {
	const { target } = parseArgs(Bun.argv.slice(2));
	if (!target) throw new Error("could not determine target triple");
	const ext = target.includes("windows") ? ".exe" : "";
	const outFile = join(DIST, `omp-bridge-${target}${ext}`);
	mkdirSync(dirname(outFile), { recursive: true });

	console.log(`[bridge] compiling for ${target}`);
	console.log(`[bridge] entry:  ${ENTRY}`);
	console.log(`[bridge] output: ${outFile}`);

	await new Promise<void>((resolveSpawn, reject) => {
		const child = spawn(
			"bun",
			["build", "--compile", ENTRY, "--outfile", outFile, "--minify"],
			{ stdio: "inherit", windowsHide: true },
		);
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolveSpawn() : reject(new Error(`bun build exit ${code}`))));
	});

	console.log(`[bridge] ✓ compiled → ${outFile}`);
}

await main();
