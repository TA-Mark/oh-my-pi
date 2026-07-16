// WebdriverIO config for the packaged Tauri smoke test.
//
// This drives the *built* desktop binary through `tauri-driver`, which bridges
// the platform WebView to the WebDriver protocol (Edge WebDriver on Windows via
// WebView2, WebKitWebDriver on Linux). It is intentionally minimal: it proves
// the packaged app launches, mounts the React shell, and shows the primary
// navigation — i.e. the Rust bridge, asset bundling, and CSP all cohere in a
// real bundle. It does NOT boot the engine sidecar or assert agent behaviour;
// that is covered by the fast `smoke-rpc.ts` contract test.
//
// Runs only in CI on `desktop-v*` tags / manual dispatch (Webview2-dependent),
// never on PRs. See .github/workflows/desktop-release.yml (job: e2e-smoke).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Absolute path to the built binary. Overridable via TAURI_APP_BINARY so CI can
// point at whatever the bundler emitted for the current OS.
const REPO_DESKTOP = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const defaultBinary = join(
	REPO_DESKTOP,
	"src-tauri",
	"target",
	"release",
	isWindows ? "OMP Desktop.exe" : "omp-desktop",
);
const application = process.env.TAURI_APP_BINARY ?? defaultBinary;

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
	runner: "local",
	specs: [join(import.meta.dirname, "specs", "*.e2e.ts")],
	maxInstances: 1,
	capabilities: [
		{
			// tauri-driver reads this custom cap to know which binary to launch.
			// @ts-expect-error non-standard capability consumed by tauri-driver
			"tauri:options": { application },
			browserName: "wry",
		},
	],
	reporters: ["spec"],
	framework: "mocha",
	mochaOpts: { ui: "bdd", timeout: 120_000 },
	logLevel: "warn",

	// Boot tauri-driver on the default port (4444) before the session and tear
	// it down after. `tauri-driver` must be on PATH (cargo install tauri-driver).
	onPrepare: () => {
		if (!existsSync(application)) {
			throw new Error(
				`Packaged binary not found at ${application}. ` +
					`Build it first (bun run tauri:build) or set TAURI_APP_BINARY.`,
			);
		}
		// On Windows, tauri-driver needs msedgedriver on PATH matching the
		// installed WebView2 runtime. CI installs it explicitly.
		tauriDriver = spawn("tauri-driver", [], {
			stdio: [null, process.stdout, process.stderr],
		});
	},
	onComplete: () => {
		tauriDriver?.kill();
	},

	// tauri-driver on Windows needs the native msedgedriver; nudge a helpful
	// error if the whole toolchain is missing rather than a cryptic ECONNREFUSED.
	beforeSession: () => {
		const probe = spawnSync("tauri-driver", ["--help"], { stdio: "ignore" });
		if (probe.error) {
			throw new Error(
				"`tauri-driver` is not installed or not on PATH. " +
					"Install with: cargo install tauri-driver --locked",
			);
		}
	},
};
