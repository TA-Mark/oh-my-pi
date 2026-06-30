/**
 * yaml-minimal — minimal YAML reader/writer for ~/.omp/agent/config.yml.
 *
 * Supports the subset omp's CLI config actually uses:
 *   - flat scalar keys (`steeringMode: one-at-a-time`)
 *   - one-level nested maps (`theme:` then `  dark: catppuccin`)
 *   - simple inline arrays `[a, b, c]` for the `extensions` list
 *
 * Does NOT handle: anchors, multi-line strings, block scalars, comments
 * round-trip (existing comments are dropped when stringify() rewrites the file).
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function parse(text: string): Record<string, YamlValue> {
	const result: Record<string, YamlValue> = {};
	let currentSection: string | null = null;
	let currentMap: Record<string, YamlValue> | null = null;

	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();
		const colonIdx = trimmed.indexOf(":");

		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const raw = trimmed.slice(colonIdx + 1).trim();

		if (indent === 0) {
			if (currentSection && currentMap) {
				result[currentSection] = currentMap;
			}
			if (raw) {
				result[key] = parseScalar(raw);
				currentSection = null;
				currentMap = null;
			} else {
				currentSection = key;
				currentMap = {};
			}
		} else if (indent > 0 && currentSection && currentMap) {
			if (raw) {
				currentMap[key] = parseScalar(raw);
			}
		}
	}

	if (currentSection && currentMap) {
		result[currentSection] = currentMap;
	}

	return result;
}

function parseScalar(raw: string): YamlValue {
	const stripped = stripInlineComment(raw);
	if (stripped === "null" || stripped === "~" || stripped === "") return null;
	if (stripped === "true") return true;
	if (stripped === "false") return false;
	if (stripped.startsWith("[") && stripped.endsWith("]")) {
		const inner = stripped.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map(s => parseScalar(s.trim()));
	}
	if (stripped.startsWith('"') && stripped.endsWith('"')) {
		return stripped.slice(1, -1);
	}
	if (stripped.startsWith("'") && stripped.endsWith("'")) {
		return stripped.slice(1, -1);
	}
	const num = Number(stripped);
	if (!Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(stripped)) return num;
	return stripped;
}

function stripInlineComment(raw: string): string {
	// Only strip `#` preceded by whitespace, so URLs with `#anchor` survive
	// (no quoting needed in the schema we own).
	const m = raw.match(/^(.*?)(\s+#.*)?$/);
	return (m?.[1] ?? raw).trim();
}

/**
 * Stringify a config tree back to YAML matching the parser's expectations.
 * Writes top-level scalars first, then nested maps. Skips entries with `null`
 * / undefined values so the file stays tidy.
 *
 * Throws if a value's shape can't be expressed (nested > 1 level, non-scalar
 * array entries) — callers should validate first.
 */
export function stringify(obj: Record<string, YamlValue>): string {
	const lines: string[] = ["# Auto-managed by omp desktop; safe to edit, but inline comments are lost on next write.", ""];
	const scalarKeys: string[] = [];
	const mapKeys: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (isPlainObject(v)) mapKeys.push(k);
		else scalarKeys.push(k);
	}

	for (const k of scalarKeys.sort()) {
		lines.push(`${k}: ${formatScalar(obj[k] as Exclude<YamlValue, { [key: string]: YamlValue }>)}`);
	}
	if (scalarKeys.length > 0 && mapKeys.length > 0) lines.push("");

	for (const k of mapKeys.sort()) {
		const map = obj[k] as Record<string, YamlValue>;
		const entries = Object.entries(map).filter(([, v]) => v !== undefined && v !== null);
		if (entries.length === 0) continue;
		lines.push(`${k}:`);
		for (const [ck, cv] of entries) {
			if (isPlainObject(cv)) {
				throw new Error(`yaml-minimal: nested-of-nested not supported (key=${k}.${ck})`);
			}
			lines.push(`  ${ck}: ${formatScalar(cv as Exclude<YamlValue, { [key: string]: YamlValue }>)}`);
		}
		lines.push("");
	}

	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function isPlainObject(v: YamlValue): v is Record<string, YamlValue> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function formatScalar(v: Exclude<YamlValue, { [key: string]: YamlValue }>): string {
	if (v === null) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return String(v);
	if (Array.isArray(v)) {
		const parts = v.map(x => {
			if (x === null || typeof x === "object") {
				throw new Error("yaml-minimal: arrays may only contain scalars");
			}
			return formatScalar(x);
		});
		return `[${parts.join(", ")}]`;
	}
	return needsQuoting(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

function needsQuoting(s: string): boolean {
	if (s === "") return true;
	if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
	if (/^-?\d+(\.\d+)?$/.test(s)) return true;
	if (/^[\[\{>|&*!%@`]/.test(s)) return true;
	if (s.includes(": ") || s.includes(" #")) return true;
	if (s.startsWith(" ") || s.endsWith(" ")) return true;
	return false;
}
