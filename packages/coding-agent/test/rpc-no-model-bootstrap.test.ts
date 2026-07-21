import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

test("rpc-ui starts without a configured model so clients can authenticate", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-no-model-"));
	const cliEntry = path.join(import.meta.dir, "../src/cli.ts");
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, "--mode", "rpc-ui"], {
			cwd: tempRoot,
			env: {
				...process.env,
				HOME: tempRoot,
				USERPROFILE: tempRoot,
				CODEX_HOME: path.join(tempRoot, ".codex"),
				PI_CONFIG_DIR: ".omp",
				XDG_CACHE_HOME: path.join(tempRoot, ".cache"),
				XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
				XDG_DATA_HOME: path.join(tempRoot, ".data"),
				XDG_STATE_HOME: path.join(tempRoot, ".state"),
				ANTHROPIC_API_KEY: undefined,
				GEMINI_API_KEY: undefined,
				GOOGLE_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			stdin: new Blob(['{"id":"login-bootstrap","type":"get_login_providers"}\n']),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("No models available");
		const frames = stdout
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(frames.some(frame => frame.type === "ready")).toBe(true);
		expect(
			frames.some(
				frame =>
					frame.id === "login-bootstrap" &&
					frame.type === "response" &&
					frame.command === "get_login_providers" &&
					frame.success === true,
			),
		).toBe(true);
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}, 15_000);

test("rpc-ui configures gateway providers without a selected model", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-provider-config-"));
	const cliEntry = path.join(import.meta.dir, "../src/cli.ts");
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, "--mode", "rpc-ui"], {
			cwd: tempRoot,
			env: {
				...process.env,
				HOME: tempRoot,
				USERPROFILE: tempRoot,
				CODEX_HOME: path.join(tempRoot, ".codex"),
				PI_CONFIG_DIR: ".omp",
				XDG_CACHE_HOME: path.join(tempRoot, ".cache"),
				XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
				XDG_DATA_HOME: path.join(tempRoot, ".data"),
				XDG_STATE_HOME: path.join(tempRoot, ".state"),
				ANTHROPIC_API_KEY: undefined,
				GEMINI_API_KEY: undefined,
				GOOGLE_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			stdin: new Blob([
				JSON.stringify({
					id: "gateway-config",
					type: "configure_gateway_provider",
					providerId: "local-gateway",
					baseUrl: "http://127.0.0.1:65535/v1",
					api: "openai-completions",
					authHeader: true,
					disableStrictTools: true,
				}),
				"\n",
			]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("No models available");
		const frames = stdout
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const response = frames.find(
			frame =>
				frame.id === "gateway-config" &&
				frame.type === "response" &&
				frame.command === "configure_gateway_provider",
		);
		expect(response?.success).toBe(true);
		const data = response?.data as { modelsConfigPath?: string } | undefined;
		const modelsConfigPath = data?.modelsConfigPath;
		expect(typeof modelsConfigPath).toBe("string");
		if (!modelsConfigPath) throw new Error("configure_gateway_provider did not return modelsConfigPath");
		const config = YAML.parse(await Bun.file(modelsConfigPath).text()) as {
			providers?: Record<
				string,
				{ baseUrl?: string; api?: string; authHeader?: boolean; disableStrictTools?: boolean }
			>;
		};
		expect(config.providers?.["local-gateway"]).toEqual({
			baseUrl: "http://127.0.0.1:65535/v1",
			api: "openai-completions",
			authHeader: true,
			disableStrictTools: true,
		});
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}, 15_000);
