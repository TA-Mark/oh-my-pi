import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface DevToolsTarget {
	type?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

interface RendererProbe {
	readyState: string;
	rootChildren: number;
	bodyText: string;
	preloadAvailable: boolean;
	href: string;
}

interface DiagnosticsProbe {
	appVersion?: unknown;
	platform?: unknown;
	arch?: unknown;
	engineRunning?: unknown;
}

interface PackagedEngineProbe {
	ready?: boolean;
	readyProtocolVersion?: number;
	sessionId?: string;
	isStreaming?: boolean;
	diagnosticsEngineRunning?: boolean;
}

interface CdpResponse {
	id?: number;
	error?: { message?: string };
	result?: { result?: { value?: unknown } };
}

interface CdpClient {
	evaluate<T>(expression: string): Promise<T>;
	close(): void;
}

function executablePath(): string {
	if (process.argv[2]) return path.resolve(process.argv[2]);
	if (process.platform === "win32")
		return path.join(import.meta.dir, "..", "release", "win-unpacked", "OMP Desktop.exe");
	throw new Error("Pass the packaged Electron executable path on non-Windows platforms.");
}

async function requireFile(filePath: string): Promise<void> {
	const stat = await fs.stat(filePath);
	if (!stat.isFile() || stat.size === 0) throw new Error(`Required packaged file is empty: ${filePath}`);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitForRenderer(port: number): Promise<DevToolsTarget> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			if (response.ok) {
				const targets = (await response.json()) as DevToolsTarget[];
				const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
				if (page) return page;
			}
		} catch {
			// Electron has not opened the DevTools endpoint yet.
		}
		await Bun.sleep(100);
	}
	throw new Error("Packaged renderer did not expose a page target within 20 seconds.");
}

async function connectCdp(url: string): Promise<CdpClient> {
	const socket = new WebSocket(url);
	const opened = Promise.withResolvers<void>();
	const pending = new Map<number, PromiseWithResolvers<unknown>>();
	let nextId = 0;
	socket.addEventListener("open", () => opened.resolve());
	socket.addEventListener("error", () => opened.reject(new Error("Could not connect to packaged renderer CDP.")));
	socket.addEventListener("message", event => {
		let message: CdpResponse;
		try {
			message = JSON.parse(String(event.data)) as CdpResponse;
		} catch {
			return;
		}
		if (message.id === undefined) return;
		const resolver = pending.get(message.id);
		if (!resolver) return;
		pending.delete(message.id);
		if (message.error) resolver.reject(new Error(message.error.message ?? "CDP command failed"));
		else resolver.resolve(message.result?.result?.value);
	});
	await withDeadline(opened.promise, 5_000, "Timed out connecting to packaged renderer CDP.");
	return {
		async evaluate<T>(expression: string): Promise<T> {
			const id = ++nextId;
			const result = Promise.withResolvers<unknown>();
			pending.set(id, result);
			socket.send(
				JSON.stringify({
					id,
					method: "Runtime.evaluate",
					params: { expression, awaitPromise: true, returnByValue: true },
				}),
			);
			return (await withDeadline(result.promise, 10_000, "Packaged renderer evaluation timed out.")) as T;
		},
		close(): void {
			socket.close();
			for (const resolver of pending.values()) resolver.reject(new Error("CDP connection closed"));
			pending.clear();
		},
	};
}

async function waitForMountedRenderer(cdp: CdpClient): Promise<RendererProbe> {
	const deadline = Date.now() + 10_000;
	let last: RendererProbe | undefined;
	while (Date.now() < deadline) {
		last = await cdp.evaluate<RendererProbe>(`({
			readyState: document.readyState,
			rootChildren: document.getElementById("root")?.childElementCount ?? -1,
			bodyText: document.body?.innerText?.slice(0, 1000) ?? "",
			preloadAvailable: typeof window.desktop === "object",
			href: location.href
		})`);
		if (last.readyState === "complete" && last.rootChildren > 0 && last.bodyText.trim().length > 0) return last;
		await Bun.sleep(100);
	}
	throw new Error(`Packaged renderer did not mount visible content: ${JSON.stringify(last)}`);
}

async function probePackagedEngine(cdp: CdpClient, cwd: string): Promise<PackagedEngineProbe> {
	const expression = `(async () => {
		const completed = Promise.withResolvers();
		let protocolVersion;
		let stateRequested = false;
		const unsubscribe = window.desktop.onRpcFrame(line => {
			try {
				const frame = JSON.parse(line);
				if (frame.type === "ready" && !stateRequested) {
					protocolVersion = frame.protocolVersion;
					stateRequested = true;
					void window.desktop.sendRpcLine(JSON.stringify({ type: "get_state", id: "packaged-validation" }));
				} else if (frame.type === "response" && frame.id === "packaged-validation") {
					unsubscribe();
					completed.resolve({ ready: true, protocolVersion, response: frame });
				}
			} catch (error) {
				unsubscribe();
				completed.reject(error);
			}
		});
		await window.desktop.startEngine(${JSON.stringify(cwd)});
		const { ready, protocolVersion: readyProtocolVersion, response } = await completed.promise;
		const diagnostics = await window.desktop.collectDiagnostics();
		await window.desktop.stopEngine();
		return {
			ready,
			readyProtocolVersion,
			sessionId: response?.data?.sessionId,
			isStreaming: response?.data?.isStreaming,
			diagnosticsEngineRunning: diagnostics?.engineRunning
		};
	})()`;
	return await cdp.evaluate<PackagedEngineProbe>(expression);
}

async function run(): Promise<void> {
	const executable = executablePath();
	const resources = path.join(path.dirname(executable), "resources");
	const sidecar = path.join(resources, process.platform === "win32" ? "omp.exe" : "omp");
	await Promise.all([requireFile(executable), requireFile(path.join(resources, "app.asar")), requireFile(sidecar)]);

	const versionProcess = Bun.spawn([sidecar, "--version"], { stdout: "pipe", stderr: "pipe" });
	const version = (await new Response(versionProcess.stdout).text()).trim();
	if ((await versionProcess.exited) !== 0 || version !== "omp/17.0.1") {
		throw new Error(`Packaged sidecar version mismatch: ${version || "<empty>"}`);
	}

	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-validation-"));
	const port = 19_000 + (process.pid % 1_000);
	const child = Bun.spawn(
		[executable, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, "--no-first-run"],
		{ cwd: path.dirname(executable), stdout: "ignore", stderr: "ignore" },
	);
	let cdp: CdpClient | undefined;
	try {
		const target = await waitForRenderer(port);
		if (!target.webSocketDebuggerUrl) throw new Error("Packaged renderer target has no CDP WebSocket URL.");
		cdp = await connectCdp(target.webSocketDebuggerUrl);
		const renderer = await waitForMountedRenderer(cdp);
		if (!renderer.preloadAvailable) throw new Error("Packaged preload bridge is unavailable.");
		if (!renderer.href.includes("app.asar") || !renderer.href.endsWith("/dist/index.html")) {
			throw new Error(`Packaged renderer loaded an unexpected URL: ${renderer.href}`);
		}
		const diagnostics = await cdp.evaluate<DiagnosticsProbe>(
			"window.desktop.collectDiagnostics().then(({ appVersion, platform, arch, engineRunning }) => ({ appVersion, platform, arch, engineRunning }))",
		);
		if (typeof diagnostics.appVersion !== "string" || diagnostics.platform !== process.platform) {
			throw new Error(`Packaged diagnostics IPC returned an invalid shape: ${JSON.stringify(diagnostics)}`);
		}
		const engine = await probePackagedEngine(cdp, path.dirname(executable));
		if (
			engine.ready !== true ||
			typeof engine.sessionId !== "string" ||
			typeof engine.isStreaming !== "boolean" ||
			engine.diagnosticsEngineRunning !== true
		) {
			throw new Error(`Packaged Electron-to-sidecar RPC probe failed: ${JSON.stringify(engine)}`);
		}
		console.log(`OK: packaged sidecar ${version}`);
		console.log(
			`OK: renderer mounted (${renderer.rootChildren} root child, ${renderer.bodyText.length} visible chars)`,
		);
		console.log("OK: preload bridge and diagnostics IPC responded");
		console.log(
			`OK: Electron spawned sidecar and completed get_state (protocol ${engine.readyProtocolVersion ?? "legacy"})`,
		);
	} finally {
		cdp?.close();
		child.kill();
		await withDeadline(child.exited, 5_000, "Packaged Electron process did not exit after validation.").catch(
			() => undefined,
		);
		await fs.rm(userData, { recursive: true, force: true });
	}
}

await run();
