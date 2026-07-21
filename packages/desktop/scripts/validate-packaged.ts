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

interface UiSmokeProbe {
	memoryButtonsDisabled: boolean[];
	memoryHeading?: string;
	skillCommandDisabled?: boolean;
	confirmDialogChecked: boolean;
	sideChatContextChecked: boolean;
	diagnosticsTimelineChecked: boolean;
	diagnosticsRaceEventsChecked: boolean;
}

interface PackagedEngineProbe {
	ready?: boolean;
	readyProtocolVersion?: number;
	sessionId?: string;
	isStreaming?: boolean;
	diagnosticsEngineRunning?: boolean;
}
interface RpcScenarioProbe {
	streamingQueuedCount: number;
	streamingFinalQueuedCount: number;
	compactionQueuedCount: number;
	compactionFinalQueuedCount: number;
	compactionStarted: boolean;
	compactionEnded: boolean;
	recentEvents: string[];
}

interface MultiWindowInterruptProbe {
	windowBStreamingAfterAbort: boolean;
	windowAFinalStreaming: boolean;
	windowAFinalQueuedCount: number;
	toolStarted: boolean;
	toolFinalized: boolean;
	assistantInterrupted: boolean;
}

interface SmokeModelRequest {
	marker?: string;
	path: string;
	status: number;
	requestIndex: number;
}

interface SmokeModelServer {
	baseUrl: string;
	provider: string;
	model: string;
	requests: SmokeModelRequest[];
	stop(): void;
}

interface CdpEvaluationException {
	text?: string;
	exception?: { description?: string; value?: unknown };
}

interface CdpResponse {
	id?: number;
	error?: { message?: string };
	result?: { result?: { value?: unknown }; exceptionDetails?: CdpEvaluationException };
}

interface CdpClient {
	evaluate<T>(expression: string, label?: string, timeoutMs?: number): Promise<T>;
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

const SMOKE_PROVIDER = "packaged-smoke";
const SMOKE_MODEL = "smoke-model";
const SMOKE_MARKER_STREAM = "PACKAGED_SMOKE_STREAM";
const SMOKE_MARKER_FOLLOWUP = "PACKAGED_SMOKE_FOLLOWUP";
const SMOKE_MARKER_RETRY = "PACKAGED_SMOKE_RETRY_OVERLAP";
const SMOKE_MARKER_COMPACTION_QUEUE = "PACKAGED_SMOKE_COMPACTION_QUEUE";
const SMOKE_MARKER_WINDOW_A_TOOL = "PACKAGED_SMOKE_WINDOW_A_TOOL";
const SMOKE_MARKER_WINDOW_B = "PACKAGED_SMOKE_WINDOW_B";

const SMOKE_MARKERS = [
	SMOKE_MARKER_STREAM,
	SMOKE_MARKER_FOLLOWUP,
	SMOKE_MARKER_RETRY,
	SMOKE_MARKER_COMPACTION_QUEUE,
	SMOKE_MARKER_WINDOW_A_TOOL,
	SMOKE_MARKER_WINDOW_B,
] as const;
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStringValues(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStringValues(item, output);
		return;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) collectStringValues(item, output);
	}
}

function collectContentTextParts(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectContentTextParts(item, output);
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.text === "string") {
		output.push(value.text);
		return;
	}
	for (const item of Object.values(value)) collectContentTextParts(item, output);
}

function getUserContentTextPartsFromNewest(body: unknown): string[][] | undefined {
	if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
	const messages: string[][] = [];
	for (let index = body.messages.length - 1; index >= 0; index--) {
		const message = body.messages[index];
		if (!isRecord(message) || message.role !== "user") continue;
		const values: string[] = [];
		collectContentTextParts(message.content, values);
		messages.push(values);
	}
	return messages;
}

function extractSmokeMarker(body: unknown): string | undefined {
	const userMessages = getUserContentTextPartsFromNewest(body);
	if (userMessages !== undefined) {
		for (const parts of userMessages) {
			if (parts.some(part => part.trim().startsWith("<conversation>"))) return undefined;
			for (const part of parts) {
				const text = part.trim();
				if (text.length > 200) continue;
				const marker = SMOKE_MARKERS.find(candidate => text.includes(candidate));
				if (marker) return marker;
			}
		}
		return undefined;
	}
	const values: string[] = [];
	collectStringValues(body, values);
	const text = values.join("\n");
	return SMOKE_MARKERS.find(marker => text.includes(marker));
}

function createSmokeChatResponse(marker: string | undefined): Response {
	const encoder = new TextEncoder();
	const id = `chatcmpl-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const created = Math.floor(Date.now() / 1000);
	const chunk = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	const done = (): Uint8Array => encoder.encode("data: [DONE]\n\n");
	const responseBody = new ReadableStream<Uint8Array>({
		async start(controller) {
			const push = (payload: unknown): void => controller.enqueue(chunk(payload));
			const pushRole = (): void =>
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model: SMOKE_MODEL,
					choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
				});
			const pushText = (text: string): void =>
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model: SMOKE_MODEL,
					choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
				});
			const finishText = (promptTokens: number): void => {
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model: SMOKE_MODEL,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: promptTokens,
						completion_tokens: 12,
						total_tokens: promptTokens + 12,
					},
				});
				controller.enqueue(done());
				controller.close();
			};

			if (marker === SMOKE_MARKER_WINDOW_A_TOOL) {
				const toolArgs = JSON.stringify({
					command: "bun -e 'await Bun.sleep(30000)'",
					timeout: 60,
				});
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model: SMOKE_MODEL,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_packaged_smoke_bash",
										type: "function",
										function: { name: "bash", arguments: toolArgs },
									},
								],
							},
							finish_reason: null,
						},
					],
				});
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model: SMOKE_MODEL,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
				});
				controller.enqueue(done());
				controller.close();
				return;
			}

			pushRole();
			if (marker === SMOKE_MARKER_STREAM) {
				pushText("stream started");
				await Bun.sleep(1_500);
				pushText(" and finished");
				finishText(80);
				return;
			}
			if (marker === SMOKE_MARKER_WINDOW_B) {
				pushText("window b still running");
				for (let step = 0; step < 6; step++) {
					await Bun.sleep(5_000);
					pushText(" after interrupt");
				}
				finishText(80);
				return;
			}
			if (marker === SMOKE_MARKER_RETRY) {
				pushText("retry recovered");
				finishText(5_000);
				return;
			}
			if (marker === undefined) {
				await Bun.sleep(1_500);
				pushText("Compacted packaged validation transcript.");
				finishText(60);
				return;
			}
			pushText("packaged validation reply");
			finishText(80);
		},
	});
	return new Response(responseBody, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

function startSmokeModelServer(): SmokeModelServer {
	const requests: SmokeModelRequest[] = [];
	const failedMarkers = new Set<string>();
	const hostname = "127.0.0.1";
	const server = Bun.serve({
		hostname,
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/v1/models") {
				return Response.json({
					object: "list",
					data: [{ id: SMOKE_MODEL, object: "model", owned_by: SMOKE_PROVIDER }],
				});
			}
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				return new Response("not found", { status: 404 });
			}
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return new Response(JSON.stringify({ error: { message: "invalid json" } }), { status: 400 });
			}
			const marker = extractSmokeMarker(body);
			const requestIndex = requests.length;
			if (marker === SMOKE_MARKER_RETRY && !failedMarkers.has(marker)) {
				failedMarkers.add(marker);
				requests.push({ marker, path: url.pathname, status: 500, requestIndex });
				return new Response(JSON.stringify({ error: { message: "packaged smoke transient" } }), {
					status: 500,
					headers: { "Content-Type": "application/json", "Retry-After": "0" },
				});
			}
			requests.push({ ...(marker ? { marker } : {}), path: url.pathname, status: 200, requestIndex });
			return createSmokeChatResponse(marker);
		},
	});
	return {
		baseUrl: `http://${hostname}:${server.port}/v1`,
		provider: SMOKE_PROVIDER,
		model: SMOKE_MODEL,
		requests,
		stop: () => server.stop(true),
	};
}

async function createSmokeAgentDir(baseUrl: string): Promise<string> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-agent-"));
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:
  ${SMOKE_PROVIDER}:
    baseUrl: ${baseUrl}
    auth: none
    api: openai-completions
    disableStrictTools: true
    models:
      - id: ${SMOKE_MODEL}
        name: Packaged Smoke Model
        api: openai-completions
        reasoning: false
        supportsTools: true
        input: [text]
        contextWindow: 8192
        maxTokens: 512
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`,
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		`enabledModels:
  - ${SMOKE_PROVIDER}/${SMOKE_MODEL}
compaction:
  enabled: false
  strategy: context-full
  thresholdTokens: 200
  keepRecentTokens: 16
  autoContinue: false
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 10
tools:
  approvalMode: yolo
`,
	);
	return agentDir;
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

async function waitForAdditionalRenderer(port: number, knownWebSocketUrl: string): Promise<DevToolsTarget> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			if (response.ok) {
				const targets = (await response.json()) as DevToolsTarget[];
				const page = targets.find(
					target =>
						target.type === "page" &&
						typeof target.webSocketDebuggerUrl === "string" &&
						target.webSocketDebuggerUrl !== knownWebSocketUrl,
				);
				if (page) return page;
			}
		} catch {
			// The second BrowserWindow has not registered its DevTools target yet.
		}
		await Bun.sleep(100);
	}
	throw new Error("Packaged app did not expose a second page target within 20 seconds.");
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
		else if (message.result?.exceptionDetails) {
			const exception = message.result.exceptionDetails;
			resolver.reject(
				new Error(
					exception.exception?.description ??
						(typeof exception.exception?.value === "string" ? exception.exception.value : undefined) ??
						exception.text ??
						"CDP evaluation failed",
				),
			);
		} else resolver.resolve(message.result?.result?.value);
	});
	await withDeadline(opened.promise, 5_000, "Timed out connecting to packaged renderer CDP.");
	return {
		async evaluate<T>(expression: string, label = "Packaged renderer evaluation", timeoutMs = 20_000): Promise<T> {
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
			try {
				return (await withDeadline(result.promise, timeoutMs, `${label} timed out.`)) as T;
			} finally {
				pending.delete(id);
			}
		},
		close(): void {
			socket.close();
			for (const resolver of pending.values()) resolver.reject(new Error("CDP connection closed"));
			pending.clear();
		},
	};
}

async function waitForMountedRenderer(cdp: CdpClient): Promise<RendererProbe> {
	const deadline = Date.now() + 30_000;
	let last: RendererProbe | undefined;
	let lastError: string | undefined;
	while (Date.now() < deadline) {
		try {
			last = await cdp.evaluate<RendererProbe>(
				`({
				readyState: document.readyState,
				rootChildren: document.getElementById("root")?.childElementCount ?? -1,
				bodyText: document.body?.innerText?.slice(0, 1000) ?? "",
				preloadAvailable: typeof window.desktop === "object",
				href: location.href
			})`,
				"Mounted renderer probe",
			);
			lastError = undefined;
			if (last.readyState === "complete" && last.rootChildren > 0 && last.bodyText.trim().length > 0) return last;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await Bun.sleep(250);
	}
	throw new Error(`Packaged renderer did not mount visible content: ${JSON.stringify({ last, lastError })}`);
}

async function probePackagedUi(cdp: CdpClient): Promise<UiSmokeProbe> {
	const result = await cdp.evaluate<UiSmokeProbe>(`(async () => {
		const pause = async (milliseconds) => {
			const gate = Promise.withResolvers();
			setTimeout(gate.resolve, milliseconds);
			await gate.promise;
		};
		const buttons = () => Array.from(document.querySelectorAll("button"));
		const waitFor = async (predicate, label) => {
			const deadline = Date.now() + 8000;
			let last = "";
			while (Date.now() < deadline) {
				try {
					if (predicate()) return;
					last = document.body?.innerText?.slice(0, 500) || "";
				} catch (error) {
					last = error instanceof Error ? error.message : String(error);
				}
				await pause(100);
			}
			throw new Error(label + " did not become ready: " + last);
		};
		const clickButton = async (label) => {
			const button = buttons().find(candidate => candidate.textContent?.trim() === label);
			if (!button) throw new Error("Button not found: " + label);
			button.click();
			await pause(150);
			return button;
		};
		const clickSettingsCategory = async (label) => {
			const button = Array.from(document.querySelectorAll(".settings-nav button")).find(candidate => candidate.textContent?.trim() === label);
			if (!button) throw new Error("Settings category not found: " + label);
			button.click();
			await pause(150);
			return button;
		};

		await clickButton("Plugins");
		await waitFor(() => document.body.innerText.includes("Settings"), "settings panel");
		await clickSettingsCategory("Memory");
		await waitFor(() => document.body.innerText.includes("Choose where memory lives"), "memory settings");
		const memoryButtons = Array.from(document.querySelectorAll(".memory-backend-grid button"));
		const mnemopi = memoryButtons.find(button => button.textContent?.includes("Mnemopi"));
		if (!mnemopi) throw new Error("Mnemopi memory backend button not found");
		mnemopi.click();
		await waitFor(() => document.querySelector(".memory-backend-detail h4")?.textContent === "Mnemopi", "memory preview");
		const memoryHeading = document.querySelector(".memory-backend-detail h4")?.textContent;

		await clickSettingsCategory("Skills");
		await waitFor(
			() => document.body.innerText.includes("Available skills") || document.body.innerText.includes("Skill discovery"),
			"skills settings",
		);
		const skillCommand = buttons().find(button => button.textContent?.includes("/skill commands"));
		if (!skillCommand) throw new Error("Skill command switch not found");

		await clickSettingsCategory("Plugins");
		await waitFor(() => document.body.innerText.includes("Choose what to manage"), "plugins settings");
		const sourceTab = buttons().find(button => button.textContent?.includes("Sources"));
		if (sourceTab) {
			sourceTab.click();
			await pause(150);
		}
		const removeSource = buttons().reverse().find(button => button.textContent?.trim() === "Remove");
		let confirmDialogChecked = false;
		if (removeSource) {
			removeSource.click();
			await waitFor(() => Boolean(document.querySelector("[role=alertdialog]")), "local confirmation dialog");
			confirmDialogChecked = true;
			const cancel = Array.from(document.querySelectorAll("[role=alertdialog] button")).find(button => button.textContent?.trim() === "Cancel");
			cancel?.click();
			await pause(150);
		}

		const diagnosticsButton = buttons().find(button => button.getAttribute("aria-label") === "Open diagnostics");
		if (!diagnosticsButton) throw new Error("Open diagnostics button not found");
		diagnosticsButton.click();
		await waitFor(() => document.body.innerText.includes("Session timeline"), "diagnostics timeline");
		const timelineText = document.querySelector("[aria-label='Session timeline']")?.textContent ?? "";
		const diagnosticsTimelineChecked =
			timelineText.includes("recent events") || timelineText.includes("No session events yet");
		const diagnosticsRaceEventsChecked =
			timelineText.includes("Context compaction") ||
			timelineText.includes("Tool started") ||
			timelineText.includes("Assistant interrupted");
		const closeDiagnostics = buttons().find(button => button.getAttribute("aria-label") === "Close diagnostics");
		if (!closeDiagnostics) throw new Error("Close diagnostics button not found");
		closeDiagnostics.click();
		await pause(150);


		const closeSettings = buttons().find(button => button.getAttribute("aria-label") === "Close settings");
		closeSettings?.click();
		await pause(150);
		const showWorkspace = buttons().find(button => button.getAttribute("aria-label") === "Show workspace");
		if (!showWorkspace) throw new Error("Show workspace button not found");
		showWorkspace.click();
		await waitFor(() => document.body.innerText.includes("Choose a tool to open alongside your task"), "workspace tool menu");
		const sideChatButton = buttons().find(button => button.textContent?.includes("Side chat"));
		if (!sideChatButton) throw new Error("Side chat tool button not found");
		sideChatButton.click();
		await waitFor(
			() => document.body.innerText.includes("Side chat") && document.body.innerText.includes("Context inspector"),
			"side chat context inspector",
		);

		return {
			memoryButtonsDisabled: memoryButtons.map(button => button.disabled),
			memoryHeading,
			skillCommandDisabled: skillCommand.disabled,
			confirmDialogChecked,
			sideChatContextChecked: true,
			diagnosticsTimelineChecked,
			diagnosticsRaceEventsChecked,
		};
	})()`);
	if (result.memoryButtonsDisabled.some(Boolean)) {
		throw new Error(
			`Memory backend cards are disabled in packaged UI: ${JSON.stringify(result.memoryButtonsDisabled)}`,
		);
	}
	if (result.memoryHeading !== "Mnemopi")
		throw new Error(`Memory backend preview did not select Mnemopi: ${result.memoryHeading}`);
	if (result.skillCommandDisabled) throw new Error("Skill command switch is disabled in packaged UI.");
	if (!result.sideChatContextChecked) throw new Error("Side Chat context inspector was not visible in packaged UI.");
	if (!result.diagnosticsTimelineChecked) throw new Error("Diagnostics timeline was not visible in packaged UI.");
	if (!result.diagnosticsRaceEventsChecked)
		throw new Error("Diagnostics timeline did not include packaged race events.");
	return result;
}

async function probePackagedEngine(
	cdp: CdpClient,
	cwd: string,
	stopAfter = true,
	label = "Packaged engine probe",
	timeoutMs = 60_000,
): Promise<PackagedEngineProbe> {
	const shouldStop = JSON.stringify(stopAfter);
	const expression = `(async () => {
		const sleep = async (milliseconds) => {
			const gate = Promise.withResolvers();
			setTimeout(gate.resolve, milliseconds);
			await gate.promise;
		};
		void window.desktop.startEngine(${JSON.stringify(cwd)}).catch(() => undefined);
		const deadline = Date.now() + ${timeoutMs} - 5_000;
		while (Date.now() < deadline) {
			const diagnostics = await window.desktop.collectDiagnostics();
			if (diagnostics?.engineRunning === true) {
				if (${shouldStop}) await window.desktop.stopEngine();
				return {
					ready: true,
					readyProtocolVersion: undefined,
					sessionId: undefined,
					isStreaming: false,
					diagnosticsEngineRunning: true
				};
			}
			await sleep(500);
		}
		throw new Error("Packaged engine did not report running.");
	})()`;
	return await cdp.evaluate<PackagedEngineProbe>(expression, label, timeoutMs);
}

async function probeMultiWindowEngineIsolation(
	port: number,
	firstTarget: DevToolsTarget,
	firstCdp: CdpClient,
	cwd: string,
): Promise<PackagedEngineProbe> {
	if (!firstTarget.webSocketDebuggerUrl) throw new Error("First packaged renderer target has no CDP WebSocket URL.");
	await firstCdp.evaluate<void>("window.desktop.openNewWindow()", "Open second packaged window", 60_000);
	const secondTarget = await waitForAdditionalRenderer(port, firstTarget.webSocketDebuggerUrl);
	if (!secondTarget.webSocketDebuggerUrl) throw new Error("Second packaged renderer target has no CDP WebSocket URL.");

	const secondCdp = await connectCdp(secondTarget.webSocketDebuggerUrl);
	try {
		const secondRenderer = await waitForMountedRenderer(secondCdp);
		if (!secondRenderer.preloadAvailable) throw new Error("Second packaged preload bridge is unavailable.");

		const firstEngine = await probePackagedEngine(firstCdp, cwd, false, "First packaged engine probe", 60_000);
		const secondEngine = await probePackagedEngine(secondCdp, cwd, false, "Second packaged engine probe", 60_000);
		for (const [label, engine] of [
			["first", firstEngine],
			["second", secondEngine],
		] as const) {
			if (engine.ready !== true || engine.diagnosticsEngineRunning !== true) {
				throw new Error(`Packaged ${label}-window sidecar RPC probe failed: ${JSON.stringify(engine)}`);
			}
		}

		await secondCdp.evaluate<void>("window.desktop.stopEngine()", "Stop second packaged engine", 10_000);
		const firstDiagnostics = await firstCdp.evaluate<DiagnosticsProbe>(
			"window.desktop.collectDiagnostics().then(({ engineRunning }) => ({ engineRunning }))",
			"Check first window engine after stopping second",
			10_000,
		);
		if (firstDiagnostics.engineRunning !== true) {
			throw new Error("Stopping the second packaged window engine stopped the first window engine.");
		}
		return firstEngine;
	} finally {
		await secondCdp
			.evaluate<void>("window.desktop.stopEngine().catch(() => undefined)", "Cleanup second packaged engine", 10_000)
			.catch(() => undefined);
		secondCdp.close();
		await firstCdp
			.evaluate<void>("window.desktop.stopEngine().catch(() => undefined)", "Cleanup first packaged engine", 10_000)
			.catch(() => undefined);
	}
}

function rpcHarnessExpression(cwd: string, body: string): string {
	return `(async () => {
		const cwd = ${JSON.stringify(cwd)};
		const provider = ${JSON.stringify(SMOKE_PROVIDER)};
		const model = ${JSON.stringify(SMOKE_MODEL)};
		const frames = [];
		let seq = 0;
		const sleep = async (milliseconds) => {
			const gate = Promise.withResolvers();
			setTimeout(gate.resolve, milliseconds);
			await gate.promise;
		};
		const id = (prefix) => prefix + "-" + (++seq);
		const waitFor = async (predicate, label, timeoutMs = 30000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const frame = frames.find(predicate);
				if (frame) return frame;
				await sleep(100);
			}
			throw new Error(label + " did not occur. Recent frames: " + frames.slice(-8).map(frame => frame.type + (frame.id ? ":" + frame.id : "")).join(", "));
		};
		const send = async (command) => {
			await window.desktop.sendRpcLine(JSON.stringify(command));
		};
		const command = async (payload, label = payload.type, timeoutMs = 30000) => {
			const commandId = payload.id || id(payload.type);
			await send({ ...payload, id: commandId });
			const frame = await waitFor(candidate => candidate.type === "response" && candidate.id === commandId, label, timeoutMs);
			if (frame.success !== true) throw new Error(label + " failed: " + (frame.error || JSON.stringify(frame)));
			return frame.data;
		};
		const getState = async (label = "state") => command({ type: "get_state", id: id(label) }, label);
		const waitForState = async (predicate, label, timeoutMs = 30000) => {
			const deadline = Date.now() + timeoutMs;
			let last;
			while (Date.now() < deadline) {
				last = await getState(label);
				if (predicate(last)) return last;
				await sleep(200);
			}
			throw new Error(label + " state did not match: " + JSON.stringify(last));
		};
		const assistantEndCount = () => frames.filter(frame => frame.type === "message_end" && frame.message?.role === "assistant").length;
		const unsubscribe = window.desktop.onRpcFrame(line => {
			try {
				frames.push(JSON.parse(line));
			} catch {
				frames.push({ type: "parse_error", line });
			}
		});
		try {
			await window.desktop.stopEngine().catch(() => undefined);
			await sleep(500);
			frames.length = 0;
			await window.desktop.startEngine(cwd);
			await waitFor(frame => frame.type === "ready", "engine ready", 60000);
			await command({ type: "set_model", provider, modelId: model, id: id("model") }, "set_model", 60000);
			await command({ type: "set_thinking_level", level: "off", id: id("thinking") }, "set_thinking_level", 30000);
			await command({ type: "set_approval_mode", mode: "yolo", id: id("approval") }, "set_approval_mode", 30000);
			await command({ type: "set_steering_mode", mode: "all", id: id("steering-mode") }, "set_steering_mode", 30000);
			await command({ type: "set_follow_up_mode", mode: "all", id: id("follow-mode") }, "set_follow_up_mode", 30000);
			await command({ type: "set_auto_compaction", enabled: false, id: id("compaction-off") }, "set_auto_compaction", 30000);
			${body}
		} finally {
			unsubscribe();
		}
	})()`;
}

async function probePackagedRpcScenarios(cdp: CdpClient, cwd: string): Promise<RpcScenarioProbe> {
	const result = await cdp.evaluate<RpcScenarioProbe>(
		rpcHarnessExpression(
			cwd,
			`
			const streamEndsBefore = assistantEndCount();
			await send({ type: "prompt", message: ${JSON.stringify(SMOKE_MARKER_STREAM)}, id: id("stream") });
			await waitFor(frame => frame.type === "agent_start", "streaming agent start", 30000);
			await send({ type: "follow_up", message: ${JSON.stringify(SMOKE_MARKER_FOLLOWUP)}, id: id("follow-up") });
			const queuedDuringStream = await waitForState(
				state => state.isStreaming === true && (state.queuedMessageCount ?? 0) >= 1,
				"queued follow-up while streaming",
				15000
			);
			await waitFor(() => assistantEndCount() >= streamEndsBefore + 2, "queued follow-up drain", 60000);
			const afterStream = await getState("after-stream");
			if (afterStream.isStreaming !== false || (afterStream.queuedMessageCount ?? 0) !== 0) {
				throw new Error("streaming queue did not drain: " + JSON.stringify(afterStream));
			}

			const setting = async (path, value) => command({ type: "set_setting", path, value, id: id("setting") }, "set " + path, 30000);
			await setting("compaction.strategy", "context-full");
			await setting("compaction.thresholdTokens", 200);
			await setting("compaction.keepRecentTokens", 16);
			await setting("compaction.autoContinue", false);
			await setting("retry.enabled", true);
			await setting("retry.maxRetries", 1);
			await setting("retry.baseDelayMs", 10);
			await command({ type: "set_auto_compaction", enabled: true, id: id("compaction-on") }, "enable compaction", 30000);

			const retryEndsBefore = assistantEndCount();
			await send({ type: "prompt", message: ${JSON.stringify(SMOKE_MARKER_RETRY)}, id: id("retry") });
			await waitFor(frame => frame.type === "auto_compaction_start", "auto compaction start", 60000);
			await send({ type: "follow_up", message: ${JSON.stringify(SMOKE_MARKER_COMPACTION_QUEUE)}, id: id("compaction-follow-up") });
			const queuedDuringCompaction = await waitForState(
				state => state.isCompacting === true && (state.queuedMessageCount ?? 0) >= 1,
				"queued follow-up during compaction",
				20000
			);
			await waitFor(frame => frame.type === "auto_compaction_end", "auto compaction end", 60000);
			await command({ type: "set_auto_compaction", enabled: false, id: id("compaction-final-off") }, "disable compaction", 30000);
			await waitFor(() => assistantEndCount() >= retryEndsBefore + 2, "queued compaction follow-up drain", 60000);
			const afterCompaction = await waitForState(
				state => state.isStreaming === false && state.isCompacting !== true && (state.queuedMessageCount ?? 0) === 0,
				"compaction queue drained",
				60000
			);
			await window.desktop.stopEngine();
			return {
				streamingQueuedCount: queuedDuringStream.queuedMessageCount ?? 0,
				streamingFinalQueuedCount: afterStream.queuedMessageCount ?? 0,
				compactionQueuedCount: queuedDuringCompaction.queuedMessageCount ?? 0,
				compactionFinalQueuedCount: afterCompaction.queuedMessageCount ?? 0,
				compactionStarted: frames.some(frame => frame.type === "auto_compaction_start"),
				compactionEnded: frames.some(frame => frame.type === "auto_compaction_end"),
				recentEvents: frames.map(frame => frame.type).slice(-30),
			};`,
		),
		"Packaged RPC queue and compaction probe",
		150_000,
	);
	if (result.streamingQueuedCount < 1) {
		throw new Error(`Follow-up was not queued while streaming: ${JSON.stringify(result)}`);
	}
	if (result.streamingFinalQueuedCount !== 0 || result.compactionFinalQueuedCount !== 0) {
		throw new Error(`Queued messages did not drain: ${JSON.stringify(result)}`);
	}
	if (!result.compactionStarted || !result.compactionEnded || result.compactionQueuedCount < 1) {
		throw new Error(`Compaction race events were not observed: ${JSON.stringify(result)}`);
	}
	return result;
}

async function startPackagedPrompt(
	cdp: CdpClient,
	cwd: string,
	message: string,
	label: string,
	waitForTool = false,
): Promise<void> {
	const startPredicate = waitForTool
		? 'frame => frame.type === "tool_execution_start"'
		: 'frame => frame.type === "agent_start"';
	await cdp.evaluate<void>(
		rpcHarnessExpression(
			cwd,
			`
			await send({ type: "prompt", message: ${JSON.stringify(message)}, id: id("prompt") });
			await waitFor(
				${startPredicate},
				${JSON.stringify(`${label} start`)},
				60000
			);
			const running = await getState("running");
			if (running.isStreaming !== true) throw new Error(${JSON.stringify(label)} + " did not leave the engine streaming: " + JSON.stringify(running));
			return;`,
		),
		label,
		90_000,
	);
}

async function abortPackagedWindow(cdp: CdpClient): Promise<MultiWindowInterruptProbe> {
	return await cdp.evaluate<MultiWindowInterruptProbe>(
		`(async () => {
			const frames = [];
			let seq = 0;
			const sleep = async (milliseconds) => {
				const gate = Promise.withResolvers();
				setTimeout(gate.resolve, milliseconds);
				await gate.promise;
			};
			const id = (prefix) => prefix + "-" + (++seq);
			const waitFor = async (predicate, label, timeoutMs = 30000) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const frame = frames.find(predicate);
					if (frame) return frame;
					await sleep(100);
				}
				throw new Error(label + " did not occur. Recent frames: " + frames.slice(-8).map(frame => frame.type + (frame.id ? ":" + frame.id : "")).join(", "));
			};
			const send = async (command) => window.desktop.sendRpcLine(JSON.stringify(command));
			const command = async (payload, label = payload.type, timeoutMs = 30000) => {
				const commandId = payload.id || id(payload.type);
				await send({ ...payload, id: commandId });
				const frame = await waitFor(candidate => candidate.type === "response" && candidate.id === commandId, label, timeoutMs);
				if (frame.success !== true) throw new Error(label + " failed: " + (frame.error || JSON.stringify(frame)));
				return frame.data;
			};
			const unsubscribe = window.desktop.onRpcFrame(line => {
				try {
					frames.push(JSON.parse(line));
				} catch {
					frames.push({ type: "parse_error", line });
				}
			});
			try {
				await send({ type: "abort", id: id("abort") });
				await waitFor(frame => frame.type === "tool_execution_end", "tool finalized after abort", 30000);
				await waitFor(frame => frame.type === "message_end" && frame.message?.stopReason === "aborted", "assistant interrupted", 30000);
				const state = await command({ type: "get_state", id: id("state") }, "post-abort state", 30000);
				await window.desktop.stopEngine();
				return {
					windowBStreamingAfterAbort: false,
					windowAFinalStreaming: state.isStreaming === true,
					windowAFinalQueuedCount: state.queuedMessageCount ?? 0,
					toolStarted: true,
					toolFinalized: frames.some(frame => frame.type === "tool_execution_end"),
					assistantInterrupted: frames.some(frame => frame.type === "message_end" && frame.message?.stopReason === "aborted"),
				};
			} finally {
				unsubscribe();
			}
		})()`,
		"Abort first packaged window",
		60_000,
	);
}

async function getPackagedWindowStreaming(cdp: CdpClient): Promise<boolean> {
	return await cdp.evaluate<boolean>(
		`(async () => {
			const frames = [];
			let seq = 0;
			const sleep = async (milliseconds) => {
				const gate = Promise.withResolvers();
				setTimeout(gate.resolve, milliseconds);
				await gate.promise;
			};
			const id = (prefix) => prefix + "-" + (++seq);
			const waitFor = async (predicate, label, timeoutMs = 30000) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const frame = frames.find(predicate);
					if (frame) return frame;
					await sleep(100);
				}
				throw new Error(label + " did not occur.");
			};
			const unsubscribe = window.desktop.onRpcFrame(line => {
				try {
					frames.push(JSON.parse(line));
				} catch {}
			});
			try {
				const stateId = id("state");
				await window.desktop.sendRpcLine(JSON.stringify({ type: "get_state", id: stateId }));
				const frame = await waitFor(candidate => candidate.type === "response" && candidate.id === stateId, "streaming state", 30000);
				if (frame.success !== true) throw new Error(frame.error || "get_state failed");
				return frame.data?.isStreaming === true;
			} finally {
				unsubscribe();
			}
		})()`,
		"Check packaged window streaming",
		40_000,
	);
}

async function probePackagedMultiWindowInterrupt(
	port: number,
	firstTarget: DevToolsTarget,
	firstCdp: CdpClient,
	cwd: string,
): Promise<MultiWindowInterruptProbe> {
	if (!firstTarget.webSocketDebuggerUrl) throw new Error("First packaged renderer target has no CDP WebSocket URL.");
	await firstCdp.evaluate<void>("window.desktop.openNewWindow()", "Open interrupt smoke window", 60_000);
	const secondTarget = await waitForAdditionalRenderer(port, firstTarget.webSocketDebuggerUrl);
	if (!secondTarget.webSocketDebuggerUrl) throw new Error("Interrupt smoke window has no CDP WebSocket URL.");
	const secondCdp = await connectCdp(secondTarget.webSocketDebuggerUrl);
	try {
		const secondRenderer = await waitForMountedRenderer(secondCdp);
		if (!secondRenderer.preloadAvailable) throw new Error("Interrupt smoke preload bridge is unavailable.");
		await startPackagedPrompt(secondCdp, cwd, SMOKE_MARKER_WINDOW_B, "Second packaged window streaming probe");
		await startPackagedPrompt(firstCdp, cwd, SMOKE_MARKER_WINDOW_A_TOOL, "First packaged window tool probe", true);
		const firstAbort = await abortPackagedWindow(firstCdp);
		const secondStillStreaming = await getPackagedWindowStreaming(secondCdp);
		await secondCdp
			.evaluate<void>(
				"window.desktop.stopEngine().catch(() => undefined)",
				"Cleanup second interrupt engine",
				10_000,
			)
			.catch(() => undefined);
		const result = { ...firstAbort, windowBStreamingAfterAbort: secondStillStreaming };
		if (!result.windowBStreamingAfterAbort) {
			throw new Error(`Window B stopped when Window A was interrupted: ${JSON.stringify(result)}`);
		}
		if (
			result.windowAFinalStreaming ||
			result.windowAFinalQueuedCount !== 0 ||
			!result.toolStarted ||
			!result.toolFinalized ||
			!result.assistantInterrupted
		) {
			throw new Error(`Window A did not finalize cleanly after interrupt: ${JSON.stringify(result)}`);
		}
		return result;
	} finally {
		await secondCdp
			.evaluate<void>(
				"window.desktop.stopEngine().catch(() => undefined)",
				"Cleanup second interrupt engine",
				10_000,
			)
			.catch(() => undefined);
		secondCdp.close();
		await firstCdp
			.evaluate<void>("window.desktop.stopEngine().catch(() => undefined)", "Cleanup first interrupt engine", 10_000)
			.catch(() => undefined);
	}
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

	const smokeServer = startSmokeModelServer();
	const agentDir = await createSmokeAgentDir(smokeServer.baseUrl);
	const userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-validation-"));
	const port = 19_000 + (process.pid % 1_000);
	const child = Bun.spawn(
		[
			executable,
			`--user-data-dir=${userData}`,
			`--remote-debugging-port=${port}`,
			"--no-first-run",
			"--omp-validation-instance",
		],
		{
			cwd: path.dirname(executable),
			stdout: "ignore",
			stderr: "ignore",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		},
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
			"Check renderer diagnostics IPC",
			10_000,
		);
		if (typeof diagnostics.appVersion !== "string" || diagnostics.platform !== process.platform) {
			throw new Error(`Packaged diagnostics IPC returned an invalid shape: ${JSON.stringify(diagnostics)}`);
		}
		const engine = await probeMultiWindowEngineIsolation(port, target, cdp, path.dirname(executable));
		const rpcScenarios = await probePackagedRpcScenarios(cdp, path.dirname(executable));
		const retryRequestCount = smokeServer.requests.filter(request => request.marker === SMOKE_MARKER_RETRY).length;
		if (retryRequestCount !== 2) {
			throw new Error(
				`Retry prompt was not sent exactly once plus one transport retry: ${JSON.stringify(smokeServer.requests)}`,
			);
		}
		if (!smokeServer.requests.some(request => request.marker === SMOKE_MARKER_COMPACTION_QUEUE)) {
			throw new Error(
				`Compaction queued follow-up did not reach the smoke model: ${JSON.stringify(smokeServer.requests)}`,
			);
		}
		const interrupt = await probePackagedMultiWindowInterrupt(port, target, cdp, path.dirname(executable));
		const uiSmoke = await probePackagedUi(cdp);
		console.log(`OK: packaged sidecar ${version}`);
		console.log(
			`OK: renderer mounted (${renderer.rootChildren} root child, ${renderer.bodyText.length} visible chars)`,
		);
		console.log("OK: preload bridge and diagnostics IPC responded");
		console.log(
			`OK: Electron spawned isolated sidecars in two windows (protocol ${engine.readyProtocolVersion ?? "legacy"})`,
		);
		console.log(
			`OK: packaged streaming queue drained (queued=${rpcScenarios.streamingQueuedCount}, final=${rpcScenarios.streamingFinalQueuedCount})`,
		);
		console.log(
			`OK: packaged auto-compaction preserved queued follow-up (queued=${rpcScenarios.compactionQueuedCount}, retryRequests=${retryRequestCount})`,
		);
		console.log(
			`OK: packaged Window A interrupt left Window B streaming (${interrupt.windowBStreamingAfterAbort ? "isolated" : "failed"})`,
		);
		console.log(
			`OK: packaged Settings UI smoke passed (memory=${uiSmoke.memoryHeading}, skill commands switch enabled)`,
		);
		console.log("OK: packaged Diagnostics timeline rendered");
	} finally {
		cdp?.close();
		child.kill();
		await withDeadline(child.exited, 5_000, "Packaged Electron process did not exit after validation.").catch(
			() => undefined,
		);
		await fs.rm(userData, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
		smokeServer.stop();
	}
}

await run();
