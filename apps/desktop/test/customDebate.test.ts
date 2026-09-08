import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import { createRoundTable, type RoundTable, type DebateResult } from "../src/engine/RoundTable.js";
import { finishTurn } from "../src/engine/persist.js";

async function fixture(hopCap: number, cancelDebater = false) {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/debate-fixture" });
  const { session } = store.sessions.create({ projectId: project.id, mode: "solo", agents: [] });
  store.sessions.updateSettings(session.id, { hopCap, parallelAgents: true });
  const applied = store.sessions.applyCrew(session.id, {
    version: 1, title: "Decision", defaultWorker: "worker",
    roster: [
      { id: "lead", label: "Lead", role: "lead", target: { backend: "codex", model: "fixture", effort: "low" } },
      { id: "debater", label: "Debater", role: "member", target: { backend: "claude", model: "fixture", effort: "low" } },
      { id: "worker", label: "Worker", role: "worker", target: { backend: "codex", model: "fixture", effort: "low" } },
    ], debate: { enabled: true, triggers: ["core"], participants: ["debater"] },
  });
  const lead = applied.agents[0]!;
  const debater = applied.agents[1]!;
  const calls: { agentId: string; turnId: string; text: string }[] = [];
  const decisions: DebateResult[] = [];
  const deps = { store, broadcast: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  let table: RoundTable;
  table = createRoundTable({ ...deps, runTurn: async (args) => {
    // Dispatch invokes runOne synchronously before returning the result.
    await Promise.resolve();
    calls.push(args);
    if (calls.length === 1) {
      decisions.push(table.requestDebate({ ...args, trigger: "core", topic: "Choose a storage strategy" }));
      if (decisions[0]!.ok) decisions.push(table.requestDebate({ ...args, trigger: "core", topic: "Duplicate" }));
    } else if (args.agentId === debater.id) {
      decisions.push(table.requestDebate({ ...args, trigger: "core", topic: "Recurse" }));
      if (cancelDebater) table.cancel(session.id);
    }
    const status = cancelDebater && args.agentId === debater.id ? "interrupted" : "done";
    finishTurn(deps, session.id, args.turnId, status);
    return { status };
  } });
  table.dispatch({ sessionId: session.id, text: "@debater choose", agentId: debater.id });
  await table.settled();
  return { store, session, lead, debater, calls, decisions, table };
}

it("runs the lead, a debater, then explicit lead return at successive hops without a second user turn", async () => {
  const f = await fixture(3);
  try {
    expect(f.calls.map((call) => call.agentId)).toEqual([f.lead.id, f.debater.id, f.lead.id]);
    const turns = f.store.turns.list(f.session.id);
    expect(turns.map((turn) => turn.hopIndex)).toEqual([0, 1, 2, 3]);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(turns[2]!.parentTurnId).toBe(turns[1]!.id);
    expect(turns[3]!.parentTurnId).toBe(turns[2]!.id);
    expect(turns.slice(1).map((turn) => turn.triggeredByTurnId)).toEqual([turns[0]!.id, turns[0]!.id, turns[0]!.id]);
    expect(f.decisions.map((result) => result.ok)).toEqual([true, false, false]);
    expect(f.calls[2]!.text).toContain("Decide the outcome");
    expect(f.table.isRunning(f.session.id)).toBe(false);
  } finally { f.store.close(); }
});

it("refuses before queueing when the final lead decision would exceed the cap", async () => {
  const f = await fixture(2);
  try {
    expect(f.calls.map((call) => call.agentId)).toEqual([f.lead.id]);
    expect(f.decisions[0]).toMatchObject({ ok: false, reason: expect.stringContaining("remaining hops") });
    expect(f.store.turns.list(f.session.id)).toHaveLength(2);
  } finally { f.store.close(); }
});

it("cancellation drops the remaining lead return", async () => {
  const f = await fixture(3, true);
  try {
    expect(f.calls.map((call) => call.agentId)).toEqual([f.lead.id, f.debater.id]);
    expect(f.table.hasPending(f.session.id)).toBe(false);
    expect(f.table.isRunning(f.session.id)).toBe(false);
    expect(f.store.turns.list(f.session.id)).toHaveLength(3);
  } finally { f.store.close(); }
});

it("custom Continue cannot override the session hop cap", async () => {
  const f = await fixture(3);
  try {
    expect(f.table.continueChain(f.session.id)).toEqual({ ok: false, agentTurnId: null });
    await f.table.settled();
    expect(f.store.turns.list(f.session.id)).toHaveLength(4);
    expect(f.calls).toHaveLength(3);
  } finally { f.store.close(); }
});
