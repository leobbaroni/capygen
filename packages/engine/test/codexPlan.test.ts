import { describe, expect, it, vi } from "vitest";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import type { EngineEvent, HarnessAgent, HarnessSession } from "../src/harness.js";
import { createFakeAppServer, settle } from "./codexFakeAppServer.js";

const SESSION: HarnessSession = { sessionId: "ses_plan", projectPath: "C:\\capygen" };
const AGENT: HarnessAgent = { agentId: "agent_plan", name: "codex", backend: "codex", model: "gpt-5.6-luna", config: { codex: { reasoningEffort: "low" } } };
const THREAD = { thread: { id: "thread_plan" } };
const TURN = { turn: { id: "turn_plan", status: "inProgress" } };

function blocks(events: EngineEvent[]): Extract<EngineEvent, { type: "block" }>[] {
  return events.filter((event): event is Extract<EngineEvent, { type: "block" }> => event.type === "block");
}

async function rig(log = vi.fn()) {
  const server = createFakeAppServer({
    handlers: {
      initialize: () => ({}),
      "thread/start": () => THREAD,
      "skills/list": () => ({ data: [] }),
      "turn/start": () => TURN,
    },
  });
  const harness = new CodexHarness({ transport: server.transport, log: { info: log, warn: log, error: log } });
  await harness.start(SESSION, AGENT);
  const events: EngineEvent[] = [];
  const done = (async () => { for await (const event of harness.send({ turnId: "turn_row", text: "plan" })) events.push(event); })();
  await server.waitForRequest("turn/start");
  await settle();
  return { server, harness, events, done, log };
}

function finish(server: ReturnType<typeof createFakeAppServer>): void {
  server.notify("turn/completed", { threadId: "thread_plan", turn: { ...TURN.turn, status: "completed", items: [] } });
}

describe("CodexHarness turn/plan/updated", () => {
  it("emits successive valid plans and a valid empty clear on one stable block", async () => {
    const { server, harness, events, done } = await rig();
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: "first", plan: [{ step: "one", status: "pending", unknown: "discarded" }], unknown: "discarded" });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: null, plan: [] });
    finish(server);
    await done;
    const plans = blocks(events).filter((event) => event.patch.kind === "tool_call");
    expect(plans).toHaveLength(2);
    expect(plans[0]?.key).toBe("plan:turn_row");
    expect(plans[1]).toMatchObject({ key: "plan:turn_row", patch: { name: "update_plan", status: "success", input: { plan: [] } } });
    expect(plans[0]?.patch).toEqual(expect.objectContaining({ input: { explanation: "first", plan: [{ step: "one", status: "pending" }] } }));
    expect(plans[0]?.patch.input).not.toHaveProperty("unknown");
    await harness.dispose();
  });

  it("rejects foreign, stale, malformed, and oversized updates without erasing a plan", async () => {
    const log = vi.fn();
    const { server, harness, events, done } = await rig(log);
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: "kept", plan: [{ step: "keep", status: "inProgress" }] });
    server.notify("turn/plan/updated", { threadId: "other", turnId: "turn_plan", explanation: null, plan: [] });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "old", explanation: null, plan: [] });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: null, plan: [{ step: "bad", status: "unknown" }] });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: null, plan: [{ step: "x".repeat(64 * 1024), status: "pending" }] });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: null, plan: Array.from({ length: 201 }, (_, index) => ({ step: String(index), status: "pending" })) });
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: "🙂".repeat(40_000), plan: [] });
    finish(server);
    await done;
    const plans = blocks(events).filter((event) => event.key === "plan:turn_row");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.patch).toMatchObject({ input: { plan: [{ step: "keep", status: "inProgress" }] } });
    expect(log).toHaveBeenCalled();
    await harness.dispose();
  });

  it("ignores plan notifications after the turn has settled", async () => {
    const { server, harness, events, done } = await rig();
    finish(server);
    await done;
    const before = blocks(events).length;
    server.notify("turn/plan/updated", { threadId: "thread_plan", turnId: "turn_plan", explanation: null, plan: [{ step: "late", status: "completed" }] });
    await settle();
    expect(blocks(events)).toHaveLength(before);
    await harness.dispose();
  });
});
