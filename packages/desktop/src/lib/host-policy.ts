const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_CLIPBOARD_BYTES = 1024 * 1024;

export function validateHostArguments(argumentsValue: Record<string, unknown>): string | null {
	if (new TextEncoder().encode(JSON.stringify(argumentsValue)).byteLength > MAX_ARGUMENT_BYTES)
		return "Host tool arguments exceed 64 KiB";
	return null;
}

export function validateExternalUrl(value: unknown): string | null {
	if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return "Only http(s) URLs are allowed";
	return null;
}

export function validateClipboardText(value: unknown): string | null {
	if (typeof value !== "string") return "text is required";
	if (new TextEncoder().encode(value).byteLength > MAX_CLIPBOARD_BYTES) return "Clipboard text exceeds 1 MiB";
	return null;
}
