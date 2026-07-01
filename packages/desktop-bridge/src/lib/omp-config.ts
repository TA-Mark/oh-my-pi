/**
 * omp-config — read/write `~/.omp/agent/config.yml` from the bridge.
 *
 * Single source of truth shared with the omp CLI: any value the desktop UI
 * persists ends up in the same file `omp config set <key> <value>` would
 * write to, so settings flow either direction without a sync layer.
 *
 * Concurrency: writes go through a write-temp-then-rename atomic, plus an
 * in-process mutex to serialise PUT requests. Cross-process race (CLI editing
 * while desktop is also open) is best-effort — read-before-write reduces the
 * window but a full file lock isn't worth the complexity for this surface.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpConfig } from "../types";
import { parse as parseYaml, stringify as stringifyYaml, type YamlValue } from "./yaml-minimal";

/**
 * Top-level keys that map directly to scalar values. Used by setKey to decide
 * whether the dot-path navigates into a nested map.
 */
const SCALAR_KEYS = new Set([
	"steeringMode",
	"followUpMode",
	"interruptMode",
]);

const NESTED_KEYS = new Set([
	"theme",
	"modelRoles",
	"tools",
	"debug",
	"images",
	"searxng",
	"memory",
]);

const ARRAY_KEYS = new Set([
	"extensions",
]);

const NESTED_MAP_KEYS = new Set([
	"skills",
]);

export function configDir(): string {
	const explicit = process.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return join(home, ".omp", "agent");
}

export function configPath(): string {
	return join(configDir(), "config.yml");
}

let writeMutex: Promise<void> = Promise.resolve();

/**
 * Read the on-disk config and project it onto the typed `OmpConfig` shape.
 * Unknown keys in the YAML are dropped from the typed view but preserved on
 * disk (we re-read the raw tree on every write).
 */
export function readConfig(): OmpConfig {
	const raw = readRaw();
	return projectConfig(raw);
}

/**
 * Get a single value by dot-path (`modelRoles.default`, `theme.dark`, etc).
 * Returns `null` if the path doesn't resolve.
 */
export function getKey(path: string): YamlValue | null {
	const raw = readRaw();
	return resolvePath(raw, path);
}

/**
 * Set a single value by dot-path. Validates that the path is a known key
 * (top-level + recognised nested subkey for nested maps). Throws on unknown
 * top-level keys or arrays-of-objects.
 */
export async function setKey(path: string, value: YamlValue): Promise<OmpConfig> {
	return await runExclusive(async () => {
		const raw = readRaw();
		applyPath(raw, path, value);
		validate(raw);
		await writeAtomic(raw);
		return projectConfig(raw);
	});
}

/**
 * Reset (delete) a key, falling back to omp's built-in default at runtime.
 */
export async function resetKey(path: string): Promise<OmpConfig> {
	return await runExclusive(async () => {
		const raw = readRaw();
		deletePath(raw, path);
		await writeAtomic(raw);
		return projectConfig(raw);
	});
}

// ─── Implementation ────────────────────────────────────────────────────────

function readRaw(): Record<string, YamlValue> {
	try {
		const text = readFileSync(configPath(), "utf8");
		return parseYaml(text);
	} catch {
		return {};
	}
}

function projectConfig(raw: Record<string, YamlValue>): OmpConfig {
	const out: OmpConfig = {};
	if (isObject(raw.theme)) out.theme = filterStrings(raw.theme, ["dark", "light"]);
	if (isObject(raw.modelRoles)) {
		out.modelRoles = filterStrings(raw.modelRoles, ["default", "smol", "slow", "plan", "commit"]) as OmpConfig["modelRoles"];
	}
	if (typeof raw.steeringMode === "string") out.steeringMode = raw.steeringMode as OmpConfig["steeringMode"];
	if (typeof raw.followUpMode === "string") out.followUpMode = raw.followUpMode as OmpConfig["followUpMode"];
	if (typeof raw.interruptMode === "string") out.interruptMode = raw.interruptMode as OmpConfig["interruptMode"];
	if (isObject(raw.tools)) {
		const mode = raw.tools.discoveryMode;
		if (mode === "auto" || mode === "manual") out.tools = { discoveryMode: mode };
	}
	if (isObject(raw.debug)) {
		const enabled = raw.debug.enabled;
		if (typeof enabled === "boolean") out.debug = { enabled };
	}
	if (Array.isArray(raw.extensions)) {
		out.extensions = raw.extensions.filter((v): v is string => typeof v === "string");
	}
	if (isObject(raw.skills)) {
		const skills: Record<string, boolean> = {};
		for (const [k, v] of Object.entries(raw.skills)) {
			if (typeof v === "boolean") skills[k] = v;
		}
		out.skills = skills;
	}
	if (isObject(raw.images)) {
		const auto = raw.images.autoResize;
		if (typeof auto === "boolean") out.images = { autoResize: auto };
	}
	if (isObject(raw.searxng)) {
		out.searxng = filterStrings(raw.searxng, ["endpoint", "token", "basicUsername", "basicPassword"]);
	}
	return out;
}

function filterStrings<K extends string>(src: Record<string, YamlValue>, keys: readonly K[]): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {};
	for (const k of keys) {
		const v = src[k];
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

function isObject(v: YamlValue | undefined): v is Record<string, YamlValue> {
	return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

function resolvePath(raw: Record<string, YamlValue>, path: string): YamlValue | null {
	const parts = path.split(".");
	let cur: YamlValue = raw;
	for (const part of parts) {
		if (!isObject(cur)) return null;
		const next: YamlValue | undefined = cur[part];
		if (next === undefined) return null;
		cur = next;
	}
	return cur;
}

function applyPath(raw: Record<string, YamlValue>, path: string, value: YamlValue): void {
	const parts = path.split(".");
	const top = parts[0]!;
	assertKnownTopKey(top);

	if (parts.length === 1) {
		// top-level assignment
		if (NESTED_KEYS.has(top) && !isObject(value)) {
			throw new Error(`config key '${top}' must be a map`);
		}
		if (ARRAY_KEYS.has(top) && !Array.isArray(value)) {
			throw new Error(`config key '${top}' must be an array`);
		}
		if (SCALAR_KEYS.has(top) && typeof value !== "string") {
			throw new Error(`config key '${top}' must be a string`);
		}
		raw[top] = value;
		return;
	}

	// nested path — only allowed for keys in NESTED_KEYS or NESTED_MAP_KEYS
	if (!NESTED_KEYS.has(top) && !NESTED_MAP_KEYS.has(top)) {
		throw new Error(`config key '${top}' does not accept nested values`);
	}
	if (parts.length > 2) {
		throw new Error(`config supports only one level of nesting (got ${path})`);
	}

	let nested = raw[top];
	if (!isObject(nested)) {
		nested = {};
		raw[top] = nested;
	}
	nested[parts[1]!] = value;
}

function deletePath(raw: Record<string, YamlValue>, path: string): void {
	const parts = path.split(".");
	if (parts.length === 1) {
		delete raw[parts[0]!];
		return;
	}
	const parent = raw[parts[0]!];
	if (isObject(parent)) {
		delete parent[parts[1]!];
		if (Object.keys(parent).length === 0) delete raw[parts[0]!];
	}
}

function assertKnownTopKey(key: string): void {
	if (SCALAR_KEYS.has(key)) return;
	if (NESTED_KEYS.has(key)) return;
	if (ARRAY_KEYS.has(key)) return;
	if (NESTED_MAP_KEYS.has(key)) return;
	throw new Error(`unknown config key '${key}'`);
}

function validate(raw: Record<string, YamlValue>): void {
	// Whitelist for enumerable scalar settings, mirrors the omp CLI schema.
	const enums: Record<string, readonly string[]> = {
		steeringMode: ["one-at-a-time", "all"],
		followUpMode: ["one-at-a-time", "all"],
		interruptMode: ["immediate", "wait"],
	};
	for (const [k, allowed] of Object.entries(enums)) {
		const v = raw[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || !allowed.includes(v)) {
			throw new Error(`invalid value for ${k}: ${JSON.stringify(v)} (expected one of ${allowed.join(", ")})`);
		}
	}
	if (isObject(raw.tools) && raw.tools.discoveryMode !== undefined) {
		const allowed = ["auto", "manual"];
		if (typeof raw.tools.discoveryMode !== "string" || !allowed.includes(raw.tools.discoveryMode)) {
			throw new Error(`invalid value for tools.discoveryMode: ${JSON.stringify(raw.tools.discoveryMode)}`);
		}
	}
}

async function writeAtomic(raw: Record<string, YamlValue>): Promise<void> {
	const dir = configDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const final = configPath();
	const tmp = `${final}.${process.pid}.tmp`;
	const text = stringifyYaml(raw);
	writeFileSync(tmp, text, { encoding: "utf8" });
	try {
		renameSync(tmp, final);
	} catch {
		// Windows can refuse rename across filesystems / when target is locked;
		// fall back to plain write so the user doesn't lose the change. The
		// non-atomic write is best-effort but better than dropping the change.
		writeFileSync(final, text, { encoding: "utf8" });
	}
}

async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const prev = writeMutex;
	let release!: () => void;
	writeMutex = new Promise(r => {
		release = r;
	});
	try {
		await prev;
		return await fn();
	} finally {
		release();
	}
}

