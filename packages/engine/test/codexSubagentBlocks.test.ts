/**
 * `CodexHarness` mapping `collabAgentToolCall` / `subAgentActivity` items to
 * `subagent` blocks (SPEC R12, Phase 4).
 *
 * No raw log has these frames — the Phase 1/3 spikes never triggered Codex's
 * multi-agent collaboration mode — so every frame here is built from the
 * generated bindings (`docs/spikes/codex-app-server-schema/v0.153.4-ts/v2/
 * ThreadItem.ts`'s `collabAgentToolCall`/`subAgentActivity` variants,
 * `CollabAgentState.ts`, `CollabAgentStatus.ts`, `SubAgentActivityKind.ts`),
 * restated in `../src/codex/protocol.ts`. That is a shape claim, not an
 * observation, same disclosure `codexHarness.test.ts` gives its own
 * from-bindings cases (file-change, MCP tool call, usage).
 *
 * This is a separate file from `codexHarness.test.ts` on purpose: that file
 * is a large, actively-edited shared fixture (recorded-frame replay owned by
 * the Phase 3 Codex harness work), and its `rig`/`drain`/`blocks` helpers are
 * module-local, not exported — so this suite is self-contained rather than
 * either duplicating a huge file via `git blame`-unfriendly edits or reaching
 * into its internals.
 */
import { describe, expect, it } from "vitest";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import type { EngineEvent, HarnessAgent, HarnessSession } from "../src/harness.js";
import { createFakeAppServer, settle } from "./codexFakeAppServer.js";

const SESSION: HarnessSession = {
  sessionId: "ses_1",
  projectPath: "C:\\Users\\TugaPlayz\\Desktop\\GITHUB\\capygen",
};
const AGENT: HarnessAgent = {
  agentId: "agt_1",
  name: "codex",
  backend: "codex",
  model: "gpt-5.5",
};
const THREAD = { thread: { id: "th_parent" } };
const TURN = { turn: { id: "tn_1" } };

function drain(events: AsyncIterable<EngineEvent>): { events: EngineEvent[]; done: Promise<void> } {
  const seen: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  return { events: seen, done };
}

function subagentBlocks(events: EngineEvent[]): { key: string; patch: Record<string, unknown> }[] {
  return events
    .filter((e): e is Extract<EngineEvent, { type: "block" }> => e.type === "block")
    .filter((e) => e.patch.kind === "subagent")
    .map((e) => ({ key: e.key, patch: e.patch as unknown as Record<string, unknown> }));
}

/** The last patch for one block key — blocks are upserted, not appended. */
function latestByKey(
  events: EngineEvent[],
  key: string,
): Record<string, unknown> | undefined {
  return subagentBlocks(events).filter((b) => b.key === key).at(-1)?.patch;
}

function rig(): { server: ReturnType<typeof createFakeAppServer>; harness: CodexHarness } {
  const server = createFakeAppServer({
    handlers: {
      initialize: () => ({ codexHome: "C:\\Users\\x\\.codex", platformFamily: "windows" }),
      "thread/start": () => THREAD,
      "thread/resume": () => THREAD,
      "turn/start": () => TURN,
      "skills/list": () => ({ data: [] }),
    },
  });
  const harness = new CodexHarness({
    transport: server.transport,
    requestTimeoutMs: 2_000,
    interruptGraceMs: 10,
  });
  void harness.start(SESSION, AGENT);
  return { server, harness };
}

const ENVELOPE = { threadId: THREAD.thread.id, turnId: TURN.turn.id };

describe("CodexHarness — collabAgentToolCall / subAgentActivity → subagent blocks", () => {
  it("reports the capability once the mapping exists", () => {
    const { harness } = rig();
    expect(harness.capabilities().subagents).toBe(true);
  });

  it("spawnAgent creates one subagent block per receiver thread, from agentsStates", async () => {
    const { server, harness } = rig();
    const turn = drain(harness.send({ turnId: "trn_1", text: "look into the failing test" }));
    await server.waitForRequest("turn/start");

    server.notify("item/started", {
      ...ENVELOPE,
      item: {
        type: "collabAgentToolCall",
        id: "collab_1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: THREAD.thread.id,
        receiverThreadIds: ["th_child_1"],
        prompt: "Investigate why apiProviders.test.ts is flaky and report back.",
        model: "gpt-5.5",
        reasoningEffort: null,
        agentsStates: { th_child_1: { status: "pendingInit", message: null } },
      },
    });
    await settle();

    expect(latestByKey(turn.events, "subagent:th_child_1")).toEqual({
      kind: "subagent",
      agentId: null,
      name: "sub-agent",
      backend: "codex",
      model: "gpt-5.5",
      description: "Investigate why apiProviders.test.ts is flaky and report back.",
      status: "spawned",
    });

    // The tool call settles as `completed`, and `agentsStates` now says the
    // sub-agent is actually running — the block follows the target agent's own
    // state, not the call's.
    server.notify("item/completed", {
      ...ENVELOPE,
      item: {
        type: "collabAgentToolCall",
        id: "collab_1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD.thread.id,
        receiverThreadIds: ["th_child_1"],
        prompt: "Investigate why apiProviders.test.ts is flaky and report back.",
        model: "gpt-5.5",
        reasoningEffort: null,
        agentsStates: { th_child_1: { status: "running", message: null } },
      },
    });
    await settle();
    expect(latestByKey(turn.events, "subagent:th_child_1")?.status).toBe("running");

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("subAgentActivity names the agent from agentPath and tracks its lifecycle", async () => {
    const { server, harness } = rig();
    const turn = drain(harness.send({ turnId: "trn_1", text: "go" }));
    await server.waitForRequest("turn/start");

    server.notify("item/started", {
      ...ENVELOPE,
      item: {
        type: "collabAgentToolCall",
        id: "collab_2",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: THREAD.thread.id,
        receiverThreadIds: ["th_child_2"],
        prompt: null,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentsStates: {},
      },
    });
    await settle();
    // No `agentsStates` entry yet, and an unknown model on the *call* leaves
    // description empty — the block still exists so the UI has something to
    // show while the sub-agent starts.
    expect(latestByKey(turn.events, "subagent:th_child_2")).toMatchObject({
      name: "sub-agent",
      model: "gpt-5.6-sol",
      description: "",
      status: "running", // inProgress call, no per-agent state to prefer yet
    });

    server.notify("item/started", {
      ...ENVELOPE,
      item: { type: "subAgentActivity", id: "act_1", kind: "started", agentThreadId: "th_child_2", agentPath: "explorer" },
    });
    await settle();
    expect(latestByKey(turn.events, "subagent:th_child_2")).toMatchObject({
      name: "explorer",
      status: "running",
    });

    server.notify("item/started", {
      ...ENVELOPE,
      item: { type: "subAgentActivity", id: "act_2", kind: "completed", agentThreadId: "th_child_2", agentPath: "explorer" },
    });
    await settle();
    expect(latestByKey(turn.events, "subagent:th_child_2")?.status).toBe("done");

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("maps an interrupted sub-agent to the error status (no fifth status exists)", async () => {
    const { server, harness } = rig();
    const turn = drain(harness.send({ turnId: "trn_1", text: "go" }));
    await server.waitForRequest("turn/start");

    server.notify("item/started", {
      ...ENVELOPE,
      item: { type: "subAgentActivity", id: "act_3", kind: "interrupted", agentThreadId: "th_child_3", agentPath: "root/reviewer" },
    });
    await settle();
    expect(latestByKey(turn.events, "subagent:th_child_3")).toMatchObject({
      name: "root/reviewer",
      status: "error",
    });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("a collab call naming no receiver (listAgents) renders nothing", async () => {
    const { server, harness } = rig();
    const turn = drain(harness.send({ turnId: "trn_1", text: "go" }));
    await server.waitForRequest("turn/start");

    server.notify("item/started", {
      ...ENVELOPE,
      item: {
        type: "collabAgentToolCall",
        id: "collab_3",
        tool: "listAgents",
        status: "completed",
        senderThreadId: THREAD.thread.id,
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    });
    await settle();
    expect(subagentBlocks(turn.events)).toHaveLength(0);

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });

  it("a later collabAgentToolCall does not blank out a name subAgentActivity already gave the block", async () => {
    const { server, harness } = rig();
    const turn = drain(harness.send({ turnId: "trn_1", text: "go" }));
    await server.waitForRequest("turn/start");

    server.notify("item/started", {
      ...ENVELOPE,
      item: { type: "subAgentActivity", id: "act_4", kind: "started", agentThreadId: "th_child_4", agentPath: "explorer" },
    });
    await settle();

    server.notify("item/completed", {
      ...ENVELOPE,
      item: {
        type: "collabAgentToolCall",
        id: "collab_4",
        tool: "sendInput",
        status: "completed",
        senderThreadId: THREAD.thread.id,
        receiverThreadIds: ["th_child_4"],
        prompt: "keep going",
        model: null,
        reasoningEffort: null,
        agentsStates: { th_child_4: { status: "running", message: null } },
      },
    });
    await settle();
    expect(latestByKey(turn.events, "subagent:th_child_4")).toMatchObject({
      name: "explorer", // not reset to "sub-agent"
      description: "keep going",
      status: "running",
    });

    await harness.interrupt();
    await turn.done;
    await harness.dispose();
  });
});
