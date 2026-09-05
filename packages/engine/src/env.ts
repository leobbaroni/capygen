/**
 * The environment every backend child gets.
 *
 * `Options.env` on the Claude SDK **replaces** the child environment wholesale
 * (docs/spikes/claude-sdk-shapes.md §1), so this returns a complete env, not a
 * patch. Two Windows-specific jobs, both ported from the sibling project's
 * `app/src/win/cli_windows.js`:
 *
 *   1. drop the nested-session markers a Claude Code / Codex terminal exports
 *      into every child (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
 *      `CLAUDE_CODE_*`). If capygen itself was launched from such a terminal the
 *      child would otherwise believe it is nested;
 *   2. force UTF-8 for Python-based tools, because the default cp1252 code page
 *      turns their non-ASCII output into a UnicodeEncodeError.
 *
 * `CLAUDE_AGENT_SDK_VERSION` is dropped too: the SDK re-adds it (along with
 * `CLAUDE_CODE_ENTRYPOINT=sdk-ts`) for the process it spawns, and a stale value
 * inherited from a parent session would shadow the real one.
 */
export type EnvRecord = Record<string, string | undefined>;

const NESTED_SESSION_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
]);

/** True for a variable that only means something inside a running agent session. */
export function isNestedSessionKey(key: string): boolean {
  return NESTED_SESSION_KEYS.has(key) || key.startsWith("CLAUDE_CODE_");
}

export function cleanEnv(base: EnvRecord = process.env): EnvRecord {
  const env: EnvRecord = {};
  for (const [key, value] of Object.entries(base)) {
    if (isNestedSessionKey(key)) continue;
    env[key] = value;
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}
