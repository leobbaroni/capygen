/** Shipping delegation path; the SDK registration and provider I/O alone are fake. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { ApiHarness, AsyncQueue, type Harness, type HarnessAgent, type EngineEvent,
  type ProviderRequest, type ProviderEvent } from "@capygen/engine";
import { parseInvokeArgs, parseInvokeResult, type InvokeChannel, type HarnessInfo } from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner, type HarnessExtras } from "../src/engine/SessionRunner.js";

// No real SDK import occurs in this test. Capture exactly the handler the
// shipping SDK MCP adapter registers, then call it as the native parent would.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (options: { tools: unknown[] }) => options,
}));

type RegisteredTool = { name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> };
let root: string;
let store: CapygenStore;
let ipc: IpcContext;
let extras: HarnessExtras | undefined;
let requests: ProviderRequest[];
let providers: string[];
let built: HarnessAgent[];
let started: HarnessAgent[];
let harnesses: HarnessInfo[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown) {
  const handler = ipc.handlers[channel] as (args: unknown) => unknown;
  return parseInvokeResult(channel, await handler(parseInvokeArgs(channel, raw)));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-api-delegate-"));
  for (const name of ["project", "claude", "codex"]) fs.mkdirSync(path.join(root, name));
  store = openStore(path.join(root, "test.db"), {
    migrationsDir: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
  });
  extras = undefined;
  requests = []; providers = []; built = []; started = [];
  harnesses = [
    { backend: "claude", label: "Claude", available: true, defaultModel: "claude-opus-4-5",
      models: [{ id: "claude-opus-4-5", label: "Claude" }], providers: [] },
    { backend: "api", label: "API", available: true, defaultModel: "gpt-5", providers: ["openai", "anthropic"],
      models: [{ id: "claude-opus-4-5", label: "Claude" }, { id: "gpt-5", label: "GPT" }, { id: "gpt-5-mini", label: "GPT mini" }] },
  ];
  ipc = createIpcContext({
    store, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: () => {},
    env: {}, integrations: { home: root, env: { CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex") } },
    catalogue: () => harnesses,
    pickDirectory: async () => path.join(root, "project"),
    appInfo: () => ({ name: "capygen", version: "0", electron: "44", chrome: "1", node: "24", platform: "win32",
      userDataDir: root, dbFile: store.db.file, logFile: path.join(root, "test.log") }),
    makeEngine: (deps) => createSessionRunner({ ...deps, makeHarness: (agent, wiring) => {
      built.push(agent);
      if (agent.backend === "claude") {
        extras = wiring;
        const events = new AsyncQueue<EngineEvent>();
        return {
          backend: "claude", start: async () => {}, send: () => events,
          answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null,
          interrupt: async () => { events.close(); return true; }, dispose: async () => { events.close(); },
          listCommands: () => [], capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true,
            subagents: true, resume: false, interrupt: true, slashCommands: false }),
        } satisfies Harness;
      }
      const child = new ApiHarness({
        keys: { getKey: async () => "synthetic-key" }, mcpServers: [], loadHistory: async () => [],
        createProvider: async (options) => {
          providers.push(options.provider);
          return { provider: options.provider, baseUrl: options.baseUrl ?? "https://example.invalid",
            stream: (request: ProviderRequest): AsyncIterable<ProviderEvent> => {
              requests.push(request);
              return (async function* () {
                yield { type: "content", index: 0, block: { type: "text", text: "fixture answer" } } as ProviderEvent;
                yield { type: "stop", reason: "end_turn" } as ProviderEvent;
              })();
            } };
        },
      });
      const start = child.start.bind(child);
      child.start = async (session, received) => { started.push(received); await start(session, received); };
      return child;
    } }),
  });
});

afterEach(async () => { await ipc.dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function delegate(options: {
  global?: Record<string, unknown>; target?: Record<string, unknown>; routeModel?: string; requestModel?: string;
}) {
  await call("settings.patch", { patch: { backends: {
    claude: { permissionMode: "bypassPermissions" }, api: { reasoningEffort: "low", ...options.global },
  } } });
  const project = await call("projects.pick", {});
  const made = await call("sessions.create", { projectId: project!.id,
    agents: [{ name: "lead", backend: "claude", model: "claude-opus-4-5", role: "lead" }] });
  const agentId = made.agents[0]!.id;
  await call("agents.update", { agentId, patch: {
    subagentRouting: { backend: "api", ...(options.routeModel ? { model: options.routeModel } : {}) },
    ...(options.target ? { config: { api: options.target } } : {}),
  } });
  await call("chat.send", { sessionId: made.session.id, text: "fixture parent turn" });
  await vi.waitFor(() => expect(extras?.mcpServers).toBeTypeOf("function"));
  const servers = await extras!.mcpServers!();
  const tool = (servers!.capygen as { tools: RegisteredTool[] }).tools.find((entry) => entry.name === "delegate_task")!;
  const result = await tool.handler({ description: "fixture child", prompt: "fixture task",
    ...(options.requestModel ? { model: options.requestModel } : {}) });
  expect(result.isError).not.toBe(true);
  expect(started).toHaveLength(1);
  const factory = built.find((agent) => agent.agentId.includes("#sub"));
  expect(started[0]).toBe(factory);
  expect(factory!.permissionMode).toBe("default");
  expect(factory!.config).not.toHaveProperty("claude");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.reasoningEffort).toBe("low");
  return { child: factory!, request: requests[0]! };
}

describe("a Claude parent's registered tool reaches a real API child", () => {
  it.each([
    { globalProvider: "openai", provider: "anthropic", model: "claude-opus-4-5" },
    { globalProvider: "anthropic", provider: "openai", model: "gpt-5" },
  ])("resolves $provider on the target over $globalProvider globally", async ({ globalProvider, provider, model }) => {
    const result = await delegate({ global: { provider: globalProvider }, target: { provider } });
    expect(providers).toEqual([provider]);
    expect(result.child.config).toMatchObject({ api: { provider } });
    expect(result.child.model).toBe(model);
    expect(result.request.model).toBe(model);
  });

  it("materializes an OpenAI-only keyed fallback into the child", async () => {
    harnesses[1]!.providers = ["openai"];
    const result = await delegate({});
    expect(providers).toEqual(["openai"]);
    expect(result.child.config).toMatchObject({ api: { provider: "openai" } });
    expect(result.request.model).toBe("gpt-5");
  });

  it("keeps request model precedence over a route", async () => {
    const result = await delegate({ global: { provider: "openai" }, routeModel: "gpt-5", requestModel: "gpt-5-mini" });
    expect(result.child.model).toBe("gpt-5-mini");
    expect(result.request.model).toBe("gpt-5-mini");
  });

  it("allows a known foreign model at a custom endpoint", async () => {
    const result = await delegate({ target: { provider: "openai", baseUrl: "https://gateway.invalid/v1" }, routeModel: "claude-opus-4-5" });
    expect(providers).toEqual(["openai"]);
    expect(result.request.model).toBe("claude-opus-4-5");
  });

  it("materializes the provider when a valid route overrides an incompatible canonical model", async () => {
    harnesses[1]!.providers = ["openai"];
    const result = await delegate({ global: { model: "claude-opus-4-5" }, routeModel: "gpt-5" });
    expect(providers).toEqual(["openai"]);
    expect(result.child.config).toMatchObject({ api: { provider: "openai" } });
    expect(result.request.model).toBe("gpt-5");
  });
});
