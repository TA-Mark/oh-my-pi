/**
 * yaml-minimal — minimal YAML parser for reading config.yml.
 * Only handles flat key: value and one-level nested maps.
 * Does NOT handle arrays, multi-line strings, anchors, etc.
 */

export function parse(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentSection: string | null = null;
	let currentMap: Record<string, string> | null = null;

	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();
		const colonIdx = trimmed.indexOf(":");

		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const value = trimmed.slice(colonIdx + 1).trim();

		if (indent === 0) {
			if (currentSection && currentMap) {
				result[currentSection] = currentMap;
			}
			if (value) {
				result[key] = value;
				currentSection = null;
				currentMap = null;
			} else {
				currentSection = key;
				currentMap = {};
			}
		} else if (indent > 0 && currentSection && currentMap) {
			if (value) {
				currentMap[key] = value;
			}
		}
	}

	if (currentSection && currentMap) {
		result[currentSection] = currentMap;
	}

	return result;
}
