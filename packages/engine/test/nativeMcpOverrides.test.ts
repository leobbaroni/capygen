import { describe, expect, it, vi } from "vitest";
import type { HarnessAgent, HarnessSession } from "../src/harness.js";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import {
  isSafeServerName,
  mergeReservedServers,
  sessionOverridesMcp,
  toClaudeMcpServers,
  toCodexMcpServers,
} from "../src/config/nativeMcpOverrides.js";
import type { McpServerConfig } from "../src/mcp/client/types.js";
import { makeFakeSdk } from "./fakeSdk.js";

/** The SDK query is created lazily on the first turn, so drive one. */
async function optionsAfterTurn(harness: ClaudeHarness, fake: ReturnType<typeof makeFakeSdk>) {
  const events = harness.send({ turnId: "trn_1", text: "hi" });
  const drained = (async () => { for await (const event of events) void event; })()
    .catch(() => {});
  await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
  const options = fake.options() as Record<string, unknown>;
  await harness.interrupt();
  fake.out.close?.();
  await drained;
  return options;
}

/**
 * The session's MCP set as the backend actually receives it.
 *
 * The desktop tests prove the runner hands the set over; these prove the
 * harness turns it into the option the SDK is called with — the half that
 * decides whether a server really runs.
 */
const SESSION: HarnessSession = { sessionId: "ses_1", projectPath: "C:\\project" };
const AGENT: HarnessAgent = {
  agentId: "agt_1", name: "capy", backend: "claude", model: "claude-sonnet-5",
};

const server = (over: Partial<McpServerConfig>): McpServerConfig => ({
  name: "docs", transport: "stdio", command: "node", args: ["docs.js"],
  source: "agent", ...over,
});

describe("the resolved set becomes Claude's own option", () => {
  it("passes the servers and stops the CLI reading its own files", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      resolvedMcpServers: () => ({ docs: { type: "stdio", command: "node" } }),
    });
    await harness.start(SESSION, AGENT);
    const options = await optionsAfterTurn(harness, fake);

    expect(options.mcpServers).toMatchObject({ docs: { type: "stdio", command: "node" } });
    // Without this the CLI would *also* load its own configuration, starting
    // every native server twice — and a session could never switch one off.
    expect(options.strictMcpConfig).toBe(true);
    await harness.dispose();
  });

  it("keeps session overrides authoritative even with a non-strict native default", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      resolvedMcpServers: () => ({ docs: { type: "stdio", command: "node" } }),
    });
    // A non-strict default cannot reload servers omitted by this session.
    await harness.start(SESSION, {
      ...AGENT, config: { claude: { strictMcpConfig: false } },
    } as HarnessAgent);
    expect((await optionsAfterTurn(harness, fake)).strictMcpConfig).toBe(true);
    await harness.dispose();
  });

  it("does not touch the option when the session configures nothing", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query });
    await harness.start(SESSION, AGENT);
    const options = await optionsAfterTurn(harness, fake);
    expect(options.mcpServers).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
    await harness.dispose();
  });

  it("keeps capygen's own tool name when a configured server claims it", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      resolvedMcpServers: () => ({ capygen: { type: "stdio", command: "theirs" } }),
      mcpServers: () => ({ capygen: { type: "sdk", name: "capygen" } }),
    });
    await harness.start(SESSION, AGENT);
    const servers = (await optionsAfterTurn(harness, fake))
      .mcpServers as Record<string, unknown>;
    // The model calls `mcp__capygen__delegate_task`, a name built from the
    // server name, so capygen's own server must keep it. The user's colliding
    // entry is the one that cannot be applied — and it is logged, not renamed
    // into a tool name they never configured.
    expect(servers.capygen).toMatchObject({ type: "sdk" });
    expect(Object.keys(servers)).toEqual(["capygen"]);
    await harness.dispose();
  });

  it("refuses to start rather than silently running the CLI's own list", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      resolvedMcpServers: () => { throw new Error("resolver credential sk-ant-fixtureSecret"); },
    });
    await harness.start(SESSION, AGENT);
    // The set is resolved when the backend session is created — the first turn
    // — so that is where the refusal lands. Failing open would run servers the
    // session had switched off.
    const seen: unknown[] = [];
    for await (const event of harness.send({ turnId: "trn_1", text: "hi" })) seen.push(event);
    // The turn ends in error rather than running: no session is created, so
    // nothing was started on the CLI's own list.
    const text = JSON.stringify(seen);
    expect(text).toMatch(/MCP server list could not be resolved/);
    expect(text).not.toContain("fixtureSecret");
    expect(text).toMatch(/error/);
    await harness.dispose();
  });
});

describe("the converters say what each backend can express", () => {
  it("renders stdio and http for Claude, and drops a disabled entry", () => {
    // Claude's set is authoritative under `strictMcpConfig`, so omission
    // genuinely suppresses and a disabled entry simply is not there.
    const converted = toClaudeMcpServers([
      server({ name: "a" }),
      server({ name: "b", transport: "http", url: "https://x.invalid", command: undefined }),
      server({ name: "off", disabled: true }),
    ]);
    expect(converted.servers).toEqual({
      a: { type: "stdio", command: "node", args: ["docs.js"] },
      b: { type: "http", url: "https://x.invalid" },
    });
    expect(converted.notApplied).toEqual([]);
  });

  it("renders Codex's table for http as well as stdio", () => {
    // Not stdio-only: `CodexConfigStore.mcpServerToml` writes `url` and
    // `http_headers` for http and sse, and this mirrors that exact shape.
    const converted = toCodexMcpServers([
      server({ name: "a", env: { PATH: "x" } }),
      server({
        name: "b", transport: "http", url: "https://x.invalid",
        command: undefined, headers: { "X-Trace": "1" },
      }),
    ]);
    expect(converted.servers).toEqual({
      a: { command: "node", args: ["docs.js"], env: { PATH: "x" } },
      b: { url: "https://x.invalid", http_headers: { "X-Trace": "1" } },
    });
    expect(converted.notApplied).toEqual([]);
  });

  it("emits an explicit Codex disable instead of omitting an inherited entry", () => {
    // Omission cannot suppress anything for Codex — a per-thread config merges
    // with the home's config.toml (probed and refuted) — so `enabled = false`
    // is the explicit native override mechanism.
    const converted = toCodexMcpServers([server({ name: "off", disabled: true })]);
    expect(converted.servers).toEqual({ off: { enabled: false } });
    // Claude needs no such flag and claims no such uncertainty.
    expect(toClaudeMcpServers([server({ name: "off", disabled: true })]).servers)
      .toEqual({});
  });

  it("reports a server it could not carry instead of dropping it silently", () => {
    for (const convert of [toClaudeMcpServers, toCodexMcpServers]) {
      const converted = convert([
        server({ name: "nocmd", command: undefined }),
        server({ name: "nourl", transport: "http", url: undefined, command: undefined }),
      ]);
      expect(Object.keys(converted.servers)).toEqual([]);
      expect(converted.notApplied.map((entry) => entry.name)).toEqual(["nocmd", "nourl"]);
      for (const entry of converted.notApplied) expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses a name that could reach an object's prototype", () => {
    for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
      expect(isSafeServerName(name), name).toBe(false);
      for (const convert of [toClaudeMcpServers, toCodexMcpServers]) {
        const converted = convert([server({ name })]);
        // Not merely absent from the output — reported, and the record's own
        // prototype is untouched.
        expect(converted.notApplied.map((entry) => entry.name)).toEqual([name]);
        expect(Object.getPrototypeOf(converted.servers)).toBeNull();
        expect(({} as Record<string, unknown>)[name]).not.toEqual(
          { type: "stdio", command: "node", args: ["docs.js"] });
      }
    }
    expect(isSafeServerName("docs_1.a-b")).toBe(true);
    expect(isSafeServerName("has space")).toBe(false);
  });

  it("sees an override in an addition and in a disable alike", () => {
    const native = server({ name: "n", source: "claude-settings" });
    expect(sessionOverridesMcp([native], [])).toBe(false);
    expect(sessionOverridesMcp([native, server({ name: "own" })], [])).toBe(true);
    // Resolution already removed the disabled entry, so only the agent's own
    // object still shows that the session changed anything.
    expect(sessionOverridesMcp([native], [server({ name: "n", disabled: true })])).toBe(true);
  });

  it("keeps capygen's own server name and reports the entry it displaces", () => {
    expect(mergeReservedServers({ a: {} }, { b: {} }))
      .toMatchObject({ merged: { a: {}, b: {} }, displaced: [] });
    // capygen's server keeps the name the model's tool name is built from
    // (`mcp__capygen__delegate_task`); renaming it would silently change the
    // tool the routing policy tells the model to call.
    const clash = mergeReservedServers({ capygen: { command: "theirs" } }, { capygen: { type: "sdk" } });
    expect(clash.merged.capygen).toEqual({ type: "sdk" });
    expect(clash.displaced).toEqual(["capygen"]);
    expect(Object.getPrototypeOf(clash.merged)).toBeNull();
  });
});
