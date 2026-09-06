/**
 * The round-table dispatcher over the real IPC handlers, the real session
 * runner and a real temp database, with one scripted fake harness per agent
 * (ADR-0002, SPEC R11/R12/R23).
 *
 * What is pinned here is everything the pure tests in `packages/engine` cannot
 * see: that mentions become turn *rows* in the right order, that a ping-pong
 * stops at the hop cap and says so in the transcript, that Continue buys
 * exactly one more hop, that Stop takes the queue with it, and that a stateful
 * backend is handed a labelled delta rather than the transcript (R23).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { AsyncQueue } from "@capygen/engine";
import type {
  EngineEvent,
  Harness,
  HarnessAgent,
  HarnessCapabilities,
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type EventChannel,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner, type HarnessExtras } from "../src/engine/SessionRunner.js";
import type { EngineDeps } from "../src/engine/types.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

/**
 * A backend that answers with a script. `hold` keeps a turn open so a test can
 * interrupt it; otherwise the reply lands on the next microtask, which is what
 * lets a whole chain run inside one `waitFor`.
 */
class ScriptedAgent implements Harness {
  prompts: string[] = [];
  replies: string[] = [];
  fallback = "ok";
  hold = false;
  interrupted = 0;
  private queue: AsyncQueue<EngineEvent> | null = null;

  constructor(readonly backend: "claude" | "codex" | "api") {}

  async start(): Promise<void> {}

  send(input: { turnId: string; text: string }): AsyncIterable<EngineEvent> {
    this.prompts.push(input.text);
    const out = new AsyncQueue<EngineEvent>();
    this.queue = out;
    if (!this.hold) {
      const text = this.replies.shift() ?? this.fallback;
      queueMicrotask(() => {
        out.push({ type: "block", key: "msg:0", patch: { kind: "text", text } });
        out.push({ type: "turn", status: "done" });
        out.close();
      });
    }
    return out;
  }

  async interrupt(): Promise<boolean> {
    this.interrupted += 1;
    this.queue?.push({ type: "turn", status: "interrupted" });
    this.queue?.close();
    return true;
  }

  listCommands(): SlashCommand[] {
    return [];
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: true,
      resume: true,
      interrupt: true,
      slashCommands: true,
    };
  }

  answerPermission(): boolean {
    return true;
  }
  answerQuestion(): boolean {
    return true;
  }
  backendSessionId(): string | null {
    return null;
  }
  async dispose(): Promise<void> {
    this.queue?.push({ type: "turn", status: "interrupted" });
    this.queue?.close();
  }
}

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let events: { channel: EventChannel; payload: unknown }[];
/** agentId → its harness, plus what the runner started it with. */
let agents: Map<string, ScriptedAgent>;
let started: { agent: HarnessAgent; extras: HarnessExtras }[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function eventsOn(channel: EventChannel): unknown[] {
  return events.filter((e) => e.channel === channel).map((e) => e.payload);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-rt-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  agents = new Map();
  started = [];
  ipc = createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    makeEngine: (deps: EngineDeps) =>
      createSessionRunner({
        ...deps,
        makeHarness: (agent, extras) => {
          started.push({ agent, extras });
          const existing = agents.get(agent.agentId);
          if (existing) return existing;
          const made = new ScriptedAgent(agent.backend as "claude" | "codex" | "api");
          agents.set(agent.agentId, made);
          return made;
        },
      }),
    pickDirectory: async () => path.join(dir, "project"),
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: dir,
      logFile: path.join(dir, "logs", "capygen-desktop.log"),
      dbFile: store.db.file,
    }),
  });
});

afterEach(async () => {
  await ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Table {
  sessionId: string;
  alice: string;
  codex: string;
}

/** A round-table session with a Claude lead (@alice) and a Codex member (@codex). */
async function roundTable(settings?: Record<string, unknown>): Promise<Table> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    mode: "round-table",
    agents: [
      { name: "alice", backend: "claude", model: "claude-opus-4-5", role: "lead" },
      { name: "codex", backend: "codex", model: "gpt-5.5" },
    ],
  })) as { session: { id: string }; agents: { id: string; mentionName: string }[] };
  const sessionId = created.session.id;
  if (settings) await call("sessions.updateSettings", { sessionId, patch: settings });
  const byName = new Map(created.agents.map((a) => [a.mentionName, a.id]));
  return { sessionId, alice: byName.get("alice")!, codex: byName.get("codex")! };
}

function harnessOf(agentId: string): ScriptedAgent {
  const found = agents.get(agentId);
  if (!found) throw new Error(`no harness was built for ${agentId}`);
  return found;
}

/**
 * Register both agents' harnesses up front, so a script can be in place before
 * the first turn runs. The runner builds a harness lazily, on the first turn
 * that agent takes — which in a chain is far too late to script it.
 */
function arm(table: Table): { alice: ScriptedAgent; codex: ScriptedAgent } {
  const alice = new ScriptedAgent("claude");
  const codex = new ScriptedAgent("codex");
  agents.set(table.alice, alice);
  agents.set(table.codex, codex);
  return { alice, codex };
}

/** Every settled agent turn, oldest first. */
function agentTurns(sessionId: string) {
  return store.turns.list(sessionId).filter((t) => t.role === "agent");
}

async function idle(sessionId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(store.turns.list(sessionId).some((t) => t.status === "streaming")).toBe(false);
  });
}

describe("delivering a user message (SPEC R11)", () => {
  it("goes to the lead when nothing is mentioned", async () => {
    const table = await roundTable();
    await call("chat.send", { sessionId: table.sessionId, text: "hello" });
    await idle(table.sessionId);

    expect(harnessOf(table.alice).prompts).toEqual(["hello"]);
    expect(agents.get(table.codex)).toBeUndefined();
    const turns = agentTurns(table.sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.agentId).toBe(table.alice);
    expect(turns[0]!.hopIndex).toBe(1);
  });

  it("goes to the @-mentioned agents, in mention order, and records the mentions", async () => {
    const table = await roundTable();
    await call("chat.send", { sessionId: table.sessionId, text: "@codex then @alice, please" });
    await idle(table.sessionId);

    const turns = agentTurns(table.sessionId);
    expect(turns.map((t) => t.agentId)).toEqual([table.codex, table.alice]);
    expect(turns.every((t) => t.hopIndex === 1)).toBe(true);
    expect(turns.map((t) => t.speakerLabel)).toEqual([
      "@codex (Codex)",
      "@alice (Claude Code)",
    ]);

    const userTurn = store.turns.list(table.sessionId).find((t) => t.role === "user")!;
    expect(userTurn.mentions).toEqual([table.codex, table.alice]);
  });

  it("closes the turn loudly when the session has no agent at all", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      mode: "round-table",
      agents: [{ name: "solo", backend: "claude", model: "m" }],
    })) as { session: { id: string }; agents: { id: string }[] };
    store.sessions.removeAgent(created.agents[0]!.id);

    const sent = (await call("chat.send", {
      sessionId: created.session.id,
      text: "anyone?",
    })) as { agentTurnId: string };
    expect(store.turns.get(sent.agentTurnId)?.status).toBe("error");
    expect(store.sessions.get(created.session.id)?.status).toBe("error");
  });
});

describe("agent-to-agent chains and the hop cap (SPEC R11)", () => {
  it("stops a ping-pong at the cap, says so in the transcript, and fires chainStopped", async () => {
    const table = await roundTable({ hopCap: 3 });
    const scripted = arm(table);
    scripted.alice.fallback = "@codex your turn";
    scripted.codex.fallback = "@alice back to you";

    await call("chat.send", { sessionId: table.sessionId, text: "start" });
    await idle(table.sessionId);

    const chain = agentTurns(table.sessionId);
    expect(chain.map((t) => t.hopIndex)).toEqual([1, 2, 3]);
    expect(chain.map((t) => t.agentId)).toEqual([table.alice, table.codex, table.alice]);

    const stopped = eventsOn("chat.chainStopped") as { reason: string; turnId: string }[];
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.reason).toBe("hop_cap");
    expect(stopped[0]!.turnId).toBe(chain[2]!.id);

    const system = store.turns.list(table.sessionId).filter((t) => t.role === "system");
    expect(system).toHaveLength(1);
    const text = store.blocks
      .listByTurn(system[0]!.id)
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    expect(text).toMatch(/Chain stopped after 3 hops/);
    expect(store.sessions.get(table.sessionId)?.status).toBe("idle");
  });

  it("Continue resumes exactly one more hop, then stops again", async () => {
    const table = await roundTable({ hopCap: 3 });
    const scripted = arm(table);
    scripted.alice.fallback = "@codex your turn";
    scripted.codex.fallback = "@alice back to you";
    await call("chat.send", { sessionId: table.sessionId, text: "start" });
    await idle(table.sessionId);

    const before = agentTurns(table.sessionId).length;
    const resumed = (await call("chat.continue", { sessionId: table.sessionId })) as {
      ok: boolean;
      agentTurnId: string | null;
    };
    expect(resumed.ok).toBe(true);
    await idle(table.sessionId);

    const after = agentTurns(table.sessionId);
    expect(after).toHaveLength(before + 1);
    const resumedTurn = store.turns.get(resumed.agentTurnId!)!;
    expect(resumedTurn.agentId).toBe(table.codex);
    expect(resumedTurn.hopIndex).toBe(4);

    // One press, one hop: the cap applies again to whatever that hop says.
    const stopped = eventsOn("chat.chainStopped") as { reason: string }[];
    expect(stopped.map((s) => s.reason)).toEqual(["hop_cap", "hop_cap"]);
  });

  it("blocks both chains of a round under one notice, and Continue resumes both", async () => {
    // Cap 1: the two agents the user addressed each mention the other, so the
    // *same round* blocks twice. One "chain stopped" line, two events, and one
    // press of Continue owes both of them a hop.
    const table = await roundTable({ hopCap: 1 });
    const scripted = arm(table);
    scripted.alice.fallback = "@codex your turn";
    scripted.codex.fallback = "@alice back to you";

    await call("chat.send", { sessionId: table.sessionId, text: "@alice and @codex go" });
    await idle(table.sessionId);

    expect(agentTurns(table.sessionId).map((t) => t.hopIndex)).toEqual([1, 1]);
    const stopped = eventsOn("chat.chainStopped") as { reason: string; turnId: string }[];
    expect(stopped.map((s) => s.reason)).toEqual(["hop_cap", "hop_cap"]);
    expect(store.turns.list(table.sessionId).filter((t) => t.role === "system")).toHaveLength(1);

    await call("chat.continue", { sessionId: table.sessionId });
    await idle(table.sessionId);

    const resumed = agentTurns(table.sessionId).filter((t) => t.hopIndex === 2);
    expect(resumed.map((t) => t.agentId).sort()).toEqual([table.alice, table.codex].sort());
  });

  it("a new user message resets the hop count", async () => {
    const table = await roundTable({ hopCap: 3 });
    const scripted = arm(table);
    scripted.alice.fallback = "@codex your turn";
    scripted.codex.fallback = "nothing more";
    await call("chat.send", { sessionId: table.sessionId, text: "start" });
    await idle(table.sessionId);
    expect(agentTurns(table.sessionId).map((t) => t.hopIndex)).toEqual([1, 2]);

    // Same agents, same scripts — only the user speaking again resets the count.
    scripted.alice.fallback = "nothing more";
    await call("chat.send", { sessionId: table.sessionId, text: "again" });
    await idle(table.sessionId);
    const last = agentTurns(table.sessionId).at(-1)!;
    expect(last.agentId).toBe(table.alice);
    expect(last.hopIndex).toBe(1);
  });
});

describe("interrupt (SPEC R11, §Edge Cases)", () => {
  it("stops the running turn and drops the queued ones", async () => {
    const table = await roundTable();
    const scripted = arm(table);
    scripted.alice.hold = true;

    await call("chat.send", { sessionId: table.sessionId, text: "@alice and @codex" });
    await vi.waitFor(() => expect(scripted.alice.prompts).toHaveLength(1));

    expect(await call("chat.interrupt", { sessionId: table.sessionId })).toEqual({ ok: true });
    await idle(table.sessionId);

    // The second target never ran: the queue went with the interrupt.
    expect(scripted.codex.prompts).toEqual([]);
    const open = store.turns.list(table.sessionId).filter((t) => t.status === "streaming");
    expect(open).toHaveLength(0);
    expect(store.sessions.get(table.sessionId)?.status).toBe("idle");
  });
});

describe("what an agent is actually sent (SPEC R23)", () => {
  it("hands a stateful backend the labelled delta, not the transcript", async () => {
    const table = await roundTable({ hopCap: 3 });
    const scripted = arm(table);
    scripted.alice.fallback = "@codex please review the parser";
    scripted.codex.fallback = "@alice it looks fine";

    await call("chat.send", { sessionId: table.sessionId, text: "start" });
    await idle(table.sessionId);

    const [toCodex] = scripted.codex.prompts;
    // The addressed message is labelled with who said it…
    expect(toCodex).toContain("[@alice (Claude Code)]: @codex please review the parser");
    // …and the delta carries the user turns Codex has not seen, once.
    expect(toCodex).toContain("[user]: start");
    expect(toCodex!.match(/\[user\]: start/g)).toHaveLength(1);

    // Alice's second turn gets Codex's reply — and not her own earlier words,
    // which her backend session already remembers.
    const toAlice = scripted.alice.prompts.at(-1)!;
    expect(toAlice).toContain("[@codex (Codex)]: @alice it looks fine");
    expect(toAlice).not.toContain("please review the parser");
    expect(toAlice).not.toContain("[user]: start");
  });

  it("starts each harness with the round-table roster, once", async () => {
    const table = await roundTable();
    await call("chat.send", { sessionId: table.sessionId, text: "@codex hi" });
    await idle(table.sessionId);

    const codexStart = started.find((s) => s.agent.agentId === table.codex);
    expect(codexStart?.agent.promptAddition).toContain("@alice (Claude Code)");
    expect(codexStart?.agent.promptAddition).toContain("stop after 3 hops");
    // Built once per harness: the runner reuses the instance across turns.
    expect(started.filter((s) => s.agent.agentId === table.codex)).toHaveLength(1);
  });

  it("adds nothing to a solo session's prompt", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      agents: [{ name: "solo", backend: "claude", model: "m", role: "lead" }],
    })) as { session: { id: string } };
    await call("chat.send", { sessionId: created.session.id, text: "hi" });
    await idle(created.session.id);
    expect(started[0]?.agent.promptAddition).toBeUndefined();
  });
});

describe("parallelAgents (SPEC R11)", () => {
  it("runs the mentioned agents concurrently but keeps the transcript order stable", async () => {
    const table = await roundTable({ parallelAgents: true });
    const scripted = arm(table);
    scripted.alice.hold = true;
    scripted.codex.hold = true;
    await call("chat.send", { sessionId: table.sessionId, text: "@alice and @codex go" });

    // Neither waits for the other: both prompts land while both turns are open.
    await vi.waitFor(() => {
      expect(scripted.alice.prompts).toHaveLength(1);
      expect(scripted.codex.prompts).toHaveLength(1);
    });

    const open = store.turns
      .list(table.sessionId)
      .filter((t) => t.status === "streaming")
      .map((t) => t.agentId);
    expect(open).toEqual([table.alice, table.codex]);

    await ipc.handlers["chat.interrupt"]({ sessionId: table.sessionId });
    await idle(table.sessionId);
  });

  it("queues two hops addressed to the same agent instead of racing them", async () => {
    // Both first-round agents mention @carol, so the second round holds two
    // turns for one agent. A harness takes one turn at a time: run them at
    // once and the runner refuses the second outright.
    const table = await roundTable({ parallelAgents: true, hopCap: 3 });
    const carol = (await call("agents.add", {
      sessionId: table.sessionId,
      backend: "api",
      model: "claude-opus-4-5",
      displayName: "carol",
      mentionName: "carol",
    })) as { id: string };
    const scripted = arm(table);
    const carolAgent = new ScriptedAgent("api");
    agents.set(carol.id, carolAgent);
    scripted.alice.fallback = "@carol please check";
    scripted.codex.fallback = "@carol you too";

    await call("chat.send", { sessionId: table.sessionId, text: "@alice and @codex go" });
    await idle(table.sessionId);

    const hop2 = agentTurns(table.sessionId).filter((t) => t.hopIndex === 2);
    expect(hop2.map((t) => t.agentId)).toEqual([carol.id, carol.id]);
    expect(hop2.map((t) => t.status)).toEqual(["done", "done"]);
    expect(carolAgent.prompts).toHaveLength(2);
  });
});

describe("sub-agent routing wiring (SPEC R12)", () => {
  it("gives a same-backend rule to the Claude hook and nothing else", async () => {
    const table = await roundTable();
    await call("agents.update", {
      agentId: table.alice,
      patch: { subagentRouting: { model: "claude-haiku-4-5" } },
    });
    await call("chat.send", { sessionId: table.sessionId, text: "hi" });
    await idle(table.sessionId);

    const wiring = started.find((s) => s.agent.agentId === table.alice)!;
    expect(wiring.extras.routeSubagent).toBeTypeOf("function");
    expect(wiring.extras.mcpServers).toBeUndefined();
    expect(wiring.extras.extraTools).toBeUndefined();
    expect(
      wiring.extras.routeSubagent!({
        sessionId: table.sessionId,
        agentId: table.alice,
        toolName: "Agent",
        toolUseId: "toolu_1",
        description: "count files",
        subagentType: "general-purpose",
        input: {},
      }),
    ).toEqual({ model: "claude-haiku-4-5", backend: "claude" });
  });

  it("gives a cross-backend rule the delegate_task MCP server instead", async () => {
    const table = await roundTable();
    await call("agents.update", {
      agentId: table.alice,
      patch: { subagentRouting: { backend: "codex", model: "gpt-5.5" } },
    });
    await call("chat.send", { sessionId: table.sessionId, text: "hi" });
    await idle(table.sessionId);

    const wiring = started.find((s) => s.agent.agentId === table.alice)!;
    expect(wiring.extras.mcpServers).toBeTypeOf("function");
    expect(wiring.agent.promptAddition).toContain("delegate_task");
    // The hook is still wired, and still declines to rewrite a foreign model.
    expect(
      wiring.extras.routeSubagent!({
        sessionId: table.sessionId,
        agentId: table.alice,
        toolName: "Agent",
        toolUseId: "toolu_1",
        description: "count files",
        subagentType: undefined,
        input: {},
      }),
    ).toBeNull();
  });

  it("fails open for a Codex agent, which cannot be handed a tool", async () => {
    const table = await roundTable();
    await call("agents.update", {
      agentId: table.codex,
      patch: { subagentRouting: { backend: "claude", model: "claude-haiku-4-5" } },
    });
    await call("chat.send", { sessionId: table.sessionId, text: "@codex hi" });
    await idle(table.sessionId);

    const wiring = started.find((s) => s.agent.agentId === table.codex)!;
    expect(wiring.extras.mcpServers).toBeUndefined();
    expect(wiring.extras.extraTools).toBeUndefined();
    expect(wiring.agent.promptAddition).not.toContain("delegate_task");
  });
});
