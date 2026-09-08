import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { McpServerConfig } from "@capygen/engine";
import { createSessionRunner } from "../src/engine/SessionRunner.js";
import type { Engine } from "../src/engine/types.js";

/**
 * A session's own MCP servers reaching the native backend that runs them.
 *
 * The gap this covers was invisible from the runner's own vantage point: the
 * configs were resolved and handed to the API harness and the widget host, and
 * the Claude factory got only capygen's delegation server — so a session that
 * added a server saw an empty list at run time.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let dir: string;
let store: CapygenStore;
let projectId: string;
let engine: Engine;
let built: Array<{ backend: string; resolved: Record<string, unknown> | null }>;
let resolved: McpServerConfig[];
let warnings: string[];

const server = (over: Partial<McpServerConfig>): McpServerConfig => ({
  name: "docs", transport: "stdio", command: "node", args: ["docs.js"],
  source: "agent", ...over,
});

function wire(): void {
  built = [];
  warnings = [];
  engine = createSessionRunner({
    store,
    broadcast: () => {},
    log: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    resolveMcpServers: () => resolved,
    makeHarness: (agent, extras) => {
      built.push({
        backend: agent.backend,
        resolved: extras.resolvedMcpServers ? extras.resolvedMcpServers() : null,
      });
      return {
        start: async () => {},
        send: () => (async function* () {})(),
        interrupt: async () => {},
        dispose: async () => {},
      } as never;
    },
  });
}

function sessionOn(backend: "api" | "claude" | "codex", mcpServers?: unknown) {
  return store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{
      name: "A", backend,
      model: backend === "codex" ? "gpt-5-codex" : "claude-opus-5", role: "lead",
      config: mcpServers === undefined
        ? (backend === "api" ? { api: { provider: "anthropic" } } : null)
        : { [backend]: { ...(backend === "api" ? { provider: "anthropic" } : {}), mcpServers } },
    }],
  });
}

const run = async (sessionId: string, agentId: string): Promise<void> => {
  const turn = store.turns.create({ sessionId, role: "user", status: "done" });
  engine.send({ sessionId, turnId: turn.id, agentId, text: "hello" });
  await settle();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-session-mcp-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  resolved = [];
  wire();
});

afterEach(async () => {
  await engine.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session's own servers reach the native runtime", () => {
  it("hands Claude the resolved set when the session configures one", async () => {
    resolved = [server({}), server({ name: "native", source: "claude-settings" })];
    const created = sessionOn("claude", { docs: { command: "node", args: ["docs.js"] } });
    await run(created.session.id, created.agents[0]!.id);

    // The whole resolved set, so the CLI can be told to stop reading its own
    // files — the only way a session can also *remove* a server.
    expect(built[0]!.resolved).toMatchObject({
      docs: { type: "stdio", command: "node", args: ["docs.js"] },
      native: { type: "stdio" },
    });
  });

  it("hands Codex the same set in its own table's vocabulary", async () => {
    resolved = [server({ name: "docs" })];
    const created = sessionOn("codex", { docs: { command: "node", args: ["docs.js"] } });
    await run(created.session.id, created.agents[0]!.id);
    // `mcp_servers` shape: command/args/env, no `type` discriminator.
    expect(built[0]!.resolved).toEqual({ docs: { command: "node", args: ["docs.js"] } });
  });

  it("leaves an unconfigured session's backend reading its own files", async () => {
    resolved = [server({ name: "native", source: "claude-settings" })];
    const created = sessionOn("claude");
    await run(created.session.id, created.agents[0]!.id);
    // No override: handing the list over anyway would start every native
    // server twice, once by the CLI and once from what we passed.
    expect(built[0]!.resolved).toBeNull();
  });

  it("overrides for a session that only disables a native server", async () => {
    // Resolution removes the disabled entry, so the resolved list alone cannot
    // show that anything changed — the agent's own object is what proves it.
    resolved = [server({ name: "kept", source: "claude-settings" })];
    const created = sessionOn("claude", { native: { command: "x", disabled: true } });
    await run(created.session.id, created.agents[0]!.id);
    expect(built[0]!.resolved).toEqual({ kept: expect.objectContaining({ type: "stdio" }) });
    expect(built[0]!.resolved).not.toHaveProperty("native");
  });

  it("carries an http server to Codex too, in its own table's keys", async () => {
    // Not stdio-only: `CodexConfigStore` reads and writes `url`/`http_headers`,
    // and `thread/start`'s config takes that same table.
    resolved = [
      server({ name: "docs" }),
      server({
        name: "remote", transport: "http", url: "https://example.invalid/mcp",
        command: undefined, headers: { "X-Trace": "1" },
      }),
    ];
    const created = sessionOn("codex", { remote: { transport: "http" } });
    await run(created.session.id, created.agents[0]!.id);
    expect(built[0]!.resolved).toEqual({
      docs: { command: "node", args: ["docs.js"] },
      remote: { url: "https://example.invalid/mcp", http_headers: { "X-Trace": "1" } },
    });
  });

  it("restores an explicit Codex disable after resolution omits disabled entries", async () => {
    // A per-thread config merges with the home's config.toml, so omission
    // suppresses nothing; the named enabled=false override is required.
    resolved = [server({ name: "kept" })];
    const created = sessionOn("codex", { off: { command: "x", disabled: true } });
    // The agent's own disabled entry is what the resolver removed, so it is
    // re-read from the config rather than from the resolved list.
    await run(created.session.id, created.agents[0]!.id);
    expect(built[0]!.resolved).toMatchObject({ off: { enabled: false } });
    expect(built[0]!.resolved).toMatchObject({ kept: { command: "node" } });
  });

  it("names a server it could not carry rather than dropping it silently", async () => {
    resolved = [
      server({ name: "docs" }),
      server({ name: "broken", transport: "http", url: undefined, command: undefined }),
    ];
    const created = sessionOn("claude", { broken: { transport: "http" } });
    await run(created.session.id, created.agents[0]!.id);
    expect(built[0]!.resolved).toEqual({ docs: expect.any(Object) });
    expect(warnings.join(" ")).toMatch(/"broken" was not applied because/);
  });
});

describe("per-agent isolation and reconfiguration", () => {
  it("gives each agent its own set rather than one session-wide list", async () => {
    const created = store.sessions.create({
      projectId, mode: "round-table", title: "T",
      agents: [
        { name: "One", backend: "claude", model: "claude-opus-5", role: "lead",
          config: { claude: { mcpServers: { one: { command: "one" } } } } },
        { name: "Two", backend: "claude", model: "claude-opus-5", role: "member",
          config: { claude: { mcpServers: { two: { command: "two" } } } } },
      ],
    });
    // The resolver answers per agent, exactly as `IntegrationsService` does.
    resolved = [server({ name: "one", command: "one" })];
    await run(created.session.id, created.agents[0]!.id);
    resolved = [server({ name: "two", command: "two" })];
    await run(created.session.id, created.agents[1]!.id);

    expect(built[0]!.resolved).toHaveProperty("one");
    expect(built[0]!.resolved).not.toHaveProperty("two");
    expect(built[1]!.resolved).toHaveProperty("two");
    expect(built[1]!.resolved).not.toHaveProperty("one");
  });

  it("re-resolves after the agent's configuration changes", async () => {
    resolved = [server({ name: "before" })];
    const created = sessionOn("claude", { before: { command: "a" } });
    const agentId = created.agents[0]!.id;
    await run(created.session.id, agentId);
    expect(built[0]!.resolved).toHaveProperty("before");

    // A config change evicts the harness; the next turn is captured afresh.
    resolved = [server({ name: "after" })];
    store.sessions.updateAgent(agentId, { config: { claude: { mcpServers: { after: { command: "b" } } } } });
    engine.agentConfigChanged?.(agentId);
    await settle();
    await run(created.session.id, agentId);

    expect(built).toHaveLength(2);
    expect(built[1]!.resolved).toHaveProperty("after");
    expect(built[1]!.resolved).not.toHaveProperty("before");
  });

  it("resolves once per capture, not per turn", async () => {
    resolved = [server({ name: "docs" })];
    const created = sessionOn("claude", { docs: { command: "node" } });
    const agentId = created.agents[0]!.id;
    await run(created.session.id, agentId);
    await run(created.session.id, agentId);
    // One harness, one resolution: a list that moved between turns would be a
    // cache miss on every turn (R24).
    expect(built).toHaveLength(1);
  });
});

describe("a catalogue refresh does capygen's own work only once", () => {
  /**
   * The half of the native start count capygen actually owns.
   *
   * `tests/e2e/sessionMcp.spec.ts` counts MCP server *process* starts, which
   * for Codex is one persistent process per thread **plus one transient probe
   * per `mcpServerStatus/list`** — the app-server's own behaviour, reproduced
   * with a plain `config.toml` and no capygen override at all
   * (`e2e-out/review/diag-codex-mcp-lifetimes.ts`). What capygen can guarantee
   * is that it never multiplies that: concurrent refreshes build one harness
   * and issue one backend query.
   */
  function runnerWithCatalogue(answer: unknown) {
    const built: string[] = [];
    const queries: boolean[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = createSessionRunner({
      store,
      broadcast: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      resolveMcpServers: () => resolved,
      makeHarness: (agent) => {
        built.push(agent.backend);
        return {
          start: async () => {},
          send: () => (async function* () {})(),
          interrupt: async () => {},
          dispose: async () => {},
          catalogue: async (options?: { initialize?: boolean }) => {
            queries.push(options?.initialize === true);
            await gate;
            return answer;
          },
        } as never;
      },
    });
    return { engine, built, queries, release: () => release?.() };
  }

  it("builds one harness and asks the backend once for concurrent refreshes", async () => {
    const created = sessionOn("codex", { docs: { command: "node" } });
    const agentId = created.agents[0]!.id;
    const harnessed = runnerWithCatalogue({ kind: "ok", servers: [], truncated: false });
    engine = harnessed.engine;

    const pair = Promise.all([
      engine.catalogueAgent!(created.session.id, agentId, true),
      engine.catalogueAgent!(created.session.id, agentId, true),
    ]);
    await settle();
    // One harness, therefore one thread and one persistent MCP server process,
    // however many callers refresh at once.
    expect(harnessed.built).toHaveLength(1);

    harnessed.release();
    const answers = await pair;
    expect(answers.every((answer) => (answer as { kind: string }).kind === "ok")).toBe(true);
  });

  it("does not start anything for a refresh that was not asked to initialize", async () => {
    const created = sessionOn("codex", { docs: { command: "node" } });
    const harnessed = runnerWithCatalogue({ kind: "ok", servers: [], truncated: false });
    engine = harnessed.engine;
    expect(await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, false))
      .toEqual({ kind: "notStarted" });
    // No harness, so no thread and no MCP server process.
    expect(harnessed.built).toHaveLength(0);
    expect(harnessed.queries).toHaveLength(0);
  });
});
