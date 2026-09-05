/**
 * Windows child-process helpers.
 *
 * Ported from Omnigent-windows/app/src/win/cli_windows.js. Every CLI capygen
 * spawns (claude.exe, codex.exe, dev servers, the visible-console installer)
 * goes through `spawnOptions`, so two Windows landmines are handled once:
 *
 *   1. `windowsHide` — without it every execFile of a console program flashes a
 *      black window over the app.
 *   2. Nested-session markers. A Claude Code or Codex terminal exports
 *      CLAUDECODE / CLAUDE_PID / CLAUDE_EFFORT / CLAUDE_CODE_* into every child.
 *      If capygen is launched from such a terminal those reach the harness and
 *      make `claude` report "needs auth" (observed in the sibling project:
 *      `claude -p /model` exits 0xC0000142). They mean nothing to a desktop app.
 *
 * Also forces UTF-8 for Python-based children (paths and output are non-ASCII on
 * this machine's test corpus).
 */
export const IS_WIN = process.platform === "win32";

/** Exact env names that only exist inside a running Claude Code session. */
export const NESTED_SESSION_ENV = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);

/** Prefix-matched nested-session markers. */
export const NESTED_SESSION_ENV_PATTERN =
  /^CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_|ENTRYPOINT|HOST_SESSION_ID|EXECPATH)/;

/**
 * The environment a spawned CLI should see: the current one minus nested-session
 * markers, plus UTF-8 forcing. Pure — pass a fake `base` to test it.
 */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  for (const key of Object.keys(env)) {
    if (NESTED_SESSION_ENV.has(key) || NESTED_SESSION_ENV_PATTERN.test(key)) {
      delete env[key];
    }
  }
  return env;
}

export interface SpawnExtras {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  [key: string]: unknown;
}

/** Extra `child_process` options for any CLI spawn. */
export function spawnOptions(extra: SpawnExtras = {}): SpawnExtras & {
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
} {
  return { windowsHide: true, ...extra, env: cliEnv(extra.env ?? process.env) };
}

/**
 * Render a command as a PowerShell line for the visible-console runner (R3/R27:
 * the user must be able to read the exact command before it runs).
 */
export function cliCommandString(command: string, args: readonly string[]): string {
  const q = (s: string) => (/[\s'"&|<>()]/.test(s) ? `'${s.replaceAll("'", "''")}'` : s);
  return ["&", q(command), ...args.map(q)].join(" ");
}
