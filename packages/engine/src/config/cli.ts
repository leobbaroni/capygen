/**
 * Running `claude plugin …` / `claude mcp …` headless (SPEC R20, A9).
 *
 * Four Windows-first rules, all of them learned the hard way in this repo:
 *
 *   1. `windowsHide` — a settings page that flashes a console window on every
 *      refresh is a bug, and `harnessList.ts` already sets it for the same
 *      reason. The *visible* console the safety rule demands belongs to the
 *      setup panel's install steps (`PrereqService`), not to a config read.
 *   2. `cleanEnv` — the child must not inherit the nested-session markers a
 *      Claude Code terminal exports (`packages/engine/src/env.ts`), or the CLI
 *      believes it is running inside an agent session.
 *   3. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are passed through explicitly, so a
 *      test (and the e2e profile) can point the CLI at a temp home and never
 *      touch the machine's real configuration.
 *   4. A non-zero exit is an **error with the CLI's own stderr in it**, never a
 *      swallowed false (SPEC §Edge Cases).
 */
import { execFile } from "node:child_process";
import { cleanEnv, type EnvRecord } from "../env.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
  env?: EnvRecord;
  timeoutMs?: number;
  /** Extra variables layered on top of `cleanEnv` (the two backend homes). */
  overrides?: Record<string, string | undefined>;
  maxBuffer?: number;
  /**
   * Spawn with `windowsHide: false`, so a console window is on screen for as
   * long as the command runs.
   *
   * [review] Rule 1 above ("a settings page that flashes a console on every
   * refresh is a bug") is about *reads*. SPEC R27 asks the opposite of an
   * install: "never run an install/upgrade/uninstall without the confirm
   * dialog **and a visible console**". So the two plugin-writing commands set
   * this and nothing else does — the confirm dialog names the command before
   * it starts, and the window is proof to the user that it is the thing
   * running.
   */
  showConsole?: boolean;
}

/** How a command is run; overridden in tests by a shim that records argv. */
export type CliRunner = (
  command: string,
  args: string[],
  options: RunCliOptions,
) => Promise<CliResult>;

export const DEFAULT_CLI_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export const nodeCliRunner: CliRunner = (command, args, options) =>
  new Promise<CliResult>((resolve) => {
    const env = cleanEnv(options.env ?? process.env);
    for (const [key, value] of Object.entries(options.overrides ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    execFile(
      command,
      args,
      {
        windowsHide: options.showConsole !== true,
        timeout: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: env as NodeJS.ProcessEnv,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        if (!err) {
          resolve({ code: 0, stdout: out, stderr: errText });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : 1;
        resolve({ code, stdout: out, stderr: errText || err.message });
      },
    );
  });

/** Run and throw the CLI's own message when it fails. */
export async function runCliOrThrow(
  run: CliRunner,
  command: string,
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-4).join("\n");
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited ${result.code}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

/**
 * The first JSON value in a CLI's stdout. `claude plugin list --json` prints
 * only JSON today, but a future banner line (an update notice, say) must not
 * turn a working settings page into a parse error.
 */
export function parseJsonOutput<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const from = Math.min(...starts);
  try {
    return JSON.parse(trimmed.slice(from)) as T;
  } catch {
    return null;
  }
}
