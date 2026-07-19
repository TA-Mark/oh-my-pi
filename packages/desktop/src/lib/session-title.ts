export function taskTitleFromPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	if (normalized.length <= 52) return normalized;
	const shortened = normalized.slice(0, 49);
	const wordBoundary = shortened.lastIndexOf(" ");
	return `${(wordBoundary > 28 ? shortened.slice(0, wordBoundary) : shortened).trimEnd()}...`;
}

export function autoTaskTitle(sessionName: string | undefined, prompt: string): string | undefined {
	if (sessionName || !prompt.trim()) return undefined;
	return taskTitleFromPrompt(prompt);
}
