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
import { probeCodex, resolveBackendHomes, type CodexProbeResult } from "@capygen/engine";
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

/** What `claudeSignInSignal` answers. `reason` is set only when it says no. */
export interface ClaudeSignInSignal {
  signedIn: boolean;
  /** Which signal said yes — an env var name or the credentials path. Never a token. */
  how: string;
  /** `HarnessInfo.reason` when the answer is no and there is more to say. */
  reason?: string;
}

/**
 * Anything whose presence means "the Claude SDK has a credential". The OAuth
 * login file first, because that is what a signed-in `claude` CLI writes on
 * this platform; the two env tokens because the SDK takes them too.
 */
export function claudeSignInSignal(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ClaudeSignInSignal {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { signedIn: true, how: "CLAUDE_CODE_OAUTH_TOKEN" };
  if (env.ANTHROPIC_API_KEY) return { signedIn: true, how: "ANTHROPIC_API_KEY" };
  // [C] `resolveBackendHomes`, not `join(home, ".claude")`: `CLAUDE_CONFIG_DIR`
  // relocates the *whole* Claude home, credentials included, and capygen sets
  // it for its own children whenever `CAPYGEN_CLAUDE_CONFIG_DIR` is given
  // (`win/configHomes.ts`). Reading the fixed `~/.claude` under an isolated
  // home made `harness.list` report a login the SDK would not actually find —
  // the picker offering Claude, and the first turn failing with a 401.
  const credentials = path.join(
    resolveBackendHomes(env, home).claude,
    ".credentials.json",
  );
  if (!fs.existsSync(credentials)) return { signedIn: false, how: "" };
  return claudeCredentialSignal(credentials);
}

/**
 * [C] Existence is not the signal it looks like.
 *
 * The first version of this function stopped at `existsSync`, on the grounds
 * that the file holds the user's OAuth tokens and capygen has no business
 * reading them. That is still the rule — nothing below is returned, logged or
 * copied — but "the file is there" turned out to be a different claim from
 * "there is a credential in it". A Claude Code host that refreshes auth for
 * its children out of process (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`) leaves
 * a **stub** on disk: the `claudeAiOauth` object is present and its
 * `accessToken` / `refreshToken` are empty strings. Measured on this machine,
 * 2026-09-06 — and `claude -p` run outside that host answers `Failed to
 * authenticate: OAuth session expired and could not be refreshed`.
 *
 * Reporting that as a login costs three separate things: the New Session
 * picker offers a backend whose every turn 401s; the live e2e specs spend
 * their full timeout before saying so; and the reason the user is shown
 * ("Claude is available") is simply false.
 *
 * So the file is opened, and exactly three fields are looked at — whether the
 * two token strings are non-empty, and whether the refresh token's own expiry
 * is in the past. Deliberately conservative in both directions:
 *
 *  - a file that will not parse, or has no `claudeAiOauth` object at all, is
 *    treated as a login. Other credential shapes exist (enterprise, a future
 *    format) and capygen must not lock a working machine out over one it does
 *    not recognise;
 *  - `expiresAt` (the *access* token's) is **not** consulted. An expired
 *    access token is the normal state of a working login between refreshes;
 *    only `refreshTokenExpiresAt` means the session is actually finished.
 */
function claudeCredentialSignal(file: string): ClaudeSignInSignal {
  let oauth: { accessToken?: unknown; refreshToken?: unknown; refreshTokenExpiresAt?: unknown };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      claudeAiOauth?: typeof oauth;
    };
    if (!parsed.claudeAiOauth || typeof parsed.claudeAiOauth !== "object") {
      return { signedIn: true, how: file };
    }
    oauth = parsed.claudeAiOauth;
  } catch {
    return { signedIn: true, how: file };
  }
  const hasToken =
    (typeof oauth.accessToken === "string" && oauth.accessToken.length > 0) ||
    (typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0);
  if (!hasToken) {
    return {
      signedIn: false,
      how: "",
      reason:
        "the Claude credentials file holds no token — sign in with `claude` in a terminal" +
        " (a Claude Code host that refreshes auth out of process leaves this file empty)",
    };
  }
  const refreshExpiry = oauth.refreshTokenExpiresAt;
  if (typeof refreshExpiry === "number" && refreshExpiry > 0 && refreshExpiry <= Date.now()) {
    return {
      signedIn: false,
      how: "",
      reason: "the Claude session has expired — sign in with `claude` in a terminal",
    };
  }
  return { signedIn: true, how: file };
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
      : (login.reason ?? "no Claude login found — run `claude login` in a terminal");

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
