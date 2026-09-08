import { describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../src/asyncQueue.js";
import { createDelegateRunner } from "../src/routing/delegate.js";
import type { EngineEvent, Harness, HarnessAgent, HarnessSession } from "../src/harness.js";
import type { CustomModeDocument } from "@capygen/shared";

const session: HarnessSession = { sessionId: "s", projectPath: "C:/proj" };
const parent: HarnessAgent = { agentId: "lead", name: "Astra", backend: "codex", model: "astra", config: null };
const crew = {
  version: 1, title: "crew", description: "", defaultWorker: "dev",
  roster: [
    { id: "lead", label: "Astra", role: "lead", target: { backend: "codex", model: "astra", effort: "medium" }, instructions: "lead" },
    { id: "design", label: "Design", role: "worker", target: { backend: "codex", model: "astra", effort: "low" }, instructions: "visual brief" },
    { id: "dev", label: "Dev", role: "worker", target: { backend: "claude", model: "opus-5", effort: "medium" }, instructions: "build carefully" },
  ],
  routing: [
    { id: "specific", taskKinds: ["design"], difficulties: ["hard"], target: "design" },
    { id: "broad", taskKinds: ["design"], target: "dev" },
  ], debate: { enabled: false, triggers: [], participants: [] },
} as unknown as CustomModeDocument;

class Child implements Harness {
  readonly backend = "codex" as const;
  async interrupt() { return false; }
  listCommands() { return []; }
  capabilities() { return { streamingDeltas: true, permissions: true, questions: true, subagents: false, resume: false, interrupt: true, slashCommands: false }; }
  answerPermission() { return false; }
  answerQuestion() { return false; }
  backendSessionId() { return null; }
  started?: { session: HarnessSession; agent: HarnessAgent };
  async start(s: HarnessSession, a: HarnessAgent) { this.started = { session: s, agent: a }; }
  send() { const q = new AsyncQueue<EngineEvent>(); q.push({ type: "turn", status: "done" }); q.close(); return q; }
  async dispose() {}
}

describe("custom crew delegation", () => {
  it("requires classification and refuses model overrides before building", async () => {
    const make = vi.fn(() => new Child());
    const run = createDelegateRunner({ session, parent, target: () => null, customCrew: () => crew, makeHarness: make });
    expect((await run({ description: "x", prompt: "p" })).ok).toBe(false);
    expect((await run({ description: "x", prompt: "p", taskKind: "design", difficulty: "hard", model: "evil" })).ok).toBe(false);
    expect(make).not.toHaveBeenCalled();
  });

  it("refuses a backend or effort override, the same way it refuses a model", async () => {
    // The universal tool lets an ordinary agent pick its own backend, model and
    // effort. Custom Mode is classified routing: the policy chooses, and a call
    // that tries to steer is refused rather than quietly ignored.
    const make = vi.fn(() => new Child());
    const run = createDelegateRunner({ session, parent, target: () => null, customCrew: () => crew, makeHarness: make });
    const classified = { description: "x", prompt: "p", taskKind: "design", difficulty: "hard" } as const;

    const backend = await run({ ...classified, backend: "claude" });
    expect(backend.ok).toBe(false);
    expect(backend.text).toMatch(/does not accept backend, model or effort overrides/);
    const effort = await run({ ...classified, effort: "high" });
    expect(effort.ok).toBe(false);
    expect(effort.text).toMatch(/does not accept backend, model or effort overrides/);

    // And the classified route still runs, with the policy's own effort.
    const allowed = await run(classified);
    expect(allowed.ok).toBe(true);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("uses first matching rule and carries exact target config and evidence", async () => {
    const child = new Child(); const events: EngineEvent[] = [];
    const make = vi.fn((_target: { backend: HarnessAgent["backend"]; model: string }, _agent: HarnessAgent) => child);
    const run = createDelegateRunner({ session, parent, target: () => null, customCrew: () => crew, makeHarness: make, onEvent: (e) => events.push(e) });
    const result = await run({ description: "design", prompt: "p", taskKind: "design", difficulty: "hard" });
    expect(result.ok).toBe(true);
    expect(child.started?.agent).toMatchObject({ backend: "codex", model: "astra", config: { codex: { reasoningEffort: "low" } }, promptAddition: "visual brief" });
    expect(make.mock.calls[0]?.[1]).toBe(child.started?.agent);
    expect(events.some((e) => e.type === "block" && e.patch.kind === "subagent" && (e.patch as any).crewRoute?.ruleId === "specific")).toBe(true);
  });

  it("does not fall back to ordinary routing when the custom policy is unavailable", async () => {
    const make = vi.fn(() => new Child());
    const run = createDelegateRunner({ session, parent, customCrew: () => null, target: () => ({ backend: "claude", model: "opus-5" }), makeHarness: make });
    expect((await run({ description: "x", prompt: "p", taskKind: "research", difficulty: "easy" })).ok).toBe(false);
    expect(make).not.toHaveBeenCalled();
  });
});
