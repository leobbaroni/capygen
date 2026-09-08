/**
 * Setup panel detection (SPEC R3) — the step list and what makes each step
 * `detected`, on a fake PATH/home so nothing here touches the real machine.
 */
import { describe, expect, it } from "vitest";
import type { CodexProbeResult } from "@capygen/engine";
import type { PrereqStep } from "@capygen/shared";
import {
  detectClaudeCli,
  detectCodexCli,
  detectPrereqSteps,
  recommendationFor,
  type DetectPrereqsDeps,
} from "../src/prereqs/detect.js";
import type { CliProbe } from "../src/ipc/harnessList.js";

const NONE: CliProbe = async (command) => ({ ok: false, reason: `${command} not found` });

function probeFor(found: Record<string, string>): CliProbe {
  return async (command) => {
    if (command in found) return { ok: true, version: found[command] };
    return { ok: false, reason: `${command} not found` };
  };
}

const SIGNED_OUT: CodexProbeResult = { signedIn: false, models: [] };
const SIGNED_IN: CodexProbeResult = { signedIn: true, models: [], account: { type: "chatgpt" } };

describe("detectClaudeCli", () => {
  it("is found on PATH first", async () => {
    const deps: DetectPrereqsDeps = { probe: probeFor({ claude: "2.1.261" }) };
    expect(await detectClaudeCli(deps)).toEqual({ found: true, version: "2.1.261" });
  });

  it("falls back to the native installer's fixed location", async () => {
    const deps: DetectPrereqsDeps = {
      probe: NONE,
      home: "C:\\Users\\fake",
      exists: (p) => p === "C:\\Users\\fake\\.local\\bin\\claude.exe",
    };
    const result = await detectClaudeCli(deps);
    expect(result.found).toBe(true);
    expect(result.path).toBe("C:\\Users\\fake\\.local\\bin\\claude.exe");
  });

  it("falls back to an npm-global shim when neither PATH nor the native path has it", async () => {
    const deps: DetectPrereqsDeps = {
      probe: probeFor({ npm: "C:\\npm\\prefix" }),
      home: "C:\\Users\\fake",
      exists: (p) => p === "C:\\npm\\prefix\\claude.cmd",
    };
    const result = await detectClaudeCli(deps);
    expect(result.found).toBe(true);
    expect(result.path).toBe("C:\\npm\\prefix\\claude.cmd");
  });

  it("is not found when none of the three checks succeed", async () => {
    const deps: DetectPrereqsDeps = { probe: NONE, home: "C:\\nowhere", exists: () => false };
    expect(await detectClaudeCli(deps)).toEqual({ found: false });
  });
});

describe("detectCodexCli", () => {
  it("is PATH-only", async () => {
    expect(await detectCodexCli({ probe: probeFor({ codex: "0.153.4" }) })).toEqual({
      found: true,
      version: "0.153.4",
    });
    expect(await detectCodexCli({ probe: NONE })).toEqual({ found: false });
  });
});

describe("detectPrereqSteps", () => {
  it("uses the discovered absolute Claude path in the exact sign-in command", async () => {
    const steps = await detectPrereqSteps({ probe: NONE, home: "C:\\Users\\O'Neil", exists: (file) => file.endsWith("\\.local\\bin\\claude.exe"), probeCodexBackend: async () => SIGNED_OUT, env: {} });
    expect(steps.find((step) => step.id === "claude-login")?.command).toBe("& 'C:\\Users\\O''Neil\\.local\\bin\\claude.exe'");
  });
  const ALL_FOUND = probeFor({
    node: "v22.16.0",
    git: "git version 2.44.0",
    rg: "ripgrep 14.1.0",
    claude: "2.1.261",
    codex: "0.153.4",
    uv: "uv 0.9.0",
    wt: "1.22.0",
  });

  it("lists every step this panel promises, each with an exact command", async () => {
    const steps = await detectPrereqSteps({
      probe: ALL_FOUND,
      probeCodexBackend: async () => SIGNED_IN,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      home: "C:\\nowhere",
    });
    expect(steps.map((s) => s.id)).toEqual([
      "node",
      "git",
      "ripgrep",
      "claude-cli",
      "claude-login",
      "codex-cli",
      "codex-login",
      "uv",
      "windows-terminal",
    ]);
    for (const step of steps) {
      expect(step.command.length).toBeGreaterThan(0);
      expect(typeof step.detected).toBe("boolean");
    }
  });

  it("marks every step detected when everything is present and signed in", async () => {
    const steps = await detectPrereqSteps({
      probe: ALL_FOUND,
      probeCodexBackend: async () => SIGNED_IN,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      home: "C:\\nowhere",
    });
    expect(steps.every((s) => s.detected)).toBe(true);
  });

  it("names the sign-in steps' dependency, not the sign-in condition itself", async () => {
    const steps = await detectPrereqSteps({
      probe: NONE,
      probeCodexBackend: async () => SIGNED_OUT,
      env: {},
      home: "C:\\nowhere",
      exists: () => false,
    });
    const claudeLogin = steps.find((s) => s.id === "claude-login")!;
    const codexLogin = steps.find((s) => s.id === "codex-login")!;
    expect(claudeLogin.blockedBy).toEqual(["claude-cli"]);
    expect(codexLogin.blockedBy).toEqual(["codex-cli"]);
    expect(claudeLogin.detected).toBe(false);
    expect(codexLogin.detected).toBe(false);
  });

  it("survives a codex probe that rejects instead of resolving", async () => {
    const steps = await detectPrereqSteps({
      probe: NONE,
      probeCodexBackend: async () => {
        throw new Error("spawn ENOENT");
      },
      env: {},
      home: "C:\\nowhere",
      exists: () => false,
    });
    expect(steps.find((s) => s.id === "codex-login")!.detected).toBe(false);
  });
});

describe("recommendationFor", () => {
  function stepsWith(detected: Record<string, boolean>): PrereqStep[] {
    const ids = ["claude-cli", "claude-login", "codex-cli", "codex-login"];
    return ids.map((id) => ({
      id,
      title: id,
      detected: detected[id] ?? false,
      command: "x",
      description: "",
      kind: "cli",
    }));
  }

  it("says nothing is ready when neither backend is", () => {
    expect(recommendationFor(stepsWith({}))).toContain("Install and sign in");
  });

  it("names the CLI-installed-not-signed-in state distinctly", () => {
    expect(recommendationFor(stepsWith({ "claude-cli": true }))).toContain("not signed in");
  });

  it("says Claude is ready and Codex is optional", () => {
    const text = recommendationFor(stepsWith({ "claude-cli": true, "claude-login": true }));
    expect(text).toContain("Claude Code is ready");
    expect(text).toContain("optional");
  });

  it("says both are ready", () => {
    const text = recommendationFor(
      stepsWith({
        "claude-cli": true,
        "claude-login": true,
        "codex-cli": true,
        "codex-login": true,
      }),
    );
    expect(text).toBe("Claude Code and Codex are both ready to use.");
  });
});
