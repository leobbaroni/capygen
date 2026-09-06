/**
 * How an API key reaches a provider client (SPEC R21).
 *
 * The engine **never reads a key from disk**. Keys live in Electron
 * `safeStorage` (Windows DPAPI), which only the main process can open, so the
 * desktop injects a `KeyProvider` and the harness asks it. Everything here is
 * an interface plus one env-var fallback, and nothing in this file logs a value.
 *
 * Order: the injected provider first (the user's stored key), then the
 * environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) so a
 * developer running the live script from a shell needs no UI.
 */
import type { ApiProvider } from "@capygen/shared";
import type { EnvRecord } from "../env.js";

export interface KeyProvider {
  /** The key for this provider, or null when the user has not stored one. */
  getKey(provider: ApiProvider): Promise<string | null> | string | null;
}

export const ENV_KEY_NAMES: Record<ApiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Reads the documented env var. Used as a fallback, and on its own by scripts. */
export function envKeyProvider(env: EnvRecord = process.env): KeyProvider {
  return {
    getKey(provider) {
      const value = env[ENV_KEY_NAMES[provider]];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    },
  };
}

/** Always empty — the default when the desktop injects nothing. */
export const NO_KEYS: KeyProvider = { getKey: () => null };

export interface ResolveKeyOptions {
  keys?: KeyProvider;
  env?: EnvRecord;
}

/** Injected provider first, environment second, null when neither has one. */
export async function resolveApiKey(
  provider: ApiProvider,
  options: ResolveKeyOptions = {},
): Promise<string | null> {
  const fromProvider = options.keys ? await options.keys.getKey(provider) : null;
  if (typeof fromProvider === "string" && fromProvider.trim().length > 0) {
    return fromProvider.trim();
  }
  return envKeyProvider(options.env ?? process.env).getKey(provider) as string | null;
}

/**
 * A key with its middle removed — the only form a key may take in a log line.
 * `sk-ant-api03-abcdef…wxyz` → `sk-ant…wxyz`.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
