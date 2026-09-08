import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import { parseCustomModeDocument, UNKNOWN_CONTEXT } from "@capygen/shared";
import type { Harness, EngineEvent } from "@capygen/engine";
import { createSessionRunner } from "../src/engine/SessionRunner.js";

it.each([true, false])("keeps delegated context separate, retained after finish, and unknown without data (measured=%s)", async (measured) => {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/owned-context-fixture" });
  const original = store.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Lead", backend: "codex", model: "gpt-5.6-luna", role: "lead", config: null }] });
  const target = { backend: "codex", model: "gpt-5.6-luna", effort: "low" };
  const parsed = parseCustomModeDocument({ version: 1, title: "Context fixture", roster: [
    { id: "lead", label: "Lead", role: "lead", target, instructions: "Lead" },
    { id: "member", label: "Unstarted member", role: "member", target, instructions: "Member" },
    { id: "worker", label: "Worker", role: "worker", target, instructions: "Worker" },
  ], routing: [], defaultWorker: "worker", debate: { enabled: false, triggers: [], participants: [] } });
  if (!parsed.ok) throw new Error("Invalid context fixture");
  const { session } = store.sessions.applyCrew(original.session.id, parsed.document);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let childInput = 200;
  const log = { info() {}, warn() {}, error() {} };
  const runner = createSessionRunner({ store, broadcast() {}, log,
    crewCapabilities: () => parsed.document.roster.map((entry) => ({ ...entry.target, efforts: [entry.target.effort] })),
    makeHarness: (agent, extras): Harness => {
      const parent = agent.agentId === session.leadAgentId;
      return {
        backend: agent.backend, async start() {},
        ...(parent || measured ? { contextSnapshot: () => ({ inputTokens: parent ? 100 : childInput, capacityTokens: parent ? 1000 : 2000, source: "last-request" as const, updatedAt: 1 }) } : {}),
        async *send(): AsyncIterable<EngineEvent> {
          if (parent) {
            const delegate = extras.dynamicTools!.find((tool) => tool.name === "delegate_task")!;
            const result = await delegate.run({ taskKind: "text", difficulty: "easy", description: "Context child", prompt: "Fixture only" }, { cwd: project.path, log, maxOutputChars: 4096, ask: async () => ({}) });
            expect(result.isError).toBeUndefined();
          } else {
            yield { type: "block", key: "child", patch: { kind: "text", text: "Working" } };
            await pending;
            childInput = 300;
          }
          yield { type: "turn", status: "done" };
        },
        async interrupt() { finish(); return true; }, async dispose() {}, listCommands: () => [],
        answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null,
        capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: false, interrupt: true, slashCommands: false }),
      };
    },
  });
  try {
    expect(runner.agentContexts!(session.id).every((entry) => entry.source === "unknown")).toBe(true);
    runner.dispatch({ sessionId: session.id, text: "Context fixture" });
    await vi.waitFor(() => expect(runner.agentContexts!(session.id).some((entry) => entry.parentAgentId === session.leadAgentId)).toBe(true));
    const active = runner.agentContexts!(session.id);
    const child = active.find((entry) => entry.parentAgentId === session.leadAgentId)!;
    expect(child.agentId).not.toBe(session.leadAgentId);
    expect(child).toMatchObject(measured ? { inputTokens: 200, capacityTokens: 2000 } : UNKNOWN_CONTEXT);
    expect(active.find((entry) => entry.agentId === session.leadAgentId)?.inputTokens).toBe(100);
    expect(active.find((entry) => !entry.parentAgentId && entry.agentId !== session.leadAgentId)).toMatchObject(UNKNOWN_CONTEXT);
    finish();
    await vi.waitFor(() => expect(runner.isSessionQuiescent!(session.id)).toBe(true));
    const completed = runner.agentContexts!(session.id);
    expect(completed.find((entry) => entry.agentId === child.agentId)).toMatchObject(measured ? { inputTokens: 300, capacityTokens: 2000 } : UNKNOWN_CONTEXT);
    expect(completed.find((entry) => entry.agentId === session.leadAgentId)?.inputTokens).toBe(100);
    expect(runner.agentContexts!("different-session")).toEqual([]);
  } finally { finish(); await runner.dispose(); store.close(); }
});
