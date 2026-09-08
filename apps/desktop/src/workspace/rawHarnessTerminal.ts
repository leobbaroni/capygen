import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexBinary } from "@capygen/engine";

export type RawHarnessBackend = "claude" | "codex";

/** Only existing binaries or PATH names; opening a raw terminal never installs anything. */
export function resolveRawHarnessCommand(backend: RawHarnessBackend): string {
  if (backend === "codex") return resolveCodexBinary().exe;
  const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return fs.existsSync(native) ? native : "claude";
}

/** PowerShell's call operator also supports npm .cmd shims. The path is one literal. */
export function rawHarnessShellArgs(shell: string, command: string): string[] {
  const name = path.win32.basename(shell).toLowerCase();
  if (name !== "powershell.exe" && name !== "pwsh.exe") {
    throw new Error("Raw CLI attachment requires Windows PowerShell.");
  }
  if (!command || /[\r\n\0]/.test(command)) throw new Error("Invalid raw CLI executable.");
  return ["-NoLogo", "-NoProfile", "-NoExit", "-Command", `& '${command.replace(/'/g, "''")}'`];
}
