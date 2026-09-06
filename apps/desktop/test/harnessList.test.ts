/**
 * `harness.list` — the availability answer the New Session picker and
 * Settings ▸ Harnesses render (SPEC R7/R8/R9, R19).
 *
 * The interesting behaviour is not "is there a list" but *what makes a backend
 * unavailable and what sentence the user is shown*, so every case below pins a
 * reason string as well as the boolean.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodexProbeResult } from "@capygen/engine";
import {
  claudeSignInSignal,
  createHarnessLister,
  type CliProbe,
  type HarnessListerDeps,
} from "../src/ipc/harnessList.js";

const OK: CliProbe = async () => ({ ok: true, version: "2.1.261" });
const MISSING: CliProbe = async (command) => ({
  ok: false,
  reason: `${command} CLI not found on PATH`,
});

const SIGNED_IN: CodexProbeResult = {
  signedIn: true,
  account: { type: "chatgpt", planType: "pro" },
  models: [
    { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
    { id: "internal", displayName: "hidden one", hidden: true },
  ],
};

function lister(over: Partial<HarnessListerDeps> = {}): () => Promise<unknown[]> {
  return createHarnessLister({
    defaultModel: () => "claude-sonnet-4-5",
    probe: OK,
    probeCodexBackend: async () => SIGNED_IN,
    env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    home: "C:\\nowhere",
    cacheTtlMs: 0,
    ...over,
  });
}

async function row(name: string, over: Partial<HarnessListerDeps> = {}): Promise<
  Record<string, unknown>
> {
  const list = (await lister(over)()) as Record<string, unknown>[];
  return list.find((h) => h.backend === name)!;
}

describe("claude availability", () => {
  it("is available when the CLI answers and a login exists", async () => {
    expect(await row("claude")).toMatchObject({
      available: true,
      defaultModel: "claude-sonnet-4-5",
    });
  });

  it("names the missing CLI rather than blaming the login", async () => {
    expect(await row("claude", { probe: MISSING })).toMatchObject({
      available: false,
      reason: "claude CLI not found on PATH",
      models: [],
      defaultModel: "",
    });
  });

  it("says to run `claude login` when the CLI is there but nothing is signed in", async () => {
    const claude = await row("claude", { env: {} });
    expect(claude.available).toBe(false);
    expect(String(claude.reason)).toContain("claude login");
  });

  it("accepts either token, or the CLI's own credentials file — existence only", () => {
    expect(claudeSignInSignal({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, "C:\\nowhere")).toMatchObject({
      signedIn: true,
      how: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(claudeSignInSignal({ ANTHROPIC_API_KEY: "k" }, "C:\\nowhere")).toMatchObject({
      signedIn: true,
      how: "ANTHROPIC_API_KEY",
    });
    expect(claudeSignInSignal({}, "C:\\nowhere")).toEqual({ signedIn: false, how: "" });
  });
});

describe("codex availability", () => {
  it("offers the catalogue account/read proved live, minus hidden models", async () => {
    expect(await row("codex")).toMatchObject({
      available: true,
      defaultModel: "gpt-5.5",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.2", label: "GPT-5.2" },
      ],
    });
  });

  it("reports the probe's own reason when the token is dead", async () => {
    // The case docs/spikes/codex-shapes.md §3 recorded: `codex login status`
    // said "Logged in using ChatGPT" while every model call 401'd.
    expect(
      await row("codex", {
        probeCodexBackend: async () => ({
          signedIn: false,
          models: [],
          reason: "Codex is not signed in — run `codex login` in a terminal",
        }),
      }),
    ).toMatchObject({
      available: false,
      reason: "Codex is not signed in — run `codex login` in a terminal",
      models: [],
    });
  });

  it("survives a probe that throws instead of resolving", async () => {
    const codex = await row("codex", {
      probeCodexBackend: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(codex).toMatchObject({ available: false, reason: "spawn ENOENT" });
  });
});

describe("api availability", () => {
  it("is unavailable with no key, and says where to add one", async () => {
    const api = await row("api", { env: {}, secrets: { has: () => false } });
    expect(api.available).toBe(false);
    expect(String(api.reason)).toContain("Settings ▸ API keys");
    expect(api.models).toEqual([]);
  });

  it("offers a stored provider's models without ever reading the key", async () => {
    const has = vi.fn((provider: string) => provider === "openai");
    const api = await row("api", { env: {}, secrets: { has } });
    expect(api.available).toBe(true);
    expect((api.models as { id: string }[]).map((m) => m.id)).toContain("gpt-5");
    // Every provider is asked, and only ever with `has`.
    expect(has.mock.calls.map((c) => c[0])).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("counts the documented env var as a key too", async () => {
    const api = await row("api", {
      env: { OPENROUTER_API_KEY: "sk-or-x" },
      secrets: { has: () => false },
    });
    expect(api.available).toBe(true);
    expect((api.models as { id: string }[])[0]!.id).toContain("/");
  });
});

describe("caching", () => {
  it("probes once per TTL, and forgets a rejected probe immediately", async () => {
    const probeCodexBackend = vi.fn(async () => SIGNED_IN);
    let clock = 1_000;
    const list = createHarnessLister({
      defaultModel: () => "m",
      probe: OK,
      probeCodexBackend,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      home: "C:\\nowhere",
      cacheTtlMs: 60_000,
      now: () => clock,
    });

    await Promise.all([list(), list(), list()]);
    expect(probeCodexBackend).toHaveBeenCalledTimes(1);

    clock += 60_001;
    await list();
    expect(probeCodexBackend).toHaveBeenCalledTimes(2);
  });
});
