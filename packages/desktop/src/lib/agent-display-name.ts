export const DEFAULT_AGENT_DISPLAY_NAME = "Assistant";
const MAX_AGENT_DISPLAY_NAME_LENGTH = 40;

export function normalizeAgentDisplayName(value: string | null | undefined): string {
	const normalized = value?.replace(/\s+/g, " ").trim().slice(0, MAX_AGENT_DISPLAY_NAME_LENGTH);
	return normalized || DEFAULT_AGENT_DISPLAY_NAME;
}

export function agentWorkingLabel(value: string | null | undefined): string {
	return `${normalizeAgentDisplayName(value)} is working…`;
}
