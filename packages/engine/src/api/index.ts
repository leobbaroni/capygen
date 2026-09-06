/**
 * The API-model backend (SPEC R9): harness, providers, prompt, keys, pricing.
 *
 * This surface is **curated, not `export *`**, and deliberately so: the package
 * has a single `"."` entry point, so everything here ends up next to the Claude
 * and Codex harnesses in `src/index.ts`, where three names would otherwise
 * collide and TypeScript would silently drop one rather than fail
 * (`src/index.ts` says the same thing about Codex). The three are aliased:
 *
 *   `DEFAULT_MAX_TOOL_OUTPUT_CHARS` → `API_DEFAULT_MAX_TOOL_OUTPUT_CHARS`
 *   `HarnessLogger`                 → `ApiHarnessLogger`
 *   `priceFor`                      → `apiPriceFor`
 *
 * The generic helpers `isRecord` / `num` / `str` from `providers/types.ts` are
 * left off entirely — `tools/types.ts` has an `isRecord` of its own, and no
 * caller outside this folder wants either. Import them from the module itself.
 */
export * from "./keys.js";
export * from "./prompt.js";

export {
  MODEL_PRICES,
  PRICES_ASSUMED_ON,
  estimateCost,
  normalizeModelId,
  priceFor as apiPriceFor,
  type CostEstimate,
  type ModelPrice,
  type TokenCounts,
} from "./pricing.js";

export {
  ZERO_USAGE,
  addRawUsage,
  assistantMessageFrom,
  type ChatContent,
  type ChatMessage,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type RawUsage,
  type StopReason,
  type ThinkingConfig,
  type ToolSchema,
} from "./providers/types.js";

export {
  AnthropicProvider,
  CACHE_CONTROL_EPHEMERAL,
  anthropicMessages,
  anthropicStopReason,
  anthropicSystem,
  anthropicTools,
  anthropicUsage,
  buildAnthropicBody,
  mapAnthropicStream,
  type AnthropicClientLike,
} from "./providers/anthropic.js";

export {
  OpenAiProvider,
  buildOpenAiBody,
  mapOpenAiStream,
  openaiInput,
  openaiStopReason,
  openaiTools,
  openaiUsage,
  supportsReasoning,
  type OpenAiClientLike,
} from "./providers/openai.js";

export {
  APP_REFERER,
  APP_TITLE,
  DEFAULT_BASE_URLS,
  OPENROUTER_BASE_URL,
  clientOptions,
  createProvider,
  loadAnthropicSdk,
  loadOpenAiSdk,
  type CreateProviderOptions,
  type ProviderSdks,
} from "./providers/index.js";

export {
  ApiHarness,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS as API_DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  readThinking,
  resolveConfig as resolveApiConfig,
  type ApiHarnessDeps,
  type HarnessLogger as ApiHarnessLogger,
} from "./ApiHarness.js";
