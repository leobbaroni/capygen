/**
 * Phase 7 MCP acceptance: a settings IPC write must reach the exact runtime
 * snapshot used by the API harness and widget host. Every backend home is a
 * temp directory and the only child is the repository's inert MCP fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiHarness,
  type Harness,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type InvokeChannel,
} from "@capygen/shared";
import { createSessionRunner, type HarnessExtras } from "../src/engine/SessionRunner.js";
import { createMcpPoolProbe } from "../src/integrations/probeMcpServer.js";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createMcpPoolRegistry, type McpPoolRegistry } from "../src/ipc/mcpPools.js";
import { createWidgetHost, type WidgetHostHandlers } from "../src/ipc/widgets.js";
import { makeHarness, type Harness as WorkspaceHarness } from "./workspaceHarness.js";

const MCP_FIXTURE = fileURLToPath(
  new URL("../../../tests/fixtures/mcp-apps-server/server.mjs", import.meta.url),
);
const SERVER = "fixture";

let h: WorkspaceHarness;
let ipc: IpcContext;
let pools: McpPoolRegistry;
let widgets: WidgetHostHandlers;
let claudeHome: string;
let codexHome: string;
let apiHarness: ApiHarness | null;
let providerRequests: ProviderRequest[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (value: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function writeClaudeConfig(servers: Record<string, unknown>): void {
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, ".claude.json"), JSON.stringify({ mcpServers: servers }));
}

function readClaudeServers(): Record<string, unknown> {
  const file = path.join(claudeHome, ".claude.json");
  if (!fs.existsSync(file)) return {};
  const root = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
  return root.mcpServers ?? {};
}

/** Minimal Claude CLI double: it writes only the isolated file the real CLI owns. */
async function claudeCli(_command: string, args: string[]) {
  const servers = readClaudeServers();
  if (args[0] === "mcp" && args[1] === "remove") {
    delete servers[args[2] as string];
    writeClaudeConfig(servers);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "mcp" && args[1] === "add") {
    const separator = args.indexOf("--");
    const name = args[(separator >= 0 ? separator : args.length) - 1] as string;
    servers[name] = separator >= 0
      ? { type: "stdio", command: args[separator + 1], args: args.slice(separator + 2) }
      : { type: args[args.indexOf("--transport") + 1], url: args.at(-1) };
    writeClaudeConfig(servers);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "mcp" && args[1] === "list") {
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 1, stdout: "", stderr: "unsupported fixture command" };
}

function scriptedProvider(): Provider {
  let round = 0;
  return {
    provider: "anthropic",
    stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      providerRequests.push(request);
      round += 1;
      return (async function* () {
        if (round === 1) {
          yield {
            type: "content",
            index: 0,
            block: {
              type: "tool_use",
              id: "mcp-call-1",
              name: `mcp__${SERVER}__show_card`,
              input: { title: "Runtime snapshot", note: "from the real fixture" },
            },
          } satisfies ProviderEvent;
          yield { type: "stop", reason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield {
          type: "content",
          index: 0,
          block: { type: "text", text: "fixture completed" },
        } satisfies ProviderEvent;
        yield { type: "stop", reason: "end_turn" } satisfies ProviderEvent;
      })();
    },
  };
}

function makeApiHarness(extras: HarnessExtras): Harness {
  apiHarness = new ApiHarness({
    keys: { getKey: () => "fixture-key" },
    createProvider: async () => scriptedProvider(),
    mcpServers: extras.mcpServerConfigs ?? [],
    acquirePool: (servers) => pools.acquire(servers),
    loadHistory: async () => [],
    log: h.log,
  });
  return apiHarness;
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-scoped-mcp-" });
  claudeHome = path.join(h.dir, "isolated-claude");
  codexHome = path.join(h.dir, "isolated-codex");
  fs.mkdirSync(codexHome, { recursive: true });
  pools = createMcpPoolRegistry({ log: h.log });
  providerRequests = [];
  apiHarness = null;
  widgets = createWidgetHost({
    log: h.log,
    pools,
    projectPathFor: (sessionId) => {
      const session = h.store.sessions.get(sessionId);
      return session ? h.store.projects.get(session.projectId)?.path ?? null : null;
    },
  });
  ipc = createIpcContext({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    pools,
    widgets,
    catalogue: () => [{
      backend: "api",
      label: "API",
      available: true,
      models: [{ id: "claude-opus-4-5", label: "Claude Opus 4.5" }],
      defaultModel: "claude-opus-4-5",
      providers: ["anthropic"],
    }],
    makeEngine: (deps) => createSessionRunner({
      ...deps,
      makeHarness: (agent, extras) => {
        if (agent.backend !== "api") throw new Error("this acceptance turn must use the API harness");
        return makeApiHarness(extras);
      },
    }),
    pickDirectory: async () => h.root,
    appInfo: () => ({
      name: "capygen", version: "0.1.0", electron: "44", chrome: "1", node: process.versions.node,
      platform: process.platform, userDataDir: h.dir, logFile: path.join(h.dir, "app.log"), dbFile: h.store.db.file,
    }),
    integrations: {
      env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
      home: h.dir,
      run: claudeCli,
      ttlMs: 0,
      probeMcpServer: createMcpPoolProbe(pools),
    },
  });
});

afterEach(async () => {
  await ipc.dispose();
  await widgets.dispose();
  await pools.closeAll();
  h.close();
});

describe("scoped MCP settings reach the live runtime", () => {
  it("drives a real API MCP tool and widget through one captured shared pool", async () => {
    await call("integrations.mcp.add", {
      backend: "api",
      scope: "user",
      entry: {
        name: SERVER,
        transport: "stdio",
        command: process.execPath,
        args: [MCP_FIXTURE],
        cwd: h.root,
        source: "acceptance fixture",
      },
    });
    expect(await call("integrations.mcp.test", { backend: "api", name: SERVER })).toEqual({
      ok: true,
      status: "connected",
      tools: ["show_card", "echo"],
    });

    const created = await call("sessions.create", {
      projectId: h.projectId,
      agents: [{
        name: "fixture agent",
        backend: "api",
        model: "claude-opus-4-5",
        role: "lead",
        config: { api: { provider: "anthropic", permissionMode: "bypassPermissions" } },
      }],
    }) as { session: { id: string }; agents: { id: string }[] };
    const sessionId = created.session.id;
    const agentId = created.agents[0]!.id;
    await call("chat.send", { sessionId, text: "use the fixture" });
    await vi.waitFor(() => {
      expect(h.store.turns.list(sessionId).at(-1)?.status).toBe("done");
    }, { timeout: 15_000 });

    expect(providerRequests[0]!.tools.map((tool) => tool.name)).toContain(`mcp__${SERVER}__show_card`);
    expect(apiHarness!.describeSnapshot().mcpServers).toMatchObject([{
      name: SERVER,
      command: process.execPath,
      args: [MCP_FIXTURE],
      cwd: h.root,
    }]);
    const tool = h.store.blocks.listBySession(sessionId).find((block) => block.kind === "tool_call");
    expect(tool).toMatchObject({
      kind: "tool_call",
      status: "success",
    });
    expect(tool?.kind === "tool_call" ? tool.output : "").toContain('"title":"Runtime snapshot"');
    expect(tool?.kind === "tool_call" ? tool.output : "").toContain('"note":"from the real fixture"');
    // Widget document resolution is deliberately fire-and-forget relative to
    // the model turn. Wait on the widget's own settled state instead of using
    // the turn's `done` row as an unrelated timing barrier.
    await vi.waitFor(() => {
      expect(h.store.blocks.listBySession(sessionId).find((block) => block.kind === "widget"))
        .toMatchObject({ kind: "widget", htmlStatus: "ready", serverName: SERVER });
    }, { timeout: 5_000 });
    const widget = h.store.blocks.listBySession(sessionId).find((block) => block.kind === "widget");
    expect(pools.size()).toBe(1);

    const echoed = await call("widget.callTool", {
      sessionId,
      agentId,
      blockId: widget!.id,
      name: "echo",
      args: { text: "same captured server" },
    });
    expect(echoed).toMatchObject({ content: [{ type: "text", text: "echo: same captured server" }] });

    await call("integrations.mcp.update", {
      backend: "api", scope: "user", name: SERVER, patch: { enabled: false },
    });
    expect(ipc.integrations.resolveMcpServers({ backend: "api", projectId: h.projectId })).toEqual([]);
    // The already-started harness and widget keep their immutable snapshot.
    expect(apiHarness!.describeSnapshot().mcpServers).toHaveLength(1);
  });

  it("runs the real fixture in Claude user scope and truthfully refuses unsupported disable", async () => {
    await call("integrations.mcp.add", {
      backend: "claude",
      scope: "user",
      entry: {
        name: SERVER,
        transport: "stdio",
        command: process.execPath,
        args: [MCP_FIXTURE],
        source: "acceptance fixture",
      },
    });
    expect(await call("integrations.mcp.test", { backend: "claude", name: SERVER })).toEqual({
      ok: true,
      status: "connected",
      tools: ["show_card", "echo"],
    });
    expect(ipc.integrations.resolveMcpServers({ backend: "claude", projectId: h.projectId }))
      .toMatchObject([{ name: SERVER, command: process.execPath, args: [MCP_FIXTURE] }]);

    await expect(call("integrations.mcp.update", {
      backend: "claude", scope: "user", name: SERVER, patch: { enabled: false },
    })).rejects.toThrow(/cannot persistently disable a user-scope MCP server/);
    // Rejection happens before Claude's remove/add replacement, so the live
    // native row remains usable instead of being silently deleted.
    expect(ipc.integrations.resolveMcpServers({ backend: "claude", projectId: h.projectId }))
      .toMatchObject([{ name: SERVER, command: process.execPath, args: [MCP_FIXTURE] }]);
  });
});
