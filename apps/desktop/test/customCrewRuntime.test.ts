import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import { parseCustomModeDocument } from "@capygen/shared";
import type { Harness, HarnessAgent, EngineEvent } from "@capygen/engine";
import { createSessionRunner, type HarnessExtras } from "../src/engine/SessionRunner.js";

it("dispatches every diagram branch through the configured child and persists route evidence", async () => {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/owned-custom-fixture" });
  const original = store.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Old", backend: "codex", model: "gpt-5.6-luna", role: "lead", config: null }] });
  const member = (id: string, role: "lead" | "member" | "worker", backend: "claude" | "codex", model: string, effort: string) => ({ id, label: id, role, target: { backend, model, effort }, instructions: `Role instructions for ${id}` });
  const parsed = parseCustomModeDocument({ version: 1, title: "User diagram", roster: [
    member("astra", "lead", "codex", "gpt-6-astra", "medium"),
    member("fable", "member", "claude", "fable-5.1", "medium"),
    member("design", "worker", "codex", "gpt-6-astra", "low"),
    member("research", "worker", "codex", "gpt-5.6-luna", "medium"),
    member("dev", "worker", "claude", "claude-opus-5", "medium"),
    member("easy", "worker", "claude", "claude-sonnet-5", "medium"),
  ], routing: [
    { id: "design", taskKinds: ["design"], target: "design" },
    { id: "research", taskKinds: ["research"], target: "research" },
    { id: "hard-dev", taskKinds: ["development"], difficulties: ["hard", "medium"], target: "dev" },
    { id: "easy-dev", taskKinds: ["development", "text"], difficulties: ["easy"], target: "easy" },
  ], defaultWorker: "easy", debate: { enabled: true, triggers: ["core", "major"], participants: ["fable"] } });
  if (!parsed.ok) throw new Error("Invalid fixture");
  const applied = store.sessions.applyCrew(original.session.id, parsed.document);
  const children: HarnessAgent[] = [];
  const nativeSuppression: boolean[] = [];
  const requests = [
    { taskKind: "design", difficulty: "hard" }, { taskKind: "research", difficulty: "medium" },
    { taskKind: "development", difficulty: "hard" }, { taskKind: "development", difficulty: "medium" },
    { taskKind: "development", difficulty: "easy" }, { taskKind: "text", difficulty: "easy" },
  ];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const makeHarness = (agent: HarnessAgent, extras: HarnessExtras): Harness => ({
    backend: agent.backend,
    async start(_session, actual) {
      if (actual.agentId.includes("#sub")) { children.push(actual); nativeSuppression.push(extras.disableNativeSubagents === true); }
    },
    async *send(): AsyncIterable<EngineEvent> {
      if (agent.agentId === applied.session.leadAgentId) {
        const delegate = extras.dynamicTools!.find((tool) => tool.name === "delegate_task")!;
        expect(extras.dynamicTools!.map((tool) => tool.name)).toContain("crew_debate");
        for (const request of requests) {
          const result = await delegate.run({ ...request, description: "Fixture task", prompt: "Offline fixture only" }, { cwd: project.path, log, maxOutputChars: 4096, ask: async () => ({}) });
          expect(result.isError).toBeUndefined();
        }
      }
      yield { type: "block", key: "answer", patch: { kind: "text", text: "Fixture complete" } };
      yield { type: "turn", status: "done" };
    },
    async interrupt() { return false; }, async dispose() {}, listCommands: () => [],
    answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null,
    capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true, subagents: true, resume: false, interrupt: true, slashCommands: false }),
  });
  const runner = createSessionRunner({ store, broadcast: () => {}, log, makeHarness,
    crewCapabilities: () => parsed.document.roster.map((entry) => ({ ...entry.target, efforts: [entry.target.effort] })),
  });
  try {
    runner.dispatch({ sessionId: applied.session.id, text: "Exercise configured routes" });
    await vi.waitFor(() => expect(runner.isSessionQuiescent?.(applied.session.id)).toBe(true));
    expect(children.map((child) => [child.backend, child.model])).toEqual([
      ["codex", "gpt-6-astra"], ["codex", "gpt-5.6-luna"], ["claude", "claude-opus-5"],
      ["claude", "claude-opus-5"], ["claude", "claude-sonnet-5"], ["claude", "claude-sonnet-5"],
    ]);
    expect(children[0]?.config).toMatchObject({ codex: { reasoningEffort: "low" } });
    expect(children[2]?.config).toMatchObject({ claude: { effort: "medium" } });
    expect(nativeSuppression).toEqual(Array(6).fill(true));
    const routes = store.blocks.listBySession(applied.session.id).filter((block) => block.kind === "subagent");
    expect(routes.map((block) => block.crewRoute?.rosterId)).toEqual(["design", "research", "dev", "dev", "easy", "easy"]);
    expect(runner.isSessionQuiescent?.(applied.session.id)).toBe(true);
    const restart = runner.restartSessionCrew!(applied.session.id, applied.agents.map((agent) => agent.id));
    expect(runner.isSessionQuiescent?.(applied.session.id)).toBe(false);
    expect(() => runner.dispatch({ sessionId: applied.session.id, text: "Racing dispatch" })).toThrow("restarting");
    expect(() => runner.continueChain(applied.session.id)).toThrow("restarting");
    await restart;
    expect(runner.isSessionQuiescent?.(applied.session.id)).toBe(true);
  } finally { await runner.dispose(); store.close(); }
});
