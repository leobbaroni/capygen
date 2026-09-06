/**
 * Provider construction: config + key → a `Provider`.
 *
 * Both SDKs are loaded with a runtime `import()`, the same pattern
 * `claude/sdk.ts` and `mcp/client/sdk.ts` use. A session on a `claude` or
 * `codex` backend then never pays for loading them at all, and a test can pass
 * a fake client without either package being touched.
 *
 * OpenRouter is not a third SDK: it is the OpenAI Responses wire protocol at a
 * different base URL, with two headers the service uses for attribution
 * (`HTTP-Referer`, `X-Title`). The provider tag stays `openrouter` so usage
 * rows and the diagnostics pane can tell them apart.
 */
import type { ApiProvider } from "@capygen/shared";
import { AnthropicProvider, type AnthropicClientLike } from "./anthropic.js";
import { OpenAiProvider, type OpenAiClientLike } from "./openai.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export * from "./anthropic.js";
export * from "./openai.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const APP_REFERER = "https://github.com/leobbaroni/capygen";
export const APP_TITLE = "capygen";

/** Default base URLs, so the diagnostics pane can say where a turn went. */
export const DEFAULT_BASE_URLS: Record<ApiProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: OPENROUTER_BASE_URL,
};

export interface CreateProviderOptions {
  provider: ApiProvider;
  /** Never logged, never stored here — see `api/keys.ts`. */
  apiKey: string;
  /** Overrides the provider's default endpoint (self-hosted gateways). */
  baseUrl?: string | undefined;
  /** Test seam: skip the SDK entirely. */
  anthropicClient?: AnthropicClientLike;
  openaiClient?: OpenAiClientLike;
}

/** The two constructors we need, behind an interface a test can supply. */
export interface ProviderSdks {
  Anthropic: new (options: Record<string, unknown>) => AnthropicClientLike;
  OpenAI: new (options: Record<string, unknown>) => OpenAiClientLike;
}

let anthropicSdk: Promise<ProviderSdks["Anthropic"]> | null = null;
let openaiSdk: Promise<ProviderSdks["OpenAI"]> | null = null;

export function loadAnthropicSdk(): Promise<ProviderSdks["Anthropic"]> {
  anthropicSdk ??= import("@anthropic-ai/sdk")
    .then((mod) => mod.default as unknown as ProviderSdks["Anthropic"])
    .catch((err: unknown) => {
      anthropicSdk = null;
      throw err;
    });
  return anthropicSdk;
}

export function loadOpenAiSdk(): Promise<ProviderSdks["OpenAI"]> {
  openaiSdk ??= import("openai")
    .then((mod) => mod.default as unknown as ProviderSdks["OpenAI"])
    .catch((err: unknown) => {
      openaiSdk = null;
      throw err;
    });
  return openaiSdk;
}

/**
 * The constructor options for each SDK client, as pure data — so a test can
 * assert the OpenRouter base URL and attribution headers without constructing a
 * client or reaching the network. Never log the result: it holds the key.
 */
export function clientOptions(options: CreateProviderOptions): Record<string, unknown> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[options.provider];
  if (options.provider === "anthropic") {
    return {
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    };
  }
  return {
    apiKey: options.apiKey,
    baseURL: baseUrl,
    ...(options.provider === "openrouter"
      ? { defaultHeaders: { "HTTP-Referer": APP_REFERER, "X-Title": APP_TITLE } }
      : {}),
  };
}

export async function createProvider(options: CreateProviderOptions): Promise<Provider> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[options.provider];
  const init = clientOptions(options);

  if (options.provider === "anthropic") {
    const client = options.anthropicClient ?? new (await loadAnthropicSdk())(init);
    return new AnthropicProvider(client, baseUrl);
  }
  const client = options.openaiClient ?? new (await loadOpenAiSdk())(init);
  return new OpenAiProvider(client, options.provider, baseUrl);
}
