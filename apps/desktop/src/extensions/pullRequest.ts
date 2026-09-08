import { execFile } from "node:child_process";
import { cleanEnv } from "@capygen/engine";
export interface PullRequestResult { available: boolean; url?: string; title?: string; reason?: string }
export interface PullRequestContext { workingDirectory: string; branch: string }
export interface PullRequestProbeOptions { cwd: string; signal: AbortSignal; timeout: number; maxBuffer: number; windowsHide: true; env: NodeJS.ProcessEnv }
export type PullRequestProbe = (command: string, args: string[], options: PullRequestProbeOptions) => Promise<string>;
const defaultProbe: PullRequestProbe = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
});
/** Read-only GitHub CLI lookup for an existing session's trusted working directory and branch. */
export function createExtensionPullRequestAdapter(deps: {
  context(sessionId: string): PullRequestContext | null | Promise<PullRequestContext | null>;
  probe?: PullRequestProbe; env?: NodeJS.ProcessEnv;
}) {
  return async (sessionId: string, signal: AbortSignal): Promise<PullRequestResult> => {
    try {
      const context = await deps.context(sessionId);
      if (signal.aborted || !context || !context.workingDirectory || !/^[^-\x00-\x20][^\x00-\x20]{0,199}$/.test(context.branch)) return { available: false, reason: "Session branch is unavailable" };
      const output = await (deps.probe ?? defaultProbe)("gh", ["pr", "view", context.branch, "--json", "url,title"], {
        cwd: context.workingDirectory, signal, timeout: 5000, maxBuffer: 65536, windowsHide: true,
        env: { ...cleanEnv(deps.env), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      });
      if (signal.aborted || Buffer.byteLength(output) > 65536) return { available: false, reason: "Pull request lookup was cancelled or exceeded its limit" };
      const row = JSON.parse(output) as Record<string, unknown>;
      if (typeof row.url !== "string" || row.url.length > 2048 || typeof row.title !== "string") throw new Error("Invalid metadata");
      const url = new URL(row.url);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url.pathname)) throw new Error("Invalid URL");
      return { available: true, url: url.href, title: row.title.slice(0, 512) };
    } catch { return { available: false, reason: "Pull request lookup is unavailable; GitHub CLI, authentication, or a matching PR may be missing" }; }
  };
}
