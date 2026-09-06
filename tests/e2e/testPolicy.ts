/**
 * The e2e test policy: which models a spec may spend money on, and where a
 * launched app is allowed to read and write backend configuration.
 *
 * Two rules, both enforced here rather than remembered per spec:
 *
 *  1. **Pinned models only.** Every live turn runs `claude-sonnet-5` or
 *     `gpt-5.6-luna`, both at `low` effort. No account default, no
 *     `claude-sonnet-4-5`, no Haiku "cheap model" exception — a spec that
 *     wants a second model to prove routing has to prove it in a fixture test
 *     instead (see `roundtable.spec.ts` (c)).
 *  2. **Isolated by default.** Every `electron.launch` gets disposable
 *     `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME` directories, so the
 *     ordinary `corepack pnpm e2e` never reads or writes `~/.claude` or
 *     `~/.codex`. A disposable home has no login, so live tests skip — which
 *     is the correct default, not a regression.
 *
 * To run the live tests, point `CAPYGEN_TEST_CLAUDE_HOME` /
 * `CAPYGEN_TEST_CODEX_HOME` at **persistent, separately authenticated** test
 * identities. Nothing here copies credentials into them: sign in once, in
 * those homes, by hand. The paths are validated against the personal homes in
 * both directions — a dedicated home may neither live inside `~/.claude` or
 * `~/.codex` nor contain either of them — so `CAPYGEN_TEST_CLAUDE_HOME=~` and
 * `=~/.codex/test` are both refused.
 *
 * `canonicalizePath` / `isPathInside` are reused from the engine's script
 * policy (`packages/engine/scripts/test-policy.ts`) so the resolution rules —
 * symlink/junction realpath, nearest existing ancestor, Windows case folding —
 * are the same ones the live scripts enforce. That file is owned elsewhere and
 * is imported, never edited.
 *
 * Not a `.spec.ts`, so Playwright does not collect it as a test file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { canonicalizePath, isPathInside } from "../../packages/engine/scripts/test-policy.js";

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

/** The only Claude model an e2e spec may spend a turn on. */
export const E2E_CLAUDE_MODEL = "claude-sonnet-5";
/** The only Codex model an e2e spec may spend a turn on. */
export const E2E_CODEX_MODEL = "gpt-5.6-luna";
/** The only provider an `api` live test may use. */
export const E2E_API_PROVIDER = "anthropic";
/** Every live turn runs at low effort. */
export const E2E_EFFORT = "low";

/** `agent.config` for a pinned Claude agent. */
export const E2E_CLAUDE_CONFIG = { claude: { effort: E2E_EFFORT } } as const;
/** `agent.config` for a pinned Codex agent. */
export const E2E_CODEX_CONFIG = { codex: { reasoningEffort: E2E_EFFORT } } as const;
/** `agent.config` for a pinned `api` agent — Anthropic only (see the header). */
export const E2E_API_CONFIG = {
  api: { provider: E2E_API_PROVIDER, model: E2E_CLAUDE_MODEL, reasoningEffort: E2E_EFFORT },
} as const;

/** The pinned model for a backend, or `null` for one with no pinned model. */
export function pinnedModelFor(backend: string): string | null {
  if (backend === "claude" || backend === "api") return E2E_CLAUDE_MODEL;
  if (backend === "codex") return E2E_CODEX_MODEL;
  return null;
}

/** `agent.config` for a backend, so a spec cannot forget the effort. */
export function pinnedConfigFor(backend: string): Record<string, unknown> {
  if (backend === "claude") return { ...E2E_CLAUDE_CONFIG };
  if (backend === "codex") return { ...E2E_CODEX_CONFIG };
  if (backend === "api") return { ...E2E_API_CONFIG };
  return {};
}

/**
 * Fail loudly rather than spend a turn on an unpinned model. Used where a spec
 * takes a model from the app (a picker, a `harness.list` default) and is about
 * to run a live turn on it.
 */
export function assertPinnedModel(backend: string, model: string, where: string): void {
  const pinned = pinnedModelFor(backend);
  if (pinned === null) throw new Error(`${where}: no pinned model for backend ${backend}`);
  if (model !== pinned) {
    throw new Error(
      `${where}: refusing to run a live turn on ${backend} model "${model}"; ` +
        `the e2e policy pins "${pinned}" (tests/e2e/testPolicy.ts). ` +
        "No account default, Sonnet 4.5 or Haiku exception is allowed.",
    );
  }
}

// ---------------------------------------------------------------------------
// backend homes
// ---------------------------------------------------------------------------

export const CLAUDE_HOME_ENV = "CAPYGEN_TEST_CLAUDE_HOME";
export const CODEX_HOME_ENV = "CAPYGEN_TEST_CODEX_HOME";

/** Personal configuration roots that a dedicated test home must never touch. */
function personalRoots(): string[] {
  const home = os.homedir();
  return [path.join(home, ".claude"), path.join(home, ".codex")];
}

/**
 * Validate an explicitly supplied dedicated home. Rejects a relative path, the
 * personal roots, anything inside them, and anything that *contains* them
 * (`CAPYGEN_TEST_CLAUDE_HOME=C:\Users\me` would put config in the user's home).
 * Cross-backend too: a Claude home inside `~/.codex` is refused as well.
 */
export function validateDedicatedHome(variable: string, dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new Error(`${variable} must be an absolute path to a dedicated test home; got "${dir}"`);
  }
  const candidate = canonicalizePath(dir);
  for (const root of personalRoots()) {
    const personal = canonicalizePath(root);
    if (isPathInside(personal, candidate) || isPathInside(candidate, personal)) {
      throw new Error(
        `${variable} must not be, contain or live inside a personal configuration home ` +
          `(${root}); point it at a separate directory with its own sign-in. ` +
          "Credentials are never copied there by these tests.",
      );
    }
  }
  return dir;
}

export interface BackendHomes {
  claudeHome: string;
  codexHome: string;
  /** True when the caller supplied persistent, separately authenticated homes. */
  dedicated: boolean;
  /** Removes the disposable directories; a no-op for dedicated homes. */
  cleanup(): void;
}

/**
 * The backend homes for one launch. Disposable unless the two environment
 * variables name dedicated ones, in which case they are validated and reused
 * so their sign-in survives between runs.
 */
export function backendHomes(tag = "e2e"): BackendHomes {
  const claudeVar = process.env[CLAUDE_HOME_ENV]?.trim();
  const codexVar = process.env[CODEX_HOME_ENV]?.trim();
  if (claudeVar && codexVar) {
    const claudeHome = validateDedicatedHome(CLAUDE_HOME_ENV, claudeVar);
    const codexHome = validateDedicatedHome(CODEX_HOME_ENV, codexVar);
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    return { claudeHome, codexHome, dedicated: true, cleanup: () => undefined };
  }
  if (claudeVar || codexVar) {
    throw new Error(
      `set both ${CLAUDE_HOME_ENV} and ${CODEX_HOME_ENV} or neither; ` +
        "a half-configured identity would silently fall back to a disposable home for one backend.",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-homes-`));
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    claudeHome,
    codexHome,
    dedicated: false,
    // Closes over the `mkdtemp` path this call created — never a path that
    // arrived from the environment, and never a dedicated home.
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// launch environment
// ---------------------------------------------------------------------------

/** Provider keys an offline run must not inherit from the developer's shell. */
export const PERSONAL_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** True when the run was pointed at dedicated, separately authenticated homes. */
export function usingDedicatedIdentity(): boolean {
  return Boolean(process.env[CLAUDE_HOME_ENV]?.trim() && process.env[CODEX_HOME_ENV]?.trim());
}

export interface LaunchEnvOptions {
  userDataDir: string;
  projectDir: string;
  homes: { claudeHome: string; codexHome: string };
  /**
   * The value for `CAPYGEN_ENGINE` — `"stub"` for the offline echo engine,
   * `"stub-roundtable"` for the scripted dispatcher fixture. Omitted runs the
   * real harnesses. Deliberately a plain string: typing it as the one literal
   * `"stub"` silently dropped `stub-roundtable` and sent an offline fixture
   * test at a live backend.
   */
  engine?: string;
  /** Extra variables. May not name a reserved isolation key — see below. */
  extra?: Record<string, string>;
}

/**
 * The variables that carry isolation. `extra` may not set any of them: a spec
 * that could pass `CLAUDE_CONFIG_DIR` through `extra` would silently undo the
 * homes it just asked for, which is precisely the failure this module exists
 * to make impossible. Overwriting one throws rather than being ignored, so a
 * mistake is loud at the launch site instead of surfacing as a personal-config
 * read much later.
 */
export const RESERVED_ISOLATION_ENV = [
  "CAPYGEN_CLAUDE_CONFIG_DIR",
  "CAPYGEN_CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CAPYGEN_USER_DATA_DIR",
  "CAPYGEN_PROJECT_DIR",
] as const;

/**
 * The environment every `electron.launch` in this suite uses.
 *
 * Both namings are set from the same `homes`: the app's own
 * `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME` (which
 * `apps/desktop/src/win/configHomes.ts` maps onto the CLI variables inside the
 * app), **and** the CLIs' own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The second
 * pair matters because anything spawned outside that mapping — a `claude` or
 * `codex` child started by a test helper, a probe that reads the environment
 * directly — would otherwise inherit the runner's values, or the developer's.
 *
 * `CAPYGEN_ENGINE` is always removed from the inherited environment and then
 * set only when asked, so a developer's shell cannot flip a live spec to the
 * stub or the other way round. Provider keys are stripped unless the run uses
 * a dedicated identity: an ordinary `corepack pnpm e2e` must not be able to
 * spend the developer's personal key.
 */
/**
 * Windows environment variables are case-insensitive, but a JS object is not.
 * An inherited `claude_config_dir` and an assigned `CLAUDE_CONFIG_DIR` would
 * both survive into the child's environment block, and which one wins is the
 * OS's choice — so a lower-case variable in the developer's shell could defeat
 * the isolation this module exists to guarantee. Every reserved key is
 * therefore matched, stripped and re-assigned case-insensitively.
 */
function deleteCaseInsensitive(env: Record<string, string>, names: readonly string[]): void {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (wanted.has(key.toLowerCase())) delete env[key];
  }
}

export function launchEnv(options: LaunchEnvOptions): Record<string, string> {
  const { CAPYGEN_ENGINE: _drop, ...inherited } = process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") env[key] = value;
  }
  // `CAPYGEN_ENGINE` too: the destructure above only removes the exact spelling.
  deleteCaseInsensitive(env, ["CAPYGEN_ENGINE"]);
  if (!usingDedicatedIdentity()) {
    deleteCaseInsensitive(env, PERSONAL_KEY_ENV);
  }

  const reserved = new Set(RESERVED_ISOLATION_ENV.map((k) => k.toLowerCase()));
  for (const key of Object.keys(options.extra ?? {})) {
    if (reserved.has(key.toLowerCase())) {
      throw new Error(
        `launchEnv: extra["${key}"] would overwrite an isolation variable. ` +
          "Pass the directory through `homes`/`userDataDir`/`projectDir` instead " +
          `(reserved, case-insensitively: ${RESERVED_ISOLATION_ENV.join(", ")}).`,
      );
    }
  }
  // `extra` first, then the reserved keys are stripped in every casing and
  // re-assigned, so exactly one spelling of each reaches the child.
  Object.assign(env, options.extra ?? {});
  deleteCaseInsensitive(env, RESERVED_ISOLATION_ENV);
  Object.assign(env, {
    CAPYGEN_USER_DATA_DIR: options.userDataDir,
    CAPYGEN_PROJECT_DIR: options.projectDir,
    // What the app reads and maps onto the CLI variables for its children.
    CAPYGEN_CLAUDE_CONFIG_DIR: options.homes.claudeHome,
    CAPYGEN_CODEX_HOME: options.homes.codexHome,
    // What a CLI reads directly, for anything spawned outside that mapping.
    CLAUDE_CONFIG_DIR: options.homes.claudeHome,
    CODEX_HOME: options.homes.codexHome,
    ELECTRON_ENABLE_LOGGING: "0",
  });
  if (options.engine) env.CAPYGEN_ENGINE = options.engine;
  return env;
}

// ---------------------------------------------------------------------------
// applying the policy to a running app
// ---------------------------------------------------------------------------

async function bridgeInvoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ({ channel: c, payload: p }) => {
      const bridge = (
        window as unknown as {
          capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
        }
      ).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return (await bridge.invoke(c, p)) as unknown;
    },
    { channel, payload },
  ) as Promise<T>;
}

/**
 * Put a launched app on the pinned models and low effort, the way a user would
 * — through the settings hub, not by writing config files.
 *
 * Two layers, because they are consumed by different code today:
 *
 *  - `settings.set { defaultModel }` is the flat row `SessionRunner` reads, so
 *    it is what a UI-created session actually gets;
 *  - `settings.patch { backends… }` is the hub's per-backend block. **It is
 *    not yet consumed at the harness boundary** (review finding R-C; the fix
 *    is task 7-P1). It is set here anyway so that the moment 7-P1 lands, a
 *    UI-created session inherits `low` without another edit to these specs —
 *    and until then, specs must keep passing `pinnedConfigFor(...)` explicitly
 *    on `sessions.create`, which is the only path that reaches the harness.
 */
export async function applyPinnedDefaults(page: Page): Promise<void> {
  const flat = await bridgeInvoke<{ defaultModel: string }>(page, "settings.set", {
    defaultModel: E2E_CLAUDE_MODEL,
  });
  if (flat.defaultModel !== E2E_CLAUDE_MODEL) {
    throw new Error(`settings.set did not take the pinned model: got ${flat.defaultModel}`);
  }
  await bridgeInvoke(page, "settings.patch", {
    patch: {
      general: { defaultBackend: "claude", defaultModel: E2E_CLAUDE_MODEL },
      backends: {
        claude: { effort: E2E_EFFORT },
        codex: { reasoningEffort: E2E_EFFORT },
        api: {
          provider: E2E_API_PROVIDER,
          model: E2E_CLAUDE_MODEL,
          reasoningEffort: E2E_EFFORT,
        },
      },
    },
  });
}

/**
 * The effort field each backend's config carries. Different names, same idea.
 */
function effortOf(backend: string, config: unknown): unknown {
  const root = (config ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (backend === "claude") return root.claude?.effort;
  if (backend === "codex") return root.codex?.reasoningEffort;
  if (backend === "api") return root.api?.reasoningEffort;
  return undefined;
}

/**
 * Read a session back through the app's own IPC and refuse to let a live turn
 * start on anything but a pinned model **at the pinned effort**.
 *
 * **Call this before the prompt is dispatched, not after.** Sending the
 * composer and *then* asserting is not a gate: the turn has already been
 * requested by the time the assertion runs, so an unpinned model or a default
 * effort has already been paid for. The only session shape this can gate is
 * one created explicitly through `sessions.create`, because that call returns
 * an id before anything is sent — which is why every live spec now either
 * creates its session that way or skips (see {@link skipUntilP1}).
 *
 * ### What it inspects, and why that will have to change
 *
 * It reads `sessions.get` → `agents[].config`: the agent's **own stored
 * config**, the layer `SessionRunner` passes to the harness verbatim today.
 *
 * This is *not* the effective configuration. When task 7-P1 lands and the
 * global `backends.<name>` defaults are finally resolved at the harness
 * boundary, an agent created without an explicit override will run at `low`
 * while its stored `config` stays empty — the inherited value lives in
 * `GlobalSettings`, not on the row. So this assertion will **not** start
 * passing by itself for UI-created sessions, and anyone who expects it to will
 * be reading a false green.
 *
 * Removing the {@link skipUntilP1} gates therefore requires *both*:
 *
 *  1. 7-P1 resolving global → backend → agent at the harness boundary, and
 *  2. this function being changed to inspect the **effective** config — the
 *     request options actually handed to the harness (a request-capture check
 *     at the boundary, or an IPC that reports the resolved layer) rather than
 *     the raw row.
 *
 * Until (2) exists there is no way for a UI-created session to prove its
 * effort from the renderer at all, which is exactly why those tests skip
 * rather than assert something weaker.
 */
export async function assertSessionPinned(page: Page, sessionId: string): Promise<void> {
  const loaded = await bridgeInvoke<{
    agents: { backend: string; model: string; config?: unknown }[];
  } | null>(page, "sessions.get", { sessionId });
  const agents = loaded?.agents ?? [];
  if (agents.length === 0) throw new Error(`sessions.get returned no agents for ${sessionId}`);
  for (const agent of agents) {
    assertPinnedModel(agent.backend, agent.model, `session ${sessionId}`);
    const effort = effortOf(agent.backend, agent.config);
    if (effort !== E2E_EFFORT) {
      throw new Error(
        `session ${sessionId}: the ${agent.backend} agent's stored config carries effort ` +
          `${effort === undefined ? "(unset)" : String(effort)}, not "${E2E_EFFORT}". ` +
          `Pass \`config: pinnedConfigFor("${agent.backend}")\` on sessions.create. ` +
          "The hub's global backend defaults are not consumed at the harness boundary yet " +
          "(review finding R-C, task 7-P1), and even once they are they will not appear on " +
          "this row — see this function's doc comment.",
      );
    }
  }
}

/**
 * Skip a live test whose session is created **by the UI** rather than by an
 * explicit `sessions.create`.
 *
 * The landing composer builds its agent from the picker and the settings
 * defaults. `settings.set { defaultModel }` reaches that path, so the *model*
 * is pinned — but effort has no equivalent: the hub's
 * `backends.<name>.effort` is written and then never read at the harness
 * boundary (review finding R-C). A UI-created live turn would therefore run at
 * the model's **default** effort, which the user's test policy forbids, and
 * there is no honest way for the test to prevent it:
 *
 *  - asserting after `press("Enter")` is too late — the turn is already sent;
 *  - injecting `config` through a mock would test a session the product never
 *    creates, and would hide the very gap 7-P1 exists to close;
 *  - weakening the effort requirement would make the policy a comment.
 *
 * So these tests skip, loudly, naming the task that unblocks them. The
 * explicit-`sessions.create` paths in the same specs stay runnable and keep
 * proving the same backends on the pinned model at low effort.
 *
 * Removing a gate needs 7-P1 **and** an effective-config assertion — see
 * {@link assertSessionPinned}.
 */
export function skipUntilP1(what: string): void {
  test.skip(
    true,
    `${what}: this session is created by the UI, whose agent inherits effort from the ` +
      "settings hub — and hub backend defaults are not consumed at the harness boundary yet " +
      "(review finding R-C, task 7-P1). A live turn here would run at the model's default " +
      "effort, which the e2e policy forbids. Re-enable with 7-P1 plus an effective-config " +
      "check (tests/e2e/testPolicy.ts). The explicit sessions.create paths in this suite " +
      "still cover these backends at " +
      `${E2E_CLAUDE_MODEL}/${E2E_CODEX_MODEL} on ${E2E_EFFORT} effort.`,
  );
}
