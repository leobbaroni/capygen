import { expect, it, vi } from "vitest";
import { openStore } from "@capygen/db";
import type { EngineEvent, Harness, TurnInput } from "@capygen/engine";
import type { StoredImage } from "../src/ipc/attachments.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";

it("forwards the active parent images to a delegated child without leaking them into the next turn", async () => {
  const store = openStore(":memory:");
  const project = store.projects.upsertByPath({ path: "C:/owned-image-fixture" });
  const { session, agents } = store.sessions.create({ projectId: project.id, mode: "solo", agents: [
    { name: "Lead", backend: "codex", model: "gpt-5.6-luna", role: "lead", config: null },
  ] });
  const childInputs: TurnInput[] = [];
  const outcomes: unknown[] = [];
  const log = { info() {}, warn() {}, error() {} };
  const runner = createSessionRunner({ store, broadcast() {}, log,
    makeHarness: (agent, extras): Harness => ({
      backend: agent.backend, async start() {},
      async *send(input): AsyncIterable<EngineEvent> {
        if (agent.agentId === agents[0]!.id) {
          const delegate = extras.dynamicTools!.find((tool) => tool.name === "delegate_task")!;
          outcomes.push(await delegate.run({ description: "Inspect", prompt: "Describe the current picture" },
            { cwd: project.path, log, maxOutputChars: 4096, ask: async () => ({}) }));
        } else childInputs.push(input);
        yield { type: "turn", status: "done" };
      },
      async interrupt() { return true; }, async dispose() {},
      answerPermission: () => false, answerQuestion: () => false, backendSessionId: () => null,
      listCommands: () => [],
      capabilities: () => ({ imageInput: true, streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: false, interrupt: true, slashCommands: false }),
    }),
  });
  const images: StoredImage[] = [{ attachmentId: "att_fixture", path: "C:/owned-image-fixture/never-read.png", name: "diagram.png", mediaType: "image/png", size: 12 }];
  try {
    runner.dispatch({ sessionId: session.id, text: "Inspect this", images });
    await vi.waitFor(() => {
      expect(childInputs).toHaveLength(1);
      expect(runner.isSessionQuiescent!(session.id)).toBe(true);
    });
    expect(childInputs[0]!.images).toEqual(images.map(({ attachmentId: _id, ...image }) => image));
    expect(childInputs[0]!.images).not.toBe(images);
    expect(childInputs[0]!.images![0]).not.toBe(images[0]);
    expect(childInputs[0]!.text).toBe("Describe the current picture");
    runner.dispatch({ sessionId: session.id, text: "An unrelated text-only task" });
    await vi.waitFor(() => {
      expect(childInputs).toHaveLength(2);
      expect(runner.isSessionQuiescent!(session.id)).toBe(true);
    });
    expect(childInputs[1]!.images).toBeUndefined();
    expect(outcomes).toHaveLength(2);
    for (const result of outcomes) expect(result).not.toHaveProperty("isError", true);
  } finally { await runner.dispose(); store.close(); }
});
