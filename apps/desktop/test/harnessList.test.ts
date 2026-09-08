/**
 * `harness.list` — the availability answer the New Session picker and
 * Settings ▸ Harnesses render (SPEC R7/R8/R9, R19).
 *
 * The interesting behaviour is not "is there a list" but *what makes a backend
 * unavailable and what sentence the user is shown*, so every case below pins a
 * reason string as well as the boolean.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
    { id: "internal", displayName: "hidden one", hidden: true },
  ],
};

function lister(over: Partial<HarnessListerDeps> = {}): () => Promise<unknown[]> {
  return createHarnessLister({
    probeClaudeBackend: async () => ({ models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low"] }] }),
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

  it("[C] looks for the credentials inside CLAUDE_CONFIG_DIR when one is set", () => {
    // An isolated home (`CAPYGEN_CLAUDE_CONFIG_DIR` → `CLAUDE_CONFIG_DIR`,
    // `win/configHomes.ts`) moves `.credentials.json` with it. Reading the
    // fixed `~/.claude` there reported a login the SDK would never find.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-signin-"));
    try {
      const home = "C:\\Users\\somebody";
      expect(claudeSignInSignal({ CLAUDE_CONFIG_DIR: isolated }, home).signedIn).toBe(false);
      fs.writeFileSync(path.join(isolated, ".credentials.json"), "{}", "utf8");
      const signal = claudeSignInSignal({ CLAUDE_CONFIG_DIR: isolated }, home);
      expect(signal.signedIn).toBe(true);
      expect(signal.how).toBe(path.join(isolated, ".credentials.json"));
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  describe("[C] a credentials file that exists but holds nothing", () => {
    let dir: string;
    const file = () => path.join(dir, ".credentials.json");
    const signal = () => claudeSignInSignal({ CLAUDE_CONFIG_DIR: dir }, "C:\Users\somebody");

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-cred-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function write(oauth: unknown): void {
      fs.writeFileSync(file(), JSON.stringify({ claudeAiOauth: oauth }), "utf8");
    }

    it("is not a login when both token strings are empty", () => {
      // The exact shape this machine has: a Claude Code host that refreshes
      // auth out of process leaves the object in place and the tokens blank.
      write({ accessToken: "", refreshToken: "", expiresAt: 0 });
      const s = signal();
      expect(s.signedIn).toBe(false);
      expect(s.how).toBe("");
      expect(s.reason).toContain("holds no token");
    });

    it("is a login when either token is present", () => {
      write({ accessToken: "a", refreshToken: "" });
      expect(signal().signedIn).toBe(true);
      write({ accessToken: "", refreshToken: "r" });
      expect(signal().signedIn).toBe(true);
    });

    it("ignores an expired ACCESS token — that is the normal state between refreshes", () => {
      write({ accessToken: "a", refreshToken: "r", expiresAt: 1 });
      expect(signal().signedIn).toBe(true);
    });

    it("is not a login once the REFRESH token itself has expired", () => {
      write({ accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: 1 });
      const s = signal();
      expect(s.signedIn).toBe(false);
      expect(s.reason).toContain("expired");
    });

    it("stays a login for a shape it does not recognise, or one it cannot parse", () => {
      // Conservative on purpose: an unknown credential format must not lock a
      // working machine out of its own backend.
      fs.writeFileSync(file(), JSON.stringify({ somethingElse: true }), "utf8");
      expect(signal().signedIn).toBe(true);
      fs.writeFileSync(file(), "{ not json", "utf8");
      expect(signal().signedIn).toBe(true);
    });

    it("surfaces the reason through harness.list rather than a generic line", async () => {
      write({ accessToken: "", refreshToken: "" });
      const rows = (await lister({ env: { CLAUDE_CONFIG_DIR: dir } })()) as {
        backend: string;
        available: boolean;
        reason?: string;
      }[];
      const claude = rows.find((r) => r.backend === "claude");
      expect(claude?.available).toBe(false);
      expect(claude?.reason).toContain("holds no token");
    });
  });
});

describe("codex availability", () => {
  it("offers the catalogue account/read proved live, minus hidden models", async () => {
    expect(await row("codex")).toMatchObject({
      available: true,
      defaultModel: "gpt-5.5",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium"] },
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
    expect(api.models).toContainEqual(expect.objectContaining({ id: "gpt-5", providers: ["openai"] }));
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
    probeClaudeBackend: async () => ({ models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low"] }] }),
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

/**
 * [7-P1] The `api` default is the first model of the **effective** provider.
 * A flattened list began with whichever provider `API_PROVIDERS` names first,
 * so an agent configured for `openai` was offered an Anthropic id as its
 * default — a model that provider cannot run.
 */
describe("the api default follows the selected provider", () => {
  const bothKeys = {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" },
  };

  it("uses the configured provider's own first model", async () => {
    const api = await row("api", { ...bothKeys, apiProvider: () => "openai" });
    expect(api.defaultModel).toBe("gpt-5");
  });

  it("falls back to the first provider with a key when none is configured", async () => {
    const api = await row("api", { ...bothKeys, apiProvider: () => null });
    expect(api.defaultModel).toBe("claude-opus-4-5");
  });

  it("ignores a configured provider that has no key", async () => {
    const api = await row("api", {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t", OPENAI_API_KEY: "o" },
      apiProvider: () => "anthropic",
    });
    expect(api.defaultModel).toBe("gpt-5");
  });
});

/**
 * [7-P1] The synchronous read the model-resolution paths use.
 *
 * `sessions.create`, `agents.*` and `SessionRunner` all have to answer "which
 * model does this backend default to?" without spawning anything, so they read
 * `snapshot()` rather than awaiting the lister. `main.ts` wires the **same**
 * lister to both, which is what makes the two answers the same probe.
 */
describe("snapshot()", () => {
  /** A lister whose probes only settle when the test says so. */
  function deferredLister(): {
    list: ReturnType<typeof createHarnessLister>;
    settle: (result: CodexProbeResult | Error, index?: number) => void;
    codexProbes: number;
  } {
    const pending: ((value: CodexProbeResult | Error) => void)[] = [];
    const state = { codexProbes: 0 };
    const list = createHarnessLister({
    probeClaudeBackend: async () => ({ models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low"] }] }),
      defaultModel: () => "claude-sonnet-4-5",
      probe: OK,
      probeCodexBackend: () => {
        state.codexProbes += 1;
        return new Promise<CodexProbeResult>((resolve, reject) => {
          pending.push((value) => (value instanceof Error ? reject(value) : resolve(value)));
        });
      },
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      home: "C:\\nowhere",
      cacheTtlMs: 0,
    });
    return {
      list,
      /** Settle one in-flight build by index, so completion order can differ
     *  from start order. */
    settle: (result, index = 0) => {
      const resolve = pending[index];
      pending[index] = undefined as never;
      resolve?.(result);
    },
      get codexProbes() {
        return state.codexProbes;
      },
    };
  }

  it("is empty before the first resolution, and reading it never probes", async () => {
    const l = deferredLister();
    expect(l.list.snapshot()).toEqual([]);
    // Read it a few more times: still nothing spawned.
    expect(l.list.snapshot()).toEqual([]);
    expect(l.list.snapshot()).toEqual([]);
    expect(l.codexProbes).toBe(0);

    const listing = l.list();
    expect(l.codexProbes).toBe(1);
    // In flight: the snapshot is still the honest "nothing yet".
    expect(l.list.snapshot()).toEqual([]);

    l.settle(SIGNED_IN);
    await listing;
    expect(l.list.snapshot().map((h) => h.backend)).toEqual(["claude", "codex", "api"]);
    expect(l.list.snapshot().find((h) => h.backend === "codex")?.defaultModel).toBe("gpt-5.5");
    // …and reading the resolved snapshot still spawns nothing.
    expect(l.codexProbes).toBe(1);
  });

  it("keeps the previous answer when a later build fails outright", async () => {
    // A *codex* probe that fails is not a failure — it is a legitimate "codex
    // unavailable" answer, and it updates the snapshot like any other. What
    // must not blank the catalogue is a build that rejects: here the CLI probe
    // throws on the second call.
    let calls = 0;
    const list = createHarnessLister({
    probeClaudeBackend: async () => ({ models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low"] }] }),
      defaultModel: () => "claude-sonnet-4-5",
      probe: async (command, args) => {
        calls += 1;
        if (calls > 1) throw new Error("spawn failed");
        return OK(command, args);
      },
      probeCodexBackend: async () => SIGNED_IN,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      home: "C:\\nowhere",
      cacheTtlMs: 0,
    });

    await list();
    const good = list.snapshot();
    expect(good.find((h) => h.backend === "codex")?.available).toBe(true);

    await list().catch(() => undefined);
    expect(list.snapshot()).toEqual(good);
  });

  it("does not let a slow earlier probe overwrite a newer answer", async () => {
    const l = deferredLister();
    // Two builds in flight; the first will settle last.
    const slow = l.list();
    const fast = l.list();
    expect(l.codexProbes).toBe(2);

    // The **second** build lands first, with a newer catalogue.
    l.settle(
      { signedIn: true, models: [{ id: "gpt-6", displayName: "GPT-6", isDefault: true }] },
      1,
    );
    await fast;
    expect(l.list.snapshot().find((h) => h.backend === "codex")?.defaultModel).toBe("gpt-6");

    // …and the first build finishes afterwards, carrying the older answer.
    l.settle(SIGNED_IN, 0);
    await slow;
    // The later build still wins: ordering is by build, not by completion.
    expect(l.list.snapshot().find((h) => h.backend === "codex")?.defaultModel).toBe("gpt-6");
  });

  it("stays callable for everything that just awaits it", async () => {
    const rows = await lister()();
    expect(rows.map((r) => (r as { backend: string }).backend)).toEqual([
      "claude",
      "codex",
      "api",
    ]);
  });
});

describe("Claude initialized model catalogue", () => {
  it("offers exact current IDs and efforts and replaces a stale default", async () => {
    expect(await row("claude", { probeClaudeBackend: async () => ({ models: [
      { id: "claude-sonnet-current", label: "Current Sonnet", efforts: ["low", "high"] },
    ] }) })).toMatchObject({ available: true, defaultModel: "claude-sonnet-current", models: [
      { id: "claude-sonnet-current", label: "Current Sonnet", efforts: ["low", "high"] },
    ] });
  });
  it("does not invent available models when metadata cannot be read", async () => {
    expect(await row("claude", { probeClaudeBackend: async () => ({ models: [], reason: "Metadata unavailable" }) }))
      .toMatchObject({ available: false, models: [], defaultModel: "", reason: "Metadata unavailable" });
  });
});
