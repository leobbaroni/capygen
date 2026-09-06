/**
 * The `bash` tool — named `bash` because that is the name every one of these
 * models has been trained to reach for, but on Windows it runs **PowerShell**
 * (`powershell -NoProfile -NonInteractive -Command …`), which is the shell the
 * user actually has. The description says so, so the model writes PowerShell
 * rather than `ls | grep`.
 *
 * Three things this must get right on Windows (CLAUDE.md §Windows-first):
 *
 *  - `windowsHide: true`, or every command flashes a console window;
 *  - a complete, cleaned environment (`cleanEnv`) so a capygen launched from
 *    inside an agent terminal does not leak `CLAUDECODE` into the child;
 *  - a real timeout that kills the tree, because a hung command otherwise holds
 *    the turn open forever.
 *
 * Output is merged stdout+stderr, capped at `ToolContext.maxOutputChars`
 * (64 KB by default, SPEC R25): the model sees a stub, the block keeps the whole
 * thing so the transcript can expand it.
 */
import { spawn } from "node:child_process";
import { cleanEnv } from "../env.js";
import { resolvePath } from "./fs.js";
import {
  clampText,
  optionalNumber,
  optionalString,
  requireString,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

export interface ShellInvocation {
  file: string;
  args: string[];
}

/** The shell and its flags for this platform. Exported so tests can assert it. */
export function shellFor(platform: NodeJS.Platform, command: string): ShellInvocation {
  if (platform === "win32") {
    return {
      file: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

export interface ShellResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface ShellRunner {
  run(
    command: string,
    options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  ): Promise<ShellResult>;
}

/** The real one: spawn, merge the two streams, kill on timeout or abort. */
export const systemShell: ShellRunner = {
  run(command, options) {
    const { file, args } = shellFor(process.platform, command);
    return new Promise<ShellResult>((resolve) => {
      const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
      });
      let output = "";
      let timedOut = false;
      let settled = false;

      const append = (chunk: string): void => {
        // Keep a bounded buffer: a `while true; do echo` must not eat the heap.
        output = output.length > 8_000_000 ? output : output + chunk;
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const finish = (result: ShellResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // SIGKILL after a grace period; on Windows `kill()` is already terminal.
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      }, options.timeoutMs);
      timer.unref?.();

      options.signal?.addEventListener("abort", () => {
        child.kill();
        finish({ output, code: null, signal: null, timedOut: false });
      });

      child.on("error", (err) => {
        finish({ output: `${output}\n${String(err)}`, code: null, signal: null, timedOut });
      });
      child.on("close", (code, signal) => finish({ output, code, signal, timedOut }));
    });
  },
};

export interface BashToolDeps {
  shell?: ShellRunner;
  /** Overridden in tests so the description is platform-stable. */
  platform?: NodeJS.Platform;
}

export function createBashTool(deps: BashToolDeps = {}): ToolDefinition {
  const shell = deps.shell ?? systemShell;
  const platform = deps.platform ?? process.platform;
  const shellName = platform === "win32" ? "PowerShell" : "sh";
  return {
    name: "bash",
    description:
      `Run a shell command in the project directory. This machine runs ${shellName}` +
      (platform === "win32"
        ? " (powershell -NoProfile -Command), so use PowerShell syntax — Get-ChildItem, not ls -la."
        : ".") +
      " Output is merged stdout+stderr and truncated when very large.",
    permissionClass: "execute",
    family: "bash",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: `The ${shellName} command to run.` },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to the project directory.",
        },
        timeout_ms: {
          type: "integer",
          description: `Kill the command after this many milliseconds. Default ${DEFAULT_BASH_TIMEOUT_MS}, max ${MAX_BASH_TIMEOUT_MS}.`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const command = requireString(input, "command");
      const cwd = resolvePath(ctx.cwd, optionalString(input, "cwd") ?? ".");
      const timeoutMs = Math.min(
        MAX_BASH_TIMEOUT_MS,
        Math.max(1_000, optionalNumber(input, "timeout_ms") ?? DEFAULT_BASH_TIMEOUT_MS),
      );
      const result = await shell.run(command, {
        cwd,
        timeoutMs,
        env: cleanEnv(ctx.env) as NodeJS.ProcessEnv,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      const status = result.timedOut
        ? `timed out after ${timeoutMs} ms`
        : result.code === null
          ? `ended on signal ${result.signal ?? "unknown"}`
          : `exit code ${result.code}`;
      const body = result.output.trimEnd();
      const clamped = clampText(
        `$ ${command}\n(${status})\n${body.length > 0 ? body : "(no output)"}`,
        ctx.maxOutputChars,
      );
      return {
        ...clamped,
        ...(result.timedOut || (result.code !== null && result.code !== 0)
          ? { isError: true }
          : {}),
      };
    },
  };
}

export const bashTool: ToolDefinition = createBashTool();
