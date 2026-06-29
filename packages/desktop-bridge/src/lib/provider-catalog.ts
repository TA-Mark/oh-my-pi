/**
 * Static catalog of every provider omp supports.
 *
 * The omp RPC server only exposes OAuth providers via `get_login_providers`
 * (≈53 entries with a `.login` callback). The full registry has ~74 entries
 * including API-key-only providers, local servers, and discovery providers
 * that never appear in the OAuth list.
 *
 * This file is the desktop bridge's curated mirror so the Providers tab can
 * render every option the user has, classify it correctly, and tell them
 * exactly which env var or local URL to configure.
 *
 * Source of truth: packages/ai/src/registry/*. Kept in sync manually — adding
 * a provider in omp upstream requires adding it here too (caught at runtime
 * by the bridge if a model arrives under a provider id we don't know).
 */

export type ProviderType =
	| "oauth" // Browser sign-in (Anthropic, OpenAI Codex, Google, etc.)
	| "api-key" // Paste an API key (OpenAI, xAI, Mistral, Groq, …)
	| "coding-plan" // Subscription / coding plan (Cursor, Copilot, Kimi, …)
	| "local" // Self-hosted (Ollama, LM Studio, llama.cpp, vLLM)
	| "discovery"; // Auto-discovered local servers (Ollama scan etc.)

export interface ProviderCatalogEntry {
	id: string;
	name: string;
	type: ProviderType;
	/** Env var(s) the user can paste a key into. First entry is the "canonical" one. */
	envVars?: string[];
	/** Default URL for local providers; the user can override. */
	defaultUrl?: string;
	/** Short human description. */
	description?: string;
	/** Set to false when this provider needs a custom backend/account that most users don't have. */
	common?: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
	// ─── OAuth / sign-in (Frontier APIs) ──────────────────────────────────
	{
		id: "anthropic",
		name: "Anthropic (Claude)",
		type: "oauth",
		envVars: ["ANTHROPIC_API_KEY"],
		description: "Claude Opus/Sonnet/Haiku via OAuth or API key",
		common: true,
	},
	{
		id: "openai",
		name: "OpenAI",
		type: "api-key",
		envVars: ["OPENAI_API_KEY"],
		description: "GPT-4/5 and o-series via API key",
		common: true,
	},
	{
		id: "openai-codex",
		name: "OpenAI Codex",
		type: "oauth",
		description: "Sign in with OpenAI account for Codex/coding plan",
		common: true,
	},
	{
		id: "google",
		name: "Google Gemini",
		type: "api-key",
		envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
		description: "Gemini 2.5/3 Flash and Pro",
		common: true,
	},
	{
		id: "google-gemini-cli",
		name: "Google Gemini (CLI auth)",
		type: "oauth",
		description: "Sign in with Google account",
	},
	{
		id: "google-antigravity",
		name: "Google Antigravity",
		type: "oauth",
		description: "Antigravity coding plan",
	},
	{
		id: "google-vertex",
		name: "Google Vertex AI",
		type: "api-key",
		envVars: ["GOOGLE_APPLICATION_CREDENTIALS"],
		description: "Vertex AI (service account)",
	},
	{
		id: "xai",
		name: "xAI (Grok)",
		type: "api-key",
		envVars: ["XAI_API_KEY"],
		description: "Grok 4 / Grok Code Fast 1",
		common: true,
	},
	{
		id: "xai-oauth",
		name: "xAI (OAuth)",
		type: "oauth",
		description: "Sign in with xAI account",
	},
	{
		id: "mistral",
		name: "Mistral",
		type: "api-key",
		envVars: ["MISTRAL_API_KEY"],
		description: "Mistral and Codestral models",
	},
	{ id: "groq", name: "Groq", type: "api-key", envVars: ["GROQ_API_KEY"], description: "Ultra-fast inference" },
	{
		id: "cerebras",
		name: "Cerebras",
		type: "api-key",
		envVars: ["CEREBRAS_API_KEY"],
		description: "World-record token speeds",
	},
	{ id: "fireworks", name: "Fireworks", type: "api-key", envVars: ["FIREWORKS_API_KEY"] },
	{ id: "together", name: "Together AI", type: "api-key", envVars: ["TOGETHER_API_KEY"] },
	{ id: "huggingface", name: "Hugging Face", type: "api-key", envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"] },
	{ id: "nvidia", name: "NVIDIA NIM", type: "api-key", envVars: ["NVIDIA_API_KEY"] },
	{
		id: "openrouter",
		name: "OpenRouter",
		type: "api-key",
		envVars: ["OPENROUTER_API_KEY"],
		description: "Single API for many providers",
		common: true,
	},
	{ id: "synthetic", name: "Synthetic", type: "api-key", envVars: ["SYNTHETIC_API_KEY"] },
	{
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		type: "api-key",
		envVars: ["AI_GATEWAY_API_KEY"],
	},
	{
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		type: "api-key",
		envVars: ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
	},
	{ id: "wafer-serverless", name: "Wafer Serverless", type: "oauth", envVars: ["WAFER_SERVERLESS_API_KEY"] },
	{
		id: "perplexity",
		name: "Perplexity",
		type: "oauth",
		envVars: ["PERPLEXITY_API_KEY"],
		description: "Web-aware research models",
	},
	{ id: "azure", name: "Azure OpenAI", type: "api-key", envVars: ["AZURE_OPENAI_API_KEY"] },
	{ id: "amazon-bedrock", name: "Amazon Bedrock", type: "api-key", envVars: ["AWS_BEARER_TOKEN_BEDROCK"] },
	{ id: "deepseek", name: "DeepSeek", type: "api-key", envVars: ["DEEPSEEK_API_KEY"] },
	{ id: "minimax", name: "MiniMax", type: "api-key", envVars: ["MINIMAX_API_KEY"] },
	{ id: "aimlapi", name: "AI/ML API", type: "api-key", envVars: ["AIMLAPI_API_KEY"] },

	// ─── Coding plans (subscription routed via /login) ────────────────────
	{
		id: "cursor",
		name: "Cursor",
		type: "coding-plan",
		envVars: ["CURSOR_ACCESS_TOKEN"],
		description: "Sign in with Cursor account (subscription)",
	},
	{
		id: "github-copilot",
		name: "GitHub Copilot",
		type: "coding-plan",
		envVars: ["COPILOT_GITHUB_TOKEN"],
		description: "Sign in with GitHub account",
		common: true,
	},
	{ id: "gitlab-duo", name: "GitLab Duo", type: "coding-plan", envVars: ["GITLAB_TOKEN"] },
	{ id: "kimi-code", name: "Kimi Code", type: "coding-plan", description: "Moonshot Kimi coding plan" },
	{ id: "moonshot", name: "Moonshot", type: "api-key", envVars: ["MOONSHOT_API_KEY"] },
	{ id: "minimax-code", name: "MiniMax Coding Plan", type: "coding-plan", envVars: ["MINIMAX_CODE_API_KEY"] },
	{ id: "minimax-code-cn", name: "MiniMax Coding Plan (CN)", type: "coding-plan", envVars: ["MINIMAX_CODE_CN_API_KEY"] },
	{ id: "alibaba-coding-plan", name: "Alibaba Coding Plan", type: "coding-plan", envVars: ["ALIBABA_CODING_PLAN_API_KEY"] },
	{ id: "qwen-portal", name: "Qwen Portal", type: "coding-plan", envVars: ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"] },
	{ id: "zai", name: "Z.AI / GLM Coding Plan", type: "coding-plan", envVars: ["ZAI_API_KEY"] },
	{ id: "zhipu-coding-plan", name: "Zhipu Coding Plan", type: "coding-plan", envVars: ["ZHIPU_API_KEY"] },
	{ id: "xiaomi", name: "Xiaomi MiMo", type: "api-key", envVars: ["XIAOMI_API_KEY"] },
	{ id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (AMS)", type: "coding-plan", envVars: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"] },
	{ id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan (CN)", type: "coding-plan", envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"] },
	{ id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan (SGP)", type: "coding-plan", envVars: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"] },
	{ id: "qianfan", name: "Qianfan", type: "api-key", envVars: ["QIANFAN_API_KEY"] },
	{ id: "nanogpt", name: "NanoGPT", type: "api-key", envVars: ["NANO_GPT_API_KEY"] },
	{ id: "venice", name: "Venice", type: "api-key", envVars: ["VENICE_API_KEY"] },
	{ id: "kilo", name: "Kilo", type: "api-key", envVars: ["KILO_API_KEY"] },
	{ id: "zenmux", name: "ZenMux", type: "api-key", envVars: ["ZENMUX_API_KEY"] },
	{ id: "opencode-go", name: "OpenCode Go", type: "coding-plan", envVars: ["OPENCODE_API_KEY"] },
	{ id: "opencode-zen", name: "OpenCode Zen", type: "coding-plan", envVars: ["OPENCODE_API_KEY"] },
	{ id: "devin", name: "Devin", type: "coding-plan", envVars: ["DEVIN_API_KEY"] },
	{ id: "firepass", name: "Fire Pass", type: "api-key", envVars: ["FIREPASS_API_KEY"], description: "Fireworks Kimi K2.6 Turbo subscription" },
	{ id: "openai-codex-device", name: "OpenAI Codex (device)", type: "oauth" },
	{ id: "sakana", name: "Sakana", type: "api-key", envVars: ["SAKANA_API_KEY", "FUGU_API_KEY"] },
	{ id: "umans", name: "Umans", type: "api-key", envVars: ["UMANS_AI_CODING_PLAN_API_KEY"] },

	// ─── Search / utility (still in the registry) ─────────────────────────
	{ id: "tavily", name: "Tavily (search)", type: "api-key", envVars: ["TAVILY_API_KEY"] },
	{ id: "kagi", name: "Kagi (search)", type: "api-key", envVars: ["KAGI_API_KEY"] },
	{ id: "parallel", name: "Parallel (search)", type: "api-key", envVars: ["PARALLEL_API_KEY"] },

	// ─── Local / self-hosted ──────────────────────────────────────────────
	{
		id: "ollama",
		name: "Ollama",
		type: "local",
		defaultUrl: "http://127.0.0.1:11434",
		description: "Local LLM runtime (auto-discovered)",
		common: true,
	},
	{
		id: "ollama-cloud",
		name: "Ollama Cloud",
		type: "oauth",
		envVars: ["OLLAMA_CLOUD_API_KEY"],
	},
	{
		id: "lm-studio",
		name: "LM Studio",
		type: "local",
		defaultUrl: "http://127.0.0.1:1234",
		description: "Local OpenAI-compatible server",
	},
	{
		id: "llama-cpp",
		name: "llama.cpp",
		type: "local",
		defaultUrl: "http://127.0.0.1:8080",
		description: "Direct llama.cpp server",
	},
	{
		id: "vllm",
		name: "vLLM",
		type: "local",
		defaultUrl: "http://127.0.0.1:8000",
		description: "vLLM inference server",
	},
	{
		id: "litellm",
		name: "LiteLLM",
		type: "api-key",
		envVars: ["LITELLM_API_KEY"],
		description: "Proxy router for many providers",
	},
];

/** Total number of providers — useful for UI counters. */
export const PROVIDER_CATALOG_COUNT = PROVIDER_CATALOG.length;
