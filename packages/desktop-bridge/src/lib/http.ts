/**
 * HTTP response helpers shared by every route module.
 * Kept in lib/ to break the routes ↔ server.ts import cycle.
 */

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
	"Access-Control-Allow-Headers": "content-type",
	"Access-Control-Max-Age": "86400",
};

export function corsPreflight(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...CORS_HEADERS },
	});
}

export function errorResponse(code: string, message: string, status = 500, detail?: string): Response {
	return jsonResponse({ code, message, detail }, status);
}
