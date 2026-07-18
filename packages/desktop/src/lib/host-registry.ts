import type {
	DesktopHostToolConfig,
	HostToolCallRequest,
	HostToolResultPayload,
	HostUriRequest,
	HostUriResultFrame,
	WorkspaceFileContent,
} from "./rpc-protocol";

export interface HostExecutionDependencies {
	openExternalUrl: (url: string) => Promise<void>;
	revealItem: (target: string) => Promise<void>;
	writeClipboardText: (text: string) => Promise<void>;
	readWorkspaceFile: (path: string) => Promise<WorkspaceFileContent>;
}

export type HostUriResolution = Omit<HostUriResultFrame, "type" | "id">;

export interface DesktopHostRegistryConfig {
	tools: DesktopHostToolConfig[];
	workspaceUriEnabled: boolean;
}

const HOST_ACTIONS = new Set<DesktopHostToolConfig["action"]>([
	"open_external_url",
	"reveal_path",
	"copy_text",
	"read_workspace_file",
]);

export function parseDesktopHostRegistry(value: unknown): DesktopHostRegistryConfig {
	if (!value || typeof value !== "object") return { tools: [], workspaceUriEnabled: false };
	const raw = value as { tools?: unknown; workspaceUriEnabled?: unknown };
	const tools = Array.isArray(raw.tools)
		? raw.tools.flatMap(item => {
				if (!item || typeof item !== "object") return [];
				const tool = item as Partial<DesktopHostToolConfig>;
				if (
					typeof tool.name !== "string" ||
					!tool.name.trim() ||
					typeof tool.description !== "string" ||
					!tool.description.trim() ||
					!tool.parameters ||
					typeof tool.parameters !== "object" ||
					Array.isArray(tool.parameters) ||
					!tool.action ||
					!HOST_ACTIONS.has(tool.action)
				)
					return [];
				const loadMode: DesktopHostToolConfig["loadMode"] =
					tool.loadMode === "eager" || tool.loadMode === "explicit" ? tool.loadMode : "discoverable";
				return [
					{
						name: tool.name.trim(),
						label: typeof tool.label === "string" ? tool.label : undefined,
						description: tool.description.trim(),
						parameters: tool.parameters,
						hidden: tool.hidden === true,
						loadMode,
						action: tool.action,
						requiresApproval: tool.requiresApproval !== false,
					},
				];
			})
		: [];
	return { tools, workspaceUriEnabled: raw.workspaceUriEnabled === true };
}

export function hostResult(text: string, isError = false): HostToolResultPayload {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function hostArgument(request: HostToolCallRequest, key: string): string {
	const value = request.arguments[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Host tool argument "${key}" must be a non-empty string`);
	}
	return value;
}

export async function executeDesktopHostTool(
	config: DesktopHostToolConfig,
	request: HostToolCallRequest,
	deps: HostExecutionDependencies,
): Promise<HostToolResultPayload> {
	switch (config.action) {
		case "open_external_url": {
			const url = hostArgument(request, "url");
			await deps.openExternalUrl(url);
			return hostResult(`Opened ${url}`);
		}
		case "reveal_path": {
			const target = hostArgument(request, "path");
			await deps.revealItem(target);
			return hostResult(`Revealed ${target}`);
		}
		case "copy_text": {
			await deps.writeClipboardText(hostArgument(request, "text"));
			return hostResult("Copied text to the desktop clipboard");
		}
		case "read_workspace_file": {
			const file = await deps.readWorkspaceFile(hostArgument(request, "path"));
			return hostResult(file.content);
		}
	}
}

export async function resolveWorkspaceHostUri(
	request: HostUriRequest,
	readWorkspaceFile: (path: string) => Promise<WorkspaceFileContent>,
): Promise<HostUriResolution> {
	if (request.operation !== "read") throw new Error("workspace:// is read-only");
	const url = new URL(request.url);
	if (url.protocol !== "workspace:") throw new Error(`Unsupported host URI scheme: ${url.protocol}`);
	const combinedPath = url.hostname ? `${url.hostname}${url.pathname}` : url.pathname;
	const relativePath = decodeURIComponent(combinedPath).replace(/^[/\\]+/, "");
	if (!relativePath) throw new Error("workspace:// requires a file path");
	const file = await readWorkspaceFile(relativePath);
	return { content: file.content, contentType: "text/plain", immutable: false };
}
