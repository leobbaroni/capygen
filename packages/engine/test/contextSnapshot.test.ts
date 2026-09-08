import { expect, it, vi } from "vitest";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import { ApiHarness } from "../src/api/ApiHarness.js";
import { makeFakeSdk } from "./fakeSdk.js";
import { createFakeAppServer } from "./codexFakeAppServer.js";
const session = { sessionId: "context-fixture", projectPath: "C:/context-fixture" };
const drain = async (events: AsyncIterable<unknown>) => { for await (const event of events) void event; };

it("Claude uses latest parent request input plus cache once, never cumulative modelUsage or child input", async () => {
  const fake = makeFakeSdk(); const harness = new ClaudeHarness({ query: fake.query });
  await harness.start(session, { agentId: "claude", backend: "claude", name: "Claude", model: "fixture" });
  expect(harness.contextSnapshot()).toMatchObject({ inputTokens: null, capacityTokens: null, source: "unknown" });
  const done = drain(harness.send({ turnId: "one", text: "fixture" }));
  await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
  fake.out.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "parent", usage: { input_tokens: 12, cache_read_input_tokens: 80, cache_creation_input_tokens: 8 } } } } as never);
  await vi.waitFor(() => expect(harness.contextSnapshot().inputTokens).toBe(100));
  fake.out.push({ type: "stream_event", parent_tool_use_id: "child", event: { type: "message_start", message: { usage: { input_tokens: 9999 } } } } as never);
  fake.out.push({ type: "result", subtype: "success", result: "done", modelUsage: { fixture: { inputTokens: 900000, outputTokens: 200000, contextWindow: 200000 } } } as never);
  await done;
  expect(harness.contextSnapshot()).toMatchObject({ inputTokens: 100, capacityTokens: 200000, source: "last-request" });
  fake.end(); await harness.dispose();
});

it("Codex uses last input (already cache-inclusive) and actual capacity, not thread total", async () => {
  const server = createFakeAppServer({ handlers: { initialize: () => ({}), "thread/start": () => ({ thread: { id: "thread" } }), "turn/start": () => ({ turn: { id: "turn" } }), "skills/list": () => ({ data: [] }) } });
  const harness = new CodexHarness({ transport: server.transport, interruptGraceMs: 1 });
  await harness.start(session, { agentId: "codex", backend: "codex", name: "Codex", model: "fixture" });
  const done = drain(harness.send({ turnId: "one", text: "fixture" }));
  await server.waitForRequest("turn/start");
  server.notify("thread/tokenUsage/updated", { threadId: "thread", turnId: "turn", tokenUsage: { total: { inputTokens: 900000, totalTokens: 999999 }, last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 }, modelContextWindow: 200000 } });
  await vi.waitFor(() => expect(harness.contextSnapshot()).toMatchObject({ inputTokens: 100, capacityTokens: 200000 }));
  await harness.interrupt(); await done; await harness.dispose();
});

it("API replaces request counts, includes normalized caches once and leaves unverified capacity unknown", async () => {
  let calls = 0;
  const harness = new ApiHarness({ env: {}, keys: { getKey: () => "fixture" }, useMcp: false, createProvider: async () => ({ provider: "anthropic", async *stream() {
    calls += 1;
    yield { type: "usage", model: "fixture", usage: { inputTokens: calls, outputTokens: 5, cacheReadTokens: 80, cacheCreationTokens: 8 } };
    yield { type: "stop", reason: "end_turn" };
  } }) });
  await harness.start(session, { agentId: "api", backend: "api", name: "API", model: "fixture", config: { api: { provider: "anthropic" } } });
  await drain(harness.send({ turnId: "one", text: "fixture" }));
  await drain(harness.send({ turnId: "two", text: "fixture" }));
  expect(harness.contextSnapshot()).toMatchObject({ inputTokens: 90, capacityTokens: null, source: "last-request" });
  await harness.dispose();
});
