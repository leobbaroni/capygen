/**
 * `harness.list` — what backends and models this machine can actually run
 * *right now*, and, when it cannot, one sentence saying why.
 *
 * Each backend is asked in the way that tells the truth about it, which is not
 * the same way for all three:
 *
 *  - **claude** — `claude --version` (the binary exists) plus a sign-in signal.
 *    The harness drives the machine's claude.ai OAuth login, never an API key
 *    (COMPAT.md: `init.apiKeySource: "none"`), so the signal is the login file
 *    the CLI writes, or one of the tokens the SDK accepts from the environment.
 *    Its *existence* is all that is read — never its contents.
 *  - **codex** — `account/read {refreshToken:true}` through a short-lived
 *    `codex app-server`, not `codex login status`. On this machine that command
 *    printed "Logged in using ChatGPT" while every model call 401'd, because it
 *    only checks that `~/.codex/auth.json` exists (docs/spikes/codex-shapes.md
 *    §3). The same probe returns the live model catalogue, so the picker offers
 *    what Codex itself lists rather than a hardcoded guess.
 *  - **api** — a stored key (Electron `safeStorage`, R21) or the documented env
 *    var, per provider. `secrets.has` is used, so no key value is read here.
 *
 * The Codex probe spawns a process, so results are cached for `CACHE_TTL_MS`:
 * the landing page, the composer's picker and Settings ▸ Harnesses all call
 * this channel, and none of them should cost a child process each.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeCodex, type CodexProbeResult } from "@capygen/engine";
import { API_PROVIDERS, type ApiProvider, type HarnessInfo } from "@capygen/shared";
import type { SecretsStore } from "./handlers.js";

export interface CliProbeResult {
  ok: boolean;
  /** First line of stdout, when the probe succeeded. */
  version?: string;
  /** Why it failed — surfaced as `HarnessInfo.reason`. */
  reason?: string;
}

/** Overridable in tests; the default actually spawns the CLI (`windowsHide`,
 *  per CLAUDE.md's Windows-first rule — no console flash for a background
 *  probe the user never asked to see). */
export type CliProbe = (command: string, args: string[]) => Promise<CliProbeResult>;

const PROBE_TIMEOUT_MS = 5_000;
/** How long a probe result is reused before the CLIs are asked again. */
export const CACHE_TTL_MS = 60_000;

export const defaultCliProbe: CliProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: `${command} CLI not found on PATH` });
          return;
        }
        resolve({ ok: true, version: stdout.toString().trim().split("\n")[0] });
      },
    );
  });

/** Claude Code models this build offers explicitly (COMPAT.md: `Options.model`
 *  is always passed — "never rely on the default"). */
const CLAUDE_MODELS = [
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
];

/**
 * Offered for an `api` agent once that provider has a key. Not a catalogue —
 * none of the three APIs has a "models the caller may use" endpoint that is
 * both cheap and honest — so this is the set capygen can price
 * (`packages/engine/src/api/pricing.ts`); an id outside it still runs, it just
 * reports `costUsd: 0`.
 */
const API_MODELS: Record<ApiProvider, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "o4-mini", label: "o4-mini" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (OpenRouter)" },
    { id: "openai/gpt-5", label: "GPT-5 (OpenRouter)" },
  ],
};

/** Env vars that stand in for a stored key, per provider (`api/keys.ts`). */
export const API_ENV_KEYS: Record<ApiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * Anything whose presence means "the Claude SDK has a credential". The OAuth
 * login file first, because that is what a signed-in `claude` CLI writes on
 * this platform; the two env tokens because the SDK takes them too.
 */
export function claudeSignInSignal(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): { signedIn: boolean; how: string } {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { signedIn: true, how: "CLAUDE_CODE_OAUTH_TOKEN" };
  if (env.ANTHROPIC_API_KEY) return { signedIn: true, how: "ANTHROPIC_API_KEY" };
  const credentials = path.join(home, ".claude", ".credentials.json");
  // Existence only. The file holds the user's OAuth tokens and capygen has no
  // reason to open it — `claude` is the only thing that should ever read it.
  if (fs.existsSync(credentials)) return { signedIn: true, how: credentials };
  return { signedIn: false, how: "" };
}

export interface HarnessListerDeps {
  /** The Claude backend's current default (Settings ▸ General). */
  defaultModel: () => string;
  probe?: CliProbe;
  /** Overridable in tests; the default spawns a real `codex app-server`. */
  probeCodexBackend?: () => Promise<CodexProbeResult>;
  /** Where a stored API key would be. Only `has` is called — never `get`. */
  secrets?: Pick<SecretsStore, "has">;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 0 disables caching (the unit tests want every call to probe). */
  cacheTtlMs?: number;
  now?: () => number;
}

/** Builds the `deps.listHarnesses` the `harness.list` IPC handler calls. */
export function createHarnessLister(deps: HarnessListerDeps): () => Promise<HarnessInfo[]> {
  const probe = deps.probe ?? defaultCliProbe;
  const probeCodexBackend = deps.probeCodexBackend ?? (() => probeCodex());
  const env = deps.env ?? process.env;
  const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  let cached: { at: number; value: Promise<HarnessInfo[]> } | null = null;

  async function build(): Promise<HarnessInfo[]> {
    const [claude, codex] = await Promise.all([
      probe("claude", ["--version"]),
      // Never lets a hung child blank the picker: `probeCodex` has its own
      // deadline and resolves with a reason instead of throwing, but a thrown
      // error here would still reject the whole channel.
      probeCodexBackend().catch(
        (err: unknown): CodexProbeResult => ({
          signedIn: false,
          models: [],
          reason: err instanceof Error ? err.message : String(err),
        }),
      ),
    ]);

    const login = claudeSignInSignal(env, deps.home);
    const claudeAvailable = claude.ok && login.signedIn;
    const claudeReason = !claude.ok
      ? (claude.reason ?? "claude CLI not found")
      : "no Claude login found — run `claude login` in a terminal";

    const codexModels = codex.models
      .filter((m) => !m.hidden)
      .map((m) => ({ id: m.id, label: m.displayName ?? m.id }));

    const withKeys: ApiProvider[] = [];
    for (const provider of API_PROVIDERS) {
      const stored = deps.secrets ? await deps.secrets.has(provider) : false;
      if (stored || env[API_ENV_KEYS[provider]]) withKeys.push(provider);
    }
    const apiModels = withKeys.flatMap((provider) => API_MODELS[provider]);

    return [
      {
        backend: "claude",
        label: "Claude Code",
        available: claudeAvailable,
        ...(claudeAvailable ? {} : { reason: claudeReason }),
        models: claudeAvailable ? CLAUDE_MODELS : [],
        defaultModel: claudeAvailable ? deps.defaultModel() : "",
      },
      {
        backend: "codex",
        label: "Codex",
        available: codex.signedIn,
        ...(codex.signedIn
          ? {}
          : { reason: codex.reason ?? "the codex app-server could not be reached" }),
        models: codex.signedIn ? codexModels : [],
        defaultModel: codex.signedIn
          ? (codex.models.find((m) => m.isDefault)?.id ?? codexModels[0]?.id ?? "")
          : "",
      },
      {
        // capygen's own agent loop against a raw provider API. There is no CLI
        // to probe and no login: a key is the whole prerequisite (R21).
        backend: "api",
        label: "API model",
        available: apiModels.length > 0,
        ...(apiModels.length > 0
          ? {}
          : { reason: "no API key stored — add one in Settings ▸ API keys" }),
        models: apiModels,
        defaultModel: apiModels[0]?.id ?? "",
      },
    ];
  }

  return async (): Promise<HarnessInfo[]> => {
    const at = now();
    if (cached && ttl > 0 && at - cached.at < ttl) return cached.value;
    // The promise is cached, not the value, so N callers during start-up share
    // one probe instead of spawning N `codex app-server` children.
    const value = build();
    cached = { at, value };
    // A failed probe must not be remembered for a minute.
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  };
}
