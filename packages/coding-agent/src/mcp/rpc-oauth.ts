import type { OAuthAuthInfo, OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import { connectToServer, disconnectServer } from "./client";
import type { MCPManager } from "./manager";
import { lookupMcpOAuthCredentialForServer, removeManagedMcpOAuthCredential } from "./oauth-credentials";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes } from "./oauth-discovery";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface RpcMcpOAuthController {
	onAuth(info: OAuthAuthInfo): void;
	onProgress(message: string): void;
	onManualCodeInput(): Promise<string>;
}

export interface RpcMcpOAuthResult {
	credentialId: string;
	config: MCPServerConfig;
	persistConfig: boolean;
}

function withoutOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

export async function resolveRpcMcpOAuthEndpoints(manager: MCPManager, config: MCPServerConfig) {
	if (config.type !== "http" && config.type !== "sse") {
		throw new Error("OMP-managed MCP OAuth requires an HTTP or SSE server transport");
	}

	let connectionError: Error | undefined;
	try {
		const resolved = await manager.prepareConfig(config, { oauth: false });
		const connection = await connectToServer(`rpc_oauth_probe_${Date.now()}`, resolved);
		await disconnectServer(connection);
		throw new Error("Server connection succeeded without OAuth; reauthorization is not required");
	} catch (error) {
		if (error instanceof Error && error.message.includes("reauthorization is not required")) throw error;
		connectionError = error instanceof Error ? error : new Error(String(error));
	}

	const authResult = analyzeAuthError(connectionError, config.url);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	if (!oauth) throw new Error("Could not discover OAuth endpoints from the MCP server response");
	return oauth;
}

export async function reauthorizeRpcMcpServer(
	config: MCPServerConfig,
	manager: MCPManager,
	authStorage: AuthStorage,
	callbacks: RpcMcpOAuthController,
): Promise<RpcMcpOAuthResult> {
	const currentAuth = config.auth;
	const baseConfig = withoutOAuthAuth(config);
	const runtimeConfig = expandEnvVarsDeep(baseConfig);
	const oauth = await resolveRpcMcpOAuthEndpoints(manager, runtimeConfig);
	const serverUrl = runtimeConfig.type === "http" || runtimeConfig.type === "sse" ? runtimeConfig.url : undefined;
	const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
	const configuredClientId = config.oauth?.clientId ?? currentAuth?.clientId;
	const flowClientId = oauth.clientId ?? configuredClientId ?? existingCredential?.clientId;
	const storedClientSecret =
		existingCredential && existingCredential.clientId === flowClientId ? existingCredential.clientSecret : undefined;
	const userClientSecret = config.oauth?.clientSecret ?? currentAuth?.clientSecret;
	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource = oauth.resource ?? currentAuthResource ?? serverUrl;
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;
	const timeoutSignal = AbortSignal.timeout(5 * 60 * 1000);
	const controller: OAuthController = {
		onAuth: callbacks.onAuth,
		onProgress: callbacks.onProgress,
		onManualCodeInput: callbacks.onManualCodeInput,
		signal: timeoutSignal,
	};
	const flow = new MCPOAuthFlow(
		{
			authorizationUrl: oauth.authorizationUrl,
			tokenUrl: oauth.tokenUrl,
			registrationUrl: oauth.registrationUrl,
			clientId: flowClientId,
			clientSecret: userClientSecret ?? storedClientSecret,
			scopes: oauth.scopes,
			prompt: config.oauth?.prompt,
			redirectUri: config.oauth?.redirectUri,
			callbackPort: config.oauth?.callbackPort,
			callbackPath: config.oauth?.callbackPath,
			resource: oauthResource,
			stripSameOriginResource: oauthResourceIsFallback,
		},
		controller,
	);
	const credentials = await flow.login();
	const credentialId = serverUrl
		? mcpOAuthCredentialId(serverUrl)
		: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
	const oauthCredential: MCPStoredOAuthCredential = {
		type: "oauth",
		...credentials,
		tokenUrl: oauth.tokenUrl,
		clientId: flow.resolvedClientId ?? flowClientId,
		clientSecret: flow.registeredClientSecret ?? userClientSecret ?? storedClientSecret,
		resource: flow.resource,
		authorizationUrl: flow.authorizationUrl,
	};
	await authStorage.set(credentialId, oauthCredential);
	if (currentAuth?.type === "oauth" && currentAuth.credentialId !== credentialId) {
		await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
	}

	const clientId = flow.resolvedClientId ?? flowClientId ?? config.oauth?.clientId;
	const resource = flow.resource ?? (oauthResourceIsFallback ? undefined : oauthResource) ?? currentAuth?.resource;
	const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
	const persistConfig = currentAuth !== undefined || credentialId !== urlKeyedId;
	const updated: MCPServerConfig = persistConfig
		? {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId,
					tokenUrl: oauth.tokenUrl,
					clientId,
					clientSecret: userClientSecret,
					resource,
				},
				oauth: { ...baseConfig.oauth, clientId },
			}
		: baseConfig;
	return { credentialId, config: updated, persistConfig };
}
