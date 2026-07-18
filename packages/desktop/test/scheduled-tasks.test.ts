import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScheduledTaskStore } from "../electron/scheduled-tasks";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(directory => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
	);
});

async function createStore(frames: unknown[]): Promise<ScheduledTaskStore> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-scheduled-"));
	temporaryDirectories.push(directory);
	const script = path.join(directory, "fake-engine.mjs");
	await Bun.write(
		script,
		`const frames = ${JSON.stringify(frames)};
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdin.on("data", () => {
  for (const frame of frames) process.stdout.write(JSON.stringify(frame) + "\\n");
});
`,
	);
	const store = new ScheduledTaskStore(
		path.join(directory, "scheduled-tasks.json"),
		() => ({ command: process.execPath, args: [script] }),
		() => undefined,
	);
	await store.load();
	await store.upsert({
		name: "test task",
		workspace: directory,
		prompt: "run the task",
		intervalMinutes: 60,
		maxRetries: 0,
		enabled: true,
	});
	return store;
}

describe("ScheduledTaskStore engine protocol", () => {
	test("completes when OMP emits a top-level agent_end frame", async () => {
		const store = await createStore([
			{ type: "response", command: "prompt", success: true },
			{ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
		]);

		await store.runNow(store.list()[0].id);

		expect(store.list()[0].lastStatus).toBe("success");
		expect(store.list()[0].runs.at(-1)?.detail).toBeUndefined();
	});

	test("records the assistant error from agent_end instead of reporting success", async () => {
		const store = await createStore([
			{ type: "response", command: "prompt", success: true },
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
			},
		]);

		await store.runNow(store.list()[0].id);

		expect(store.list()[0].lastStatus).toBe("failed");
		expect(store.list()[0].lastError).toBe("provider unavailable");
	});
});
