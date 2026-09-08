/**
 * The run gate (SPEC R3/R27, CLAUDE.md "never install anything silently"):
 * pure functions deciding *what the confirm dialog says* and *what gets
 * spawned*, kept apart from `ipc/prereqs.ts`'s Electron-facing wiring so both
 * are unit-testable with no main process running.
 *
 * `consoleArgv` is ported from Omnigent-windows' `app/src/win/bootstrap.js`
 * `consoleArgv` (same idea: `Write-Host` the command before running it, stay
 * open with `-NoExit` so the result is still on screen after it finishes).
 */
import type { PrereqStep } from "@capygen/shared";
import { REFRESH_WINDOWS_PATH } from "./nativeProbe.js";

export interface ConfirmOptions {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  /** Index into `buttons` for "Run" — also what a Yes answer must equal. */
  defaultId: number;
  /** Index into `buttons` for "Cancel" (and Escape/close). */
  cancelId: number;
}

/** What the native confirm dialog shows for one step. Quotes the exact
 *  command (CLAUDE.md), and never claims anything runs before the user
 *  clicks Run. */
export function confirmOptionsFor(step: PrereqStep): ConfirmOptions {
  return {
    title: `Run "${step.title}"?`,
    message: "capygen will run this command in a visible PowerShell window you can watch:",
    detail: `${step.command}\n\nNothing runs until you click Run, and the window stays open ` +
      "afterwards so you can read the result. Closing this dialog runs nothing.",
    buttons: ["Run", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
}

export interface ConsoleArgv {
  file: string;
  args: string[];
}

/** PowerShell argv that echoes the command before running it, then stays
 *  open (`-NoExit`) so the result is still readable. */
export function consoleArgv(command: string): ConsoleArgv {
  const quoted = command.replace(/'/g, "''");
  const script = [
    REFRESH_WINDOWS_PATH,
    "Write-Host 'capygen is running this command:' -ForegroundColor Cyan",
    `Write-Host '  ${quoted}' -ForegroundColor Cyan`,
    "Write-Host ''",
    command,
    "Write-Host ''",
    "Write-Host 'Finished. You can close this window, then click Re-detect in capygen.' -ForegroundColor Green",
  ].join("; ");
  return {
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", script],
  };
}

/**
 * The id of the first not-yet-`detected` step `step.blockedBy` names, or
 * `null` when every dependency is satisfied. `prereqs.run` refuses to launch
 * a step out of order rather than letting e.g. "Sign in to Codex" run before
 * Codex is installed (`ipc.ts`'s own doc comment on `prereqs.run`).
 */
export function firstUnmetDependency(step: PrereqStep, steps: PrereqStep[]): string | null {
  for (const depId of step.blockedBy ?? []) {
    const dep = steps.find((s) => s.id === depId);
    if (!dep || !dep.detected) return depId;
  }
  return null;
}
