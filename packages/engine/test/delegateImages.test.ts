import { describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../src/asyncQueue.js";
import type { EngineEvent, Harness, HarnessAgent, TurnImage, TurnInput } from "../src/harness.js";
import { createDelegateRunner } from "../src/routing/delegate.js";

const parent: HarnessAgent = { agentId: "lead", name: "Lead", backend: "codex", model: "gpt-5.6-luna", config: null };
const picture = (name: string): TurnImage => ({ path: `C:/owned/${name}.png`, name, mediaType: "image/png", size: 10 });
function child(imageInput = true) {
  return {
    backend: "codex",
    capabilities: () => ({ streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: false, interrupt: true, slashCommands: false, imageInput }),
    start: vi.fn(async () => {}),
    send: vi.fn((_input: TurnInput) => {
      const queue = new AsyncQueue<EngineEvent>();
      queue.push({ type: "turn", status: "done" }); queue.close(); return queue;
    }),
    interrupt: async () => false,
    dispose: vi.fn(async () => {}),
    answerPermission: () => false,
    answerQuestion: () => false,
    backendSessionId: () => null,
    listCommands: () => [],
  } satisfies Harness;
}

describe("delegated image transport", () => {
  it("snapshots current host attachments per invocation without changing the prompt", async () => {
    let images = [picture("first")];
    const children = [child(), child()]; let index = 0;
    const run = createDelegateRunner({
      session: { sessionId: "s", projectPath: "C:/owned" }, parent,
      target: () => ({ backend: "codex", model: parent.model! }),
      images: () => images, makeHarness: () => children[index++]!,
    });
    expect((await run({ description: "Inspect", prompt: "Describe the picture" })).ok).toBe(true);
    const first = children[0]!.send.mock.calls[0]![0];
    expect(first.text).toBe("Describe the picture");
    expect(first.images).toEqual(images);
    expect(first.images).not.toBe(images);
    expect(first.images![0]).not.toBe(images[0]);
    images = [picture("second")];
    expect((await run({ description: "Inspect again", prompt: "Compare" })).ok).toBe(true);
    expect(children[1]!.send.mock.calls[0]![0].images).toEqual(images);
    expect(first.images![0]!.name).toBe("first");
  });

  it.each([[false, "gpt-5.6-luna"], [true, "o3-mini"]] as const)("runs text tasks with an explicit image omission for unsupported capability/model (%s, %s)", async (supported, model) => {
    const harness = child(supported);
    const run = createDelegateRunner({
      session: { sessionId: "s", projectPath: "C:/owned" }, parent,
      target: () => ({ backend: "codex", model }),
      images: () => [picture("private")], makeHarness: () => harness,
    });
    const result = await run({ description: "Inspect", prompt: "Describe" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("image attachments were not forwarded");
    expect(result.text).not.toContain("C:/owned");
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.send.mock.calls[0]![0].images).toBeUndefined();
    expect(harness.send.mock.calls[0]![0].text).toContain("Do not claim to inspect them");
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("does not resolve attachments or construct a child for an already cancelled call", async () => {
    const images = vi.fn(() => [picture("unused")]);
    const makeHarness = vi.fn(() => child());
    const controller = new AbortController(); controller.abort();
    const run = createDelegateRunner({
      session: { sessionId: "s", projectPath: "C:/owned" }, parent,
      target: () => ({ backend: "codex", model: parent.model! }), images, makeHarness,
    });
    expect((await run({ description: "Inspect", prompt: "Describe", signal: controller.signal })).status).toBe("interrupted");
    expect(images).not.toHaveBeenCalled();
    expect(makeHarness).not.toHaveBeenCalled();
  });
});
