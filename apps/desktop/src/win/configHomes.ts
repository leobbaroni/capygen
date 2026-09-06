/**
 * Pointing the whole app at an isolated pair of backend config homes
 * (Phase 6, Task C item 1).
 *
 * The two CLIs each relocate their *entire* home through one variable —
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (see
 * `packages/engine/src/config/paths.ts` for how each was verified live) — and
 * everything in capygen that touches a backend's configuration ends up reading
 * one of them:
 *
 *   - `resolveBackendHomes()` (the config stores, the watchers, the settings
 *     hub's Integrations pages) reads `process.env` directly;
 *   - `cleanEnv()` (every harness child, every `claude mcp …` / `claude plugin
 *     …` spawn, the MCP stdio children, the Terminal pane, dev servers) copies
 *     `process.env` wholesale.
 *
 * So there is exactly one place to intervene and it is `process.env` in the
 * main process, before anything reads it. Setting `CLAUDE_CONFIG_DIR` on the
 * *app* would be a footgun — a capygen launched from a Claude Code terminal
 * inherits that terminal's own value and would silently drive the wrong home —
 * so the seam is capygen-namespaced instead: `CAPYGEN_CLAUDE_CONFIG_DIR` and
 * `CAPYGEN_CODEX_HOME` are what a test (or `tests/e2e/settings.spec.ts`) sets,
 * and this module maps them onto the CLIs' own names.
 *
 * That indirection is the point of the repo's hard safety rule: an e2e run
 * that adds an MCP server, flips a permission or writes a `config.toml` must
 * never be able to reach `~/.claude` or `~/.codex`. With these two set it
 * cannot, because the variable the backend itself obeys is the one capygen
 * rewrote.
 *
 * Nothing here is Electron-aware, so `apps/desktop/test/configHomes.test.ts`
 * exercises the real function rather than a copy of its rules.
 */
import fs from "node:fs";
import path from "node:path";

/** Redirects Claude Code's whole config home (`CLAUDE_CONFIG_DIR`). */
export const CAPYGEN_CLAUDE_CONFIG_DIR_ENV = "CAPYGEN_CLAUDE_CONFIG_DIR";
/** Redirects Codex's whole config home (`CODEX_HOME`). */
export const CAPYGEN_CODEX_HOME_ENV = "CAPYGEN_CODEX_HOME";

export interface ConfigHomeMapping {
  /** The capygen-namespaced variable that was set. */
  readonly from: string;
  /** The backend's own variable it maps onto. */
  readonly to: string;
  /** The absolute, resolved directory. */
  readonly dir: string;
}

/** The mapping table, in the order it is applied. */
export const CONFIG_HOME_MAPPINGS: readonly { from: string; to: string }[] = [
  { from: CAPYGEN_CLAUDE_CONFIG_DIR_ENV, to: "CLAUDE_CONFIG_DIR" },
  { from: CAPYGEN_CODEX_HOME_ENV, to: "CODEX_HOME" },
];

export type EnvLike = Record<string, string | undefined>;

/**
 * Which overrides this environment asks for, resolved to absolute paths.
 *
 * A blank or whitespace-only value is *not* an override — it is what an unset
 * variable looks like after a shell expands nothing — and is dropped rather
 * than being turned into `CLAUDE_CONFIG_DIR=""`, which would make the SDK's
 * own `?? homedir()` fall through to the real home only for some code paths
 * and not others.
 */
export function plannedConfigHomes(env: EnvLike): ConfigHomeMapping[] {
  const planned: ConfigHomeMapping[] = [];
  for (const { from, to } of CONFIG_HOME_MAPPINGS) {
    const raw = env[from]?.trim();
    if (!raw) continue;
    planned.push({ from, to, dir: path.resolve(raw) });
  }
  return planned;
}

export interface ApplyConfigHomesOptions {
  /** Create each directory before handing it to a backend. Default: true. */
  mkdir?: (dir: string) => void;
  log?: (message: string) => void;
}

/**
 * Apply the overrides to `env` **in place** (the app passes `process.env`).
 *
 * The directory is created first: `claude mcp add --scope user` writes
 * `<CLAUDE_CONFIG_DIR>/.claude.json` but does not create the directory itself,
 * and a `CODEX_HOME` that does not exist makes the first `config.toml` write
 * fail with ENOENT rather than saying anything useful.
 *
 * Returns what it did, so `main.ts` can log it once and a test can assert on
 * it. An override already present *and identical* is still returned — the
 * caller's log line is the only record that an e2e profile is isolated, and
 * suppressing it would make a passing run indistinguishable from one that
 * silently used the real home.
 */
export function applyConfigHomes(
  env: EnvLike,
  options: ApplyConfigHomesOptions = {},
): ConfigHomeMapping[] {
  const mkdir = options.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const applied: ConfigHomeMapping[] = [];
  for (const mapping of plannedConfigHomes(env)) {
    try {
      mkdir(mapping.dir);
    } catch (err) {
      // A home capygen cannot create is worth saying out loud, but it is not
      // worth refusing to start over: the backend's own error, when it comes,
      // names the same directory.
      options.log?.(
        `[config] could not create ${mapping.to}=${mapping.dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    env[mapping.to] = mapping.dir;
    applied.push(mapping);
    options.log?.(`[config] ${mapping.to}=${mapping.dir} (from ${mapping.from})`);
  }
  return applied;
}
