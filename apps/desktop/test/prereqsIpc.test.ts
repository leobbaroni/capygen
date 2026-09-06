/**
 * `prereqs.status` / `prereqs.run` wired end to end (SPEC R3/R27): the gate
 * behaviour — confirm before running, refuse a step out of order, and never
 * launch anything on Cancel — with a fake confirm/console/probe so nothing
 * here spawns a real PowerShell window or touches the real machine.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodexProbeResult } from "@capygen/engine";
import { cachedCodexProbe, createPrereqsIpc, type PrereqsIpcDeps } from "../src/ipc/prereqs.js";
import type { ConfirmOptions, ConsoleArgv } from "../src/prereqs/runGate.js";
import type { CliProbe } from "../src/ipc/harnessList.js";

const ALL_FOUND: CliProbe = async (command) => ({ ok: true, version: `${command}-v1` });
const NONE: CliProbe = async (command) => ({ ok: false, reason: `${command} not found` });
const SIGNED_IN: CodexProbeResult = { signedIn: true, models: [] };

function ipc(over: Partial<PrereqsIpcDeps> = {}) {
  const openConsole = vi.fn((_argv: ConsoleArgv) => ({ pid: 4242 }));
  const confirm = vi.fn(async (_options: ConfirmOptions) => true);
  const deps: PrereqsIpcDeps = {
    probe: NONE,
    probeCodexBackend: async () => SIGNED_IN,
    env: {},
    home: "C:\\nowhere",
    exists: () => false,
    confirm,
    openConsole,
    cacheTtlMs: 0,
    ...over,
  };
  return { ...createPrereqsIpc(deps), openConsole, confirm };
}

describe("prereqs.status", () => {
  it("returns the step list and a recommendation", async () => {
    const { handlers } = ipc({ probe: ALL_FOUND });
    const result = await handlers["prereqs.status"]({});
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.recommendation.length).toBeGreaterThan(0);
    expect(result.steps.find((s) => s.id === "claude-cli")?.detected).toBe(true);
  });
});

describe("prereqs.run", () => {
  it("confirms before launching, then launches the exact console argv for the step", async () => {
    const { handlers, confirm, openConsole } = ipc({ probe: ALL_FOUND });
    const result = await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmedOptions = confirm.mock.calls[0]![0];
    expect(confirmedOptions.detail).toContain("irm https://claude.ai/install.ps1");
    expect(openConsole).toHaveBeenCalledTimes(1);
    const argv = openConsole.mock.calls[0]![0];
    expect(argv.file).toBe("powershell.exe");
    expect(result).toEqual({ ok: true, started: true });
  });

  it("launches nothing when the user cancels the confirm dialog", async () => {
    const { handlers, openConsole } = ipc({ probe: ALL_FOUND, confirm: async () => false });
    const result = await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(openConsole).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, started: false });
  });

  it("never shows a confirm dialog for an unknown step id", async () => {
    const { handlers, confirm, openConsole } = ipc({ probe: ALL_FOUND });
    const result = await handlers["prereqs.run"]({ stepId: "not-a-real-step" });
    expect(confirm).not.toHaveBeenCalled();
    expect(openConsole).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, started: false });
  });

  it("refuses a step whose dependency is not detected yet, without asking to confirm", async () => {
    // Nothing detected (probe: NONE) — "codex-login" is blockedBy "codex-cli".
    const { handlers, confirm, openConsole } = ipc({ probe: NONE, probeCodexBackend: async () => ({ signedIn: false, models: [] }) });
    const result = await handlers["prereqs.run"]({ stepId: "codex-login" });
    expect(confirm).not.toHaveBeenCalled();
    expect(openConsole).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, started: false });
  });

  it("runs a dependent step once its dependency is detected", async () => {
    const { handlers, openConsole } = ipc({ probe: ALL_FOUND });
    const result = await handlers["prereqs.run"]({ stepId: "claude-login" });
    expect(openConsole).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, started: true });
  });

  it("reports a launch failure honestly instead of claiming success", async () => {
    const { handlers } = ipc({
      probe: ALL_FOUND,
      openConsole: () => {
        throw new Error("ENOENT: powershell.exe");
      },
    });
    const result = await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(result).toEqual({ ok: false, started: false });
  });

  it("survives a confirm dialog that rejects instead of resolving", async () => {
    const { handlers, openConsole } = ipc({
      probe: ALL_FOUND,
      confirm: async () => {
        throw new Error("dialog closed unexpectedly");
      },
    });
    const result = await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(openConsole).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, started: false });
  });
});

describe("cachedCodexProbe", () => {
  it("probes once per TTL — N callers mid-flight share one probe", async () => {
    const probe = vi.fn(async () => SIGNED_IN);
    let clock = 1_000;
    const cached = cachedCodexProbe(probe, 60_000, () => clock);

    await Promise.all([cached(), cached(), cached()]);
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 60_001;
    await cached();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("forgets a rejected probe immediately rather than for the whole TTL", async () => {
    let fail = true;
    const probe = vi.fn(async () => {
      if (fail) throw new Error("spawn ENOENT");
      return SIGNED_IN;
    });
    const cached = cachedCodexProbe(probe, 60_000, () => 1_000);

    await expect(cached()).rejects.toThrow("spawn ENOENT");
    fail = false;
    await expect(cached()).resolves.toEqual(SIGNED_IN);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("is what createPrereqsIpc uses by default — an explicit dep bypasses it entirely", async () => {
    const probeCodexBackend = vi.fn(async () => SIGNED_IN);
    const { handlers } = createPrereqsIpc({
      probe: ALL_FOUND,
      env: {},
      home: "C:\\nowhere",
      exists: () => false,
      confirm: async () => true,
      openConsole: () => ({ pid: 1 }),
      probeCodexBackend,
    });
    await Promise.all([handlers["prereqs.status"]({}), handlers["prereqs.status"]({})]);
    // No caching applied here — passing the dep explicitly opts out of the
    // wrapper, exactly like `harnessList.ts`'s own `probeCodexBackend` dep.
    expect(probeCodexBackend).toHaveBeenCalledTimes(2);
  });
});

describe("background re-detect after a run (prereqs.changed)", () => {
  it("polls and broadcasts the fresh steps, then stops once the run step is detected", async () => {
    let detected = false;
    const probe: CliProbe = async (command, args) =>
      detected ? ALL_FOUND(command, args) : NONE(command, args);
    const broadcastChanged = vi.fn((_steps: unknown) => {});
    const { handlers } = createPrereqsIpc({
      probe,
      probeCodexBackend: async () => SIGNED_IN,
      env: {},
      home: "C:\\nowhere",
      exists: () => false,
      confirm: async () => true,
      openConsole: () => ({ pid: 1 }),
      broadcastChanged,
      pollIntervalMs: 10,
    });

    await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(broadcastChanged).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 15));
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
    const firstCall = broadcastChanged.mock.calls[0]![0] as { id: string; detected: boolean }[];
    expect(firstCall.find((s) => s.id === "claude-cli")?.detected).toBe(false);

    detected = true;
    await new Promise((r) => setTimeout(r, 25));
    // Stops polling once detected — exactly one more broadcast, not several.
    const calls = broadcastChanged.mock.calls.length;
    await new Promise((r) => setTimeout(r, 25));
    expect(broadcastChanged.mock.calls.length).toBe(calls);
    expect(
      (broadcastChanged.mock.calls[broadcastChanged.mock.calls.length - 1]![0] as {
        id: string;
        detected: boolean;
      }[]).find((s) => s.id === "claude-cli")?.detected,
    ).toBe(true);
  });

  it("never polls when no broadcastChanged dep is given", async () => {
    const setIntervalFn = vi.fn(setInterval);
    const { handlers } = createPrereqsIpc({
      probe: ALL_FOUND,
      probeCodexBackend: async () => SIGNED_IN,
      env: {},
      home: "C:\\nowhere",
      exists: () => false,
      confirm: async () => true,
      openConsole: () => ({ pid: 1 }),
      setIntervalFn,
    });
    await handlers["prereqs.run"]({ stepId: "claude-cli" });
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});
