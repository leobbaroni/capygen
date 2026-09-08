import { afterEach, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import { openStore, type CapygenStore } from "@capygen/db";
import { EMPTY_USAGE, type Harness } from "@capygen/engine";
import { createCustomModeAuthoring } from "../src/engine/CustomModeAuthoring.js";
let store: CapygenStore;
afterEach(() => { store?.close(); store = undefined as unknown as CapygenStore; });
function setup() {
  store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "/isolated-test-project" });
  return store.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Test", backend: "claude", model: "test-model", role: "lead", config: {} }] }).session.id;
}
const target = { backend: "claude" as const, model: "test-model", effort: "low" };
it("retains invalid drafts and bills only the archived authoring session, then cleans its workspace", async () => {
  const sessionId = setup();
  let path = "";
  const harness = {
    start: vi.fn(async (s) => { path = s.projectPath; }),
    async *send() {
      yield { type: "block", key: "text", patch: { kind: "text", text: "invalid JSON" } };
      yield { type: "usage", backend: "claude", model: "test-model", usage: { ...EMPTY_USAGE, inputTokens: 3 }, byModel: {} };
    },
    dispose: vi.fn(async () => {}), interrupt: vi.fn(async () => true),
  } as unknown as Harness;
  const service = createCustomModeAuthoring({ store, capabilities: () => [{ ...target, efforts: ["low"] }], makeHarness: (_target, prompt) => { expect(prompt).toContain("Schema:"); expect(prompt).not.toContain(sessionId); return harness; } });
  const result = await service.generate({ requestId: "one", sessionId, target, prompt: "Make a crew" });
  expect(result.draft).toBe("invalid JSON");
  expect(result.issues.length).toBeGreaterThan(0);
  expect(store.sessions.get(result.authoringSessionId)?.archived).toBe(true);
  expect(store.usage.totalsBySession(result.authoringSessionId).inputTokens).toBe(3);
  expect(store.usage.totalsBySession(sessionId).inputTokens).toBe(0);
  await expect(access(path)).rejects.toThrow();
  await expect(service.generate({ requestId: "one", sessionId, target, prompt: "again" })).rejects.toThrow("duplicate");
});
it("cancels stalled generation and disposes its owned harness", async () => {
  const sessionId = setup();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const dispose = vi.fn(async () => {});
  const harness = { start: async () => {}, async *send() { started(); await new Promise(() => {}); }, dispose, interrupt: vi.fn(async () => true) } as unknown as Harness;
  const service = createCustomModeAuthoring({ store, capabilities: () => [{ ...target, efforts: ["low"] }], makeHarness: () => harness });
  const pending = service.generate({ requestId: "cancel", sessionId, target, prompt: "Make crew" });
  await ready;
  expect(service.cancel("cancel")).toBe(true);
  const result = await pending;
  expect(result.issues.some((issue) => issue.message.includes("cancelled"))).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(service.cancel("cancel")).toBe(false);
});

it("Claude authoring sends an empty tool/MCP/hook configuration and custom system prompt", async () => {
  const { ClaudeHarness } = await import("@capygen/engine");
  const { makeFakeSdk, resultMessage } = await import("../../../packages/engine/test/fakeSdk.js");
  const fake = makeFakeSdk();
  const harness = new ClaudeHarness({ query: fake.query, authoringSystemPrompt: "schema only", env: {} });
  await harness.start({ sessionId: "isolated", projectPath: "C:\\isolated" }, { agentId: "author", name: "Author", backend: "claude", model: "test-model" });
  const pending = (async () => { for await (const _ of harness.send({ turnId: "turn", text: "crew" })) { /* drain */ } })();
  await vi.waitFor(() => expect(fake.prompts).toEqual(["crew"]));
  const options = fake.calls[0]!.options;
  expect(options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, hooks: {}, maxTurns: 1, systemPrompt: "schema only" });
  expect(await options.canUseTool!("Bash", {}, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" })).toMatchObject({ behavior: "deny" });
  fake.out.push(resultMessage("{}"));
  await pending;
  await harness.dispose();
});

it("API authoring never loads history/MCP or executes tools and stops after one provider call", async () => {
  const { ApiHarness } = await import("@capygen/engine");
  const loadHistory = vi.fn(() => []);
  const run = vi.fn();
  const requests: unknown[] = [];
  const harness = new ApiHarness({ authoringSystemPrompt: "schema only", env: {}, keys: { getKey: () => "isolated-fake-key" }, loadHistory,
    extraTools: [{ name: "danger", description: "test", parameters: {}, run } as never],
    createProvider: async () => ({ provider: "anthropic", async *stream(request) {
      requests.push(request);
      yield { type: "content", index: 0, block: { type: "tool_use", id: "call", name: "danger", input: {} } };
      yield { type: "stop", reason: "tool_use" };
    } }),
  });
  await harness.start({ sessionId: "isolated", projectPath: "C:\\isolated" }, { agentId: "author", name: "Author", backend: "api", model: "test-model" });
  for await (const _ of harness.send({ turnId: "turn", text: "crew" })) { /* drain */ }
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ system: "schema only", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "crew" }] }, { role: "assistant" }] });
  expect(loadHistory).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await harness.dispose();
});

it("service disposal bounds wedged cleanup and rejects late usage writes", async () => {
  const sessionId = setup();
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const late = new Promise<void>((resolve) => { release = resolve; });
  const harness = { start: async () => {}, async *send() {
    started(); await late;
    yield { type: "usage", backend: "claude", model: "test-model", usage: { ...EMPTY_USAGE, inputTokens: 55 }, byModel: {} };
  }, dispose: () => new Promise(() => {}), interrupt: async () => true } as unknown as Harness;
  const service = createCustomModeAuthoring({ store, capabilities: () => [{ ...target, efforts: ["low"] }], makeHarness: () => harness });
  const pending = service.generate({ requestId: "wedged", sessionId, target, prompt: "Make crew" });
  await ready;
  await service.dispose();
  const result = await pending;
  expect(result.issues.some((issue) => issue.message.includes("cleanup timed out"))).toBe(true);
  const record = vi.spyOn(store.usage, "record");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(record).not.toHaveBeenCalled();
});
