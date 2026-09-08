import { expect, it } from "vitest";
import { ApiHarness } from "../src/api/ApiHarness.js";
import { COMPACTION_SYSTEM, SUMMARY_PREFIX, compactionPrefix } from "../src/api/compaction.js";
import type { ChatMessage, Provider, ProviderRequest } from "../src/api/providers/types.js";
import type { EngineEvent } from "../src/harness.js";

const history: ChatMessage[] = Array.from({ length: 4 }, (_, index) => [
  { role: "user" as const, content: [{ type: "text" as const, text: `Task ${index}: ${"known fact ".repeat(650)}` }] },
  { role: "assistant" as const, content: [{ type: "tool_use" as const, id: `call-${index}`, name: "read_file", input: { path: `file-${index}` } }] },
  { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: `call-${index}`, content: "verified contents" }] },
  { role: "assistant" as const, content: [{ type: "text" as const, text: `Finished task ${index}` }] },
]).flat();

async function run(window: number | undefined, failSummary = false, cancelSummary = false) {
  let harness: ApiHarness;
  const requests: ProviderRequest[] = [];
  const provider: Provider = { provider: "anthropic", async *stream(request) {
    requests.push(structuredClone({ ...request, signal: undefined }));
    const summary = request.system === COMPACTION_SYSTEM;
    yield { type: "usage", model: "fixture", usage: { inputTokens: summary ? 100 : 20, outputTokens: summary ? 10 : 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    if (summary && cancelSummary) { await harness.interrupt(); expect(request.signal?.aborted).toBe(true); return; }
    if (summary && failSummary) { yield { type: "error", message: "fixture summary failed" }; return; }
    yield { type: "content", index: 0, block: { type: "text", text: summary ? "Tasks 0–2 finished; verified file contents. Continue the latest task." : "Done" } };
    yield { type: "stop", reason: "end_turn" };
  } };
  harness = new ApiHarness({ env: {}, keys: { getKey: () => "fixture" }, useMcp: false, loadHistory: () => structuredClone(history), createProvider: async () => provider, maxTokens: 256, compactionThreshold: 0.7 });
  await harness.start({ sessionId: "fixture-session", projectPath: "C:/fixture" }, { agentId: "fixture-agent", name: "Fixture", backend: "api", model: "fixture", config: { api: { provider: "anthropic", ...(window ? { contextWindowTokens: window } : {}) } } });
  const events: EngineEvent[] = [];
  for await (const event of harness.send({ turnId: "first", text: "Current task" })) events.push(event);
  if (!failSummary && !cancelSummary) for await (const event of harness.send({ turnId: "second", text: "Next small task" })) events.push(event);
  await harness.dispose(); return { requests, events };
}

it("summarizes above threshold with same model, counts usage and preserves the recent tool pairs and stable primary prefix", async () => {
  const { requests, events } = await run(10_000);
  expect(requests).toHaveLength(3);
  expect(requests[0]).toMatchObject({ system: COMPACTION_SYSTEM, model: "fixture", tools: [], maxTokens: 1024 });
  const primary = requests[1]!;
  expect(primary.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(SUMMARY_PREFIX) });
  expect(primary.messages.slice(1, 5)).toEqual(history.slice(-4));
  expect(primary.system).toBe(requests[2]!.system); expect(primary.tools).toEqual(requests[2]!.tools);
  const usage = events.find((event) => event.type === "usage");
  expect(usage).toMatchObject({ usage: { inputTokens: 120, outputTokens: 15 }, byModel: { fixture: { inputTokens: 120, outputTokens: 15 } } });
});

it("does not summarize with unknown model capacity or below threshold", async () => {
  expect((await run(undefined)).requests).toHaveLength(2);
  expect(compactionPrefix(history, "stable", [], 1_000_000, 0.7, 256)).toBe(0);
});

it("summary failure stops primary request and reports consumed summary usage", async () => {
  const { requests, events } = await run(10_000, true);
  expect(requests).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "usage", usage: expect.objectContaining({ inputTokens: 100, outputTokens: 10 }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: "turn", status: "error" }));
});

it("cancels summarization through the active signal, keeps history and counts reported usage", async () => {
  const { requests, events } = await run(10_000, false, true);
  expect(requests).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ type: "usage", usage: expect.objectContaining({ inputTokens: 100 }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: "turn", status: "interrupted" }));
});
