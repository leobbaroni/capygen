import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import { parseCustomModeDocument } from "@capygen/shared";
import type { Harness, HarnessAgent, EngineEvent } from "@capygen/engine";
import { createSessionRunner, backendSessionToolsKey, dynamicToolSignature, type HarnessExtras } from "../src/engine/SessionRunner.js";
import { createSharedSkillTools } from "../src/engine/sharedSkills.js";
import { createSharedSkillsMcpServer } from "../src/engine/sharedSkillsMcp.js";

vi.mock("../src/engine/sharedSkillsMcp.js", () => ({
  createSharedSkillsMcpServer: vi.fn(async () => ({ capygen_skills: { type: "sdk", fixture: true } })),
}));
vi.mock("@capygen/engine", async (importOriginal) => ({
  ...await importOriginal<typeof import("@capygen/engine")>(),
  createDelegateMcpServer: vi.fn(async () => ({ capygen: { type: "sdk", fixtureDelegate: true } })),
}));
const log = { info() {}, warn() {}, error() {} };

it.each(["claude", "codex", "api"] as const)("passes shared skill tools to %s with stable Codex resume signature", async (backend) => {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/owned-shared-skills-fixture" });
  const created = store.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Reader", backend, model: "fixture", role: "lead", config: backend === "api" ? { api: { provider: "anthropic" } } : null }] });
  const tools = createSharedSkillTools(() => []);
  const factory = vi.fn(() => tools);
  const starts: HarnessAgent[] = [];
  const extrasSeen: HarnessExtras[] = [];
  const makeHarness = (agent: HarnessAgent, extras: HarnessExtras): Harness => ({
    backend,
    async start(_session, actual) {
      starts.push(actual); extrasSeen.push(extras);
      if (backend === "claude") expect(await extras.mcpServers?.()).toEqual({ capygen: { type: "sdk", fixtureDelegate: true }, capygen_skills: { type: "sdk", fixture: true } });
    },
    async *send(): AsyncIterable<EngineEvent> {
      yield { type: "session", backendSessionId: `thread-${agent.agentId}` };
      yield { type: "turn", status: "done" };
    },
    async interrupt() { return false; }, async dispose() {}, listCommands: () => [],
    answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null,
    capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: true, interrupt: true, slashCommands: false }),
  });
  let runner = createSessionRunner({ store, broadcast() {}, log, makeHarness, sharedSkillTools: factory });
  const send = async () => {
    const turn = store.turns.create({ sessionId: created.session.id, agentId: created.agents[0]!.id, role: "agent", status: "pending" });
    runner.send({ sessionId: created.session.id, turnId: turn.id, text: "fixture" });
    await vi.waitFor(() => expect(store.turns.get(turn.id)?.status).toBe("done"));
  };
  try {
    await send();
    expect(factory).toHaveBeenCalledWith(project.id);
    const extras = extrasSeen[0]!;
    if (backend === "claude") expect(createSharedSkillsMcpServer).toHaveBeenCalledWith(expect.objectContaining({ tools, projectPath: project.path }));
    if (backend === "api") expect(extras.extraTools?.map((tool) => tool.name)).toEqual(["delegate_task", "list_skills", "read_skill"]);
    if (backend === "codex") {
      expect(extras.dynamicTools?.map((tool) => tool.name)).toEqual(["delegate_task", "list_skills", "read_skill"]);
      expect(store.settings.getRaw(backendSessionToolsKey(created.agents[0]!.id), null)).toBe(dynamicToolSignature(extras.dynamicTools));
      expect(dynamicToolSignature(extras.dynamicTools)).not.toBe(dynamicToolSignature(extras.dynamicTools?.filter((tool) => tool.name === "delegate_task")));
      await runner.dispose();
      runner = createSessionRunner({ store, broadcast() {}, log, makeHarness, sharedSkillTools: factory });
      await send();
      expect(starts[1]?.resumeSessionId).toBe(`thread-${created.agents[0]!.id}`);
    }
  } finally { await runner.dispose(); store.close(); }
});

it("Custom nonlead receives shared readers and native suppression without delegate or debate tools", async () => {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/owned-custom-skills-fixture" });
  const original = store.sessions.create({ projectId: project.id, mode: "solo", agents: [
    { name: "Lead", backend: "codex", model: "fixture", role: "lead", config: null },
    { name: "Worker", backend: "codex", model: "fixture", role: "member", config: null },
  ] });
  const parsed = parseCustomModeDocument({ version: 1, title: "Skills fixture", roster: [
    { id: "lead", label: "Lead", role: "lead", target: { backend: "codex", model: "gpt-5.6-luna", effort: "low" }, instructions: "Lead" },
    { id: "member", label: "Member", role: "member", target: { backend: "codex", model: "gpt-5.6-luna", effort: "low" }, instructions: "Member" },
    { id: "worker", label: "Worker", role: "worker", target: { backend: "codex", model: "gpt-5.6-luna", effort: "low" }, instructions: "Worker" },
  ], routing: [], defaultWorker: "worker", debate: { enabled: false, triggers: [], participants: [] } });
  if (!parsed.ok) throw new Error("Invalid shared skills crew fixture");
  const { session, agents } = store.sessions.applyCrew(original.session.id, parsed.document);
  let extrasSeen: HarnessExtras | undefined;
  const runner = createSessionRunner({ store, broadcast() {}, log, sharedSkillTools: () => createSharedSkillTools(() => []), makeHarness: (_agent, extras) => {
    extrasSeen = extras;
    return { backend: "codex", async start() {}, async *send() { yield { type: "turn", status: "done" } as const; }, async interrupt() { return false; }, async dispose() {}, listCommands: () => [], answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null, capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: false, interrupt: true, slashCommands: false }) };
  } });
  try {
    const turn = store.turns.create({ sessionId: session.id, agentId: agents[1]!.id, role: "agent", status: "pending" });
    runner.send({ sessionId: session.id, turnId: turn.id, agentId: agents[1]!.id, text: "fixture" });
    await vi.waitFor(() => expect(store.turns.get(turn.id)?.status).toBe("done"));
    expect(extrasSeen?.disableNativeSubagents).toBe(true);
    expect(extrasSeen?.dynamicTools?.map((tool) => tool.name)).toEqual(["list_skills", "read_skill"]);
  } finally { await runner.dispose(); store.close(); }
});
