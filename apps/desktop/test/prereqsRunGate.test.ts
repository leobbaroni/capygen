/**
 * The run gate's pure decision functions (SPEC R3/R27): what the confirm
 * dialog says, what gets spawned, and whether a step is allowed to run yet.
 * No Electron, no child process — see `prereqsIpc.test.ts` for the wiring
 * that calls these.
 */
import { describe, expect, it } from "vitest";
import type { PrereqStep } from "@capygen/shared";
import { confirmOptionsFor, consoleArgv, firstUnmetDependency } from "../src/prereqs/runGate.js";
import { probeCommand } from "../src/prereqs/nativeProbe.js";

function step(over: Partial<PrereqStep> = {}): PrereqStep {
  return {
    id: "claude-cli",
    title: "Install Claude Code",
    detected: false,
    command: 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"',
    description: "",
    kind: "cli",
    ...over,
  };
}

describe("confirmOptionsFor", () => {
  it("quotes the exact command in the detail text", () => {
    const s = step();
    const options = confirmOptionsFor(s);
    expect(options.detail).toContain(s.command);
  });

  it("names Run first and Cancel second, matching defaultId/cancelId", () => {
    const options = confirmOptionsFor(step());
    expect(options.buttons[options.defaultId]).toBe("Run");
    expect(options.buttons[options.cancelId]).toBe("Cancel");
  });

  it("never claims anything has already run", () => {
    const options = confirmOptionsFor(step());
    const text = `${options.message} ${options.detail}`.toLowerCase();
    expect(text).not.toMatch(/\binstalled\b|\bran\b|\bcomplete\b/);
  });
});

describe("consoleArgv", () => {
  it("runs PowerShell with -NoExit so the result stays on screen", () => {
    const argv = consoleArgv("node --version");
    expect(argv.file).toBe("powershell.exe");
    expect(argv.args).toContain("-NoExit");
    expect(argv.args).toContain("-NoProfile");
  });

  it("echoes the exact command before running it", () => {
    const argv = consoleArgv("winget install --id=Git.Git -e");
    const script = argv.args[argv.args.length - 1]!;
    expect(script).toContain("winget install --id=Git.Git -e");
    expect(script.indexOf("Write-Host")).toBeLessThan(script.indexOf("winget install"));
  });

  it("escapes an embedded single quote so the echoed line stays valid PowerShell", () => {
    const argv = consoleArgv("echo 'hello'");
    const script = argv.args[argv.args.length - 1]!;
    expect(script).toContain("echo ''hello''");
  });

  it("refreshes installed PATH entries and quotes native probe executables and arguments", () => {
    const script = probeCommand("C:\\Users\\O'Neil\\npm.cmd", ["config", "get", "prefix"]);
    expect(script).toContain("GetEnvironmentVariable('Path', 'User')");
    expect(script).toContain("& 'C:\\Users\\O''Neil\\npm.cmd' 'config' 'get' 'prefix'");
    expect(script).toContain("if (-not $?) { exit 1 }");
  });
});

describe("firstUnmetDependency", () => {
  const claudeCli = step({ id: "claude-cli", detected: false });
  const claudeLogin = step({ id: "claude-login", detected: false, blockedBy: ["claude-cli"] });

  it("names the first undetected dependency", () => {
    expect(firstUnmetDependency(claudeLogin, [claudeCli, claudeLogin])).toBe("claude-cli");
  });

  it("is null once every dependency is detected", () => {
    const cliDone = { ...claudeCli, detected: true };
    expect(firstUnmetDependency(claudeLogin, [cliDone, claudeLogin])).toBeNull();
  });

  it("is null for a step with no blockedBy at all", () => {
    expect(firstUnmetDependency(claudeCli, [claudeCli])).toBeNull();
  });

  it("treats a dependency id that is not in the list as unmet", () => {
    const orphan = step({ id: "codex-login", blockedBy: ["codex-cli"] });
    expect(firstUnmetDependency(orphan, [orphan])).toBe("codex-cli");
  });
});
