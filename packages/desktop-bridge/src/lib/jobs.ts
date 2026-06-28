/**
 * Generic background job manager.
 * - Each job has an id, phase, log ring buffer, and a set of WS subscribers.
 * - Producers call emitLog/setPhase; subscribers receive serialized events.
 * - Jobs are kept in memory; restart of the bridge clears them.
 */

import type { CheckStatus, InstallStep, InstallerPhase, LogLevel, LogLine } from "../types";

const MAX_LOG_LINES = 2000;

export interface JobEvent {
	type: "log" | "phase_change";
	[key: string]: unknown;
}

type Listener = (event: JobEvent) => void;

export interface Job {
	id: string;
	phase: InstallerPhase;
	progress: number;
	currentStep: string;
	steps: InstallStep[];
	logs: LogLine[];
	startedAt: string;
	error?: { code: string; message: string; detail?: string };
	cancel?: () => void;
}

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly listeners = new Map<string, Set<Listener>>();

	create(initialSteps: Array<{ id: string; label: string }>): Job {
		const id = crypto.randomUUID();
		const job: Job = {
			id,
			phase: "installing",
			progress: 0,
			currentStep: initialSteps[0]?.id ?? "",
			steps: initialSteps.map((s, i) => ({
				id: s.id,
				label: s.label,
				status: i === 0 ? ("running" as CheckStatus) : ("pending" as CheckStatus),
				startedAt: i === 0 ? new Date().toISOString() : undefined,
			})),
			logs: [],
			startedAt: new Date().toISOString(),
		};
		this.jobs.set(id, job);
		this.listeners.set(id, new Set());
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	emitLog(jobId: string, level: LogLevel, message: string, raw?: string): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		const line: LogLine = { ts: new Date().toISOString(), level, message, raw };
		job.logs.push(line);
		if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
		this.broadcast(jobId, { type: "log", jobId, line });
	}

	setPhase(jobId: string, phase: InstallerPhase, progress: number, currentStep?: string): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		job.phase = phase;
		job.progress = Math.max(0, Math.min(100, progress));
		if (currentStep !== undefined) {
			job.currentStep = currentStep;
			for (const s of job.steps) {
				if (s.id === currentStep && s.status === "pending") {
					s.status = "running";
					s.startedAt = new Date().toISOString();
				}
			}
		}
		this.broadcast(jobId, { type: "phase_change", jobId, phase, progress });
	}

	completeStep(jobId: string, stepId: string, status: CheckStatus = "pass"): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		const step = job.steps.find((s) => s.id === stepId);
		if (!step) return;
		step.status = status;
		step.completedAt = new Date().toISOString();
	}

	fail(jobId: string, error: { code: string; message: string; detail?: string }): void {
		const job = this.jobs.get(jobId);
		if (!job) return;
		job.error = error;
		this.setPhase(jobId, "failed", job.progress);
	}

	cancel(jobId: string): boolean {
		const job = this.jobs.get(jobId);
		if (!job) return false;
		job.cancel?.();
		this.setPhase(jobId, "cancelled", job.progress);
		return true;
	}

	subscribe(jobId: string, listener: Listener): () => void {
		let bucket = this.listeners.get(jobId);
		if (!bucket) {
			bucket = new Set();
			this.listeners.set(jobId, bucket);
		}
		bucket.add(listener);
		return () => bucket?.delete(listener);
	}

	private broadcast(jobId: string, event: JobEvent): void {
		const bucket = this.listeners.get(jobId);
		if (!bucket) return;
		for (const listener of bucket) {
			try {
				listener(event);
			} catch {
				// ignore listener errors
			}
		}
	}
}
