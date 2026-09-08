import { execFile } from "node:child_process";
import { cleanEnv } from "@capygen/engine";
import { defaultCliProbe, type CliProbe } from "../ipc/harnessList.js";

/** A running app retains the old PATH after an installer updates Windows. */
export const REFRESH_WINDOWS_PATH = "$env:Path = ([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'";

export function probeCommand(command: string, args: string[]): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `${REFRESH_WINDOWS_PATH}; & ${[command, ...args].map(quote).join(" ")}; if (-not $?) { exit 1 }`;
}

/** PowerShell resolves Windows npm .cmd shims; execFile cannot run those directly. */
export const nativePrereqProbe: CliProbe = (command, args) => {
  if (process.platform !== "win32") return defaultCliProbe(command, args);
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probeCommand(command, args)],
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, env: cleanEnv() },
      (error, stdout) => resolve(error ? { ok: false, reason: "Tool not available" } : { ok: true, version: stdout.trim().split(/\r?\n/)[0] }));
  });
};
