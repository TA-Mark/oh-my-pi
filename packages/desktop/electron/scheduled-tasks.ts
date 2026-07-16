import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ScheduledTaskRun {
	at: string;
	status: "success" | "failed" | "skipped";
	detail?: string;
}

export interface ScheduledTask {
	id: string;
	name: string;
	workspace: string;
	prompt: string;
	intervalMinutes: number;
	maxRetries: number;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt?: string;
	lastStatus?: ScheduledTaskRun["status"];
	lastError?: string;
	runs: ScheduledTaskRun[];
}

type TaskInput = Pick<ScheduledTask, "name" | "workspace" | "prompt" | "intervalMinutes" | "maxRetries" | "enabled">;

interface ScheduledTaskStoreOptions {
	execute?: (task: ScheduledTask) => Promise<void>;
	now?: () => number;
	retryDelay?: (milliseconds: number) => Promise<void>;
}

export class ScheduledTaskStore {
	#tasks: ScheduledTask[] = [];
	#running = new Set<string>();
	#timer: NodeJS.Timeout | null = null;
	#file: string;
	#engineCommand: () => { command: string; args: string[] };
	#onChange: (tasks: ScheduledTask[]) => void;
	#executeOverride?: (task: ScheduledTask) => Promise<void>;
	#now: () => number;
	#retryDelay: (milliseconds: number) => Promise<void>;
	#children = new Set<ChildProcessWithoutNullStreams>();

	constructor(file: string, engineCommand: () => { command: string; args: string[] }, onChange: (tasks: ScheduledTask[]) => void, options: ScheduledTaskStoreOptions = {}) {
		this.#file = file;
		this.#engineCommand = engineCommand;
		this.#onChange = onChange;
		this.#executeOverride = options.execute;
		this.#now = options.now ?? Date.now;
		this.#retryDelay = options.retryDelay ?? (milliseconds => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, milliseconds);
			return promise;
		});
	}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.#file, "utf8")) as unknown;
			if (Array.isArray(parsed)) this.#tasks = parsed.filter(task => this.#valid(task)).map(task => ({ ...task, maxRetries: task.maxRetries ?? 2 }));
		} catch {
			this.#tasks = [];
		}
		this.#emit();
	}

	list(): ScheduledTask[] {
		return structuredClone(this.#tasks);
	}

	diagnostics(): { taskCount: number; runningTaskIds: string[]; tasks: Array<Pick<ScheduledTask, "id" | "name" | "enabled" | "nextRunAt" | "lastRunAt" | "lastStatus" | "lastError">> } {
		return {
			taskCount: this.#tasks.length,
			runningTaskIds: [...this.#running],
			tasks: this.#tasks.map(({ id, name, enabled, nextRunAt, lastRunAt, lastStatus, lastError }) => ({ id, name, enabled, nextRunAt, lastRunAt, lastStatus, lastError })),
		};
	}

	async upsert(input: TaskInput & { id?: string }): Promise<ScheduledTask> {
		if (!input.name.trim() || !input.workspace.trim() || !input.prompt.trim()) throw new Error("name, workspace, and prompt are required");
		if (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < 1) throw new Error("intervalMinutes must be at least 1");
		const existing = input.id ? this.#tasks.find(task => task.id === input.id) : undefined;
		const maxRetries = Math.max(0, Math.min(5, Math.round(input.maxRetries)));
		const task: ScheduledTask = existing
			? { ...existing, ...input, maxRetries, name: input.name.trim(), workspace: input.workspace.trim(), prompt: input.prompt.trim(), intervalMinutes: Math.round(input.intervalMinutes), nextRunAt: existing.nextRunAt }
			: { id: `task_${this.#now()}_${Math.random().toString(36).slice(2)}`, name: input.name.trim(), workspace: input.workspace.trim(), prompt: input.prompt.trim(), intervalMinutes: Math.round(input.intervalMinutes), maxRetries, enabled: input.enabled, nextRunAt: new Date(this.#now() + input.intervalMinutes * 60_000).toISOString(), runs: [] };
		if (existing) this.#tasks = this.#tasks.map(item => item.id === task.id ? task : item);
		else this.#tasks.push(task);
		await this.#persist();
		return structuredClone(task);
	}

	async remove(id: string): Promise<void> {
		if (this.#running.has(id)) throw new Error("task is running");
		this.#tasks = this.#tasks.filter(task => task.id !== id);
		await this.#persist();
	}

	async runNow(id: string): Promise<void> {
		const task = this.#tasks.find(item => item.id === id);
		if (!task) throw new Error("scheduled task not found");
		if (this.#running.has(id)) throw new Error("task is already running");
		await this.#run(task);
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.#tick(), 15_000);
		void this.#tick();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		for (const child of this.#children) child.kill();
	}

	async runDueTasks(): Promise<void> {
		const now = this.#now();
		const runs: Promise<void>[] = [];
		for (const task of this.#tasks) {
			if (!task.enabled || this.#running.has(task.id) || Date.parse(task.nextRunAt) > now) continue;
			runs.push(this.#run(task));
		}
		await Promise.all(runs);
	}

	async #tick(): Promise<void> { await this.runDueTasks(); }

	async #run(task: ScheduledTask): Promise<void> {
		this.#running.add(task.id);
		const at = new Date(this.#now()).toISOString();
		try {
			const stat = await fs.stat(task.workspace);
			if (!stat.isDirectory()) throw new Error("workspace is not a directory");
			await this.#executeWithRetries(task);
			this.#record(task, { at, status: "success" });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.#record(task, { at, status: "failed", detail });
			task.lastError = detail;
		}
		task.nextRunAt = new Date(this.#now() + task.intervalMinutes * 60_000).toISOString();
		this.#running.delete(task.id);
		await this.#persist();
	}

	async #executeWithRetries(task: ScheduledTask): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
			try {
				await (this.#executeOverride ? this.#executeOverride(task) : this.#execute(task));
				return;
			} catch (error) {
				lastError = error;
				if (attempt < task.maxRetries) await this.#retryDelay(1000 * 2 ** attempt);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	#execute(task: ScheduledTask): Promise<void> {
		const spec = this.#engineCommand();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, { cwd: task.workspace, stdio: ["pipe", "pipe", "pipe"] });
			this.#children.add(child);
			let buffer = "";
			let ready = false;
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				child.kill();
				this.#children.delete(child);
				error ? reject(error) : resolve();
			};
			const timeout = setTimeout(() => finish(new Error("scheduled task timed out")), 5 * 60_000);
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					try {
						const frame = JSON.parse(line) as { type?: string; command?: string; success?: boolean; event?: { type?: string } };
						if (frame.type === "ready" && !ready) {
							ready = true;
							child.stdin.write(`${JSON.stringify({ type: "prompt", message: task.prompt, id: task.id })}\n`);
						}
						if (frame.type === "response" && frame.command === "prompt" && !frame.success) finish(new Error("prompt rejected"));
						if (frame.type === "event" && frame.event?.type === "agent_end") finish();
					} catch {
						// Ignore non-JSON diagnostics from the child.
					}
				}
			});
			child.once("error", error => finish(error));
			child.once("exit", (code, signal) => {
				if (!settled) finish(new Error(`engine exited (${code ?? (signal ? `signal ${signal}` : "unknown")})`));
			});
		return promise;
	}

	#record(task: ScheduledTask, run: ScheduledTaskRun): void {
		task.lastRunAt = run.at;
		task.lastStatus = run.status;
		task.lastError = run.detail;
		task.runs = [...task.runs, run].slice(-20);
	}

	#valid(value: unknown): value is ScheduledTask {
		if (!value || typeof value !== "object") return false;
		const task = value as Partial<ScheduledTask>;
		return typeof task.id === "string" && typeof task.name === "string" && typeof task.workspace === "string" && typeof task.prompt === "string" && typeof task.intervalMinutes === "number" && typeof task.enabled === "boolean" && typeof task.nextRunAt === "string" && Array.isArray(task.runs);
	}

	async #persist(): Promise<void> {
		await fs.mkdir(path.dirname(this.#file), { recursive: true });
		const temporary = `${this.#file}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(this.#tasks, null, 2), "utf8");
		await fs.rename(temporary, this.#file);
		this.#emit();
	}

	#emit(): void { this.#onChange(this.list()); }
}
