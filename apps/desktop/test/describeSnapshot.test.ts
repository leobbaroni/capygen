/**
 * [C] `describeSnapshot.ts` — the seam that turns a *running* harness into the
 * snapshot `agentsDescribe.ts` composes (SPEC R13).
 *
 * The three backend `describe.ts` files and `agentsDescribe.ts` were each
 * built and tested against plain snapshots; nothing until now asserted that a
 * harness's own getter is read, narrowed to the right backend, and merged with
 * the config-only halves (`codexConfigDefaults`, `apiConfigDefaults`). This
 * suite is that assertion, plus the two failure modes an info card must never
 * turn into an exception: a harness without the getter, and a getter that
 * throws.
 */
import { describe, expect, it } from "vitest";
import type { HarnessCapabilities } from "@capygen/engine";
import type { Agent } from "@capygen/shared";
import { harnessDescribeSnapshot } from "../src/engine/describeSnapshot.js";

const CAPS: HarnessCapabilities = {
  streamingDeltas: true,
  permissions: true,
  questions: true,
  subagents: true,
  resume: true,
  interrupt: true,
  slashCommands: true,
};

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agt_1",
    sessionId: "ses_1",
    name: "lead",
    displayName: "Lead",
    mentionName: "lead",
    backend: "claude",
    model: "claude-sonnet-5",
    role: "lead",
    order: 0,
    config: null,
    createdAt: 0,
    ...over,
  };
}

/** The minimum a harness has to look like for this file. */
function harness(backend: string, snapshot: () => unknown) {
  return { backend, capabilities: () => CAPS, describeSnapshot: snapshot };
}

describe("harnessDescribeSnapshot", () => {
  it("passes a Claude init snapshot straight through", async () => {
    const init = {
      model: "claude-sonnet-5",
      permissionMode: "bypassPermissions",
      tools: ["Read", "Bash", "Task"],
      mcpServers: [{ name: "comfy", status: "connected" }],
      skills: ["graphify"],
      plugins: [{ name: "cockpit", version: "1.0.0" }],
    };
    const snapshot = await harnessDescribeSnapshot(harness("claude", () => init), agent());
    expect(snapshot?.claude).toEqual(init);
    expect(snapshot?.capabilities).toEqual(CAPS);
    expect(snapshot?.codex).toBeUndefined();
    expect(snapshot?.api).toBeUndefined();
  });

  it("merges Codex's live listing with the sandbox/approval facts off the agent row", async () => {
    const live = { mcpServers: [{ name: "comfy", tools: { a: {}, b: {} } }], skills: [] };
    const snapshot = await harnessDescribeSnapshot(
      harness("codex", () => Promise.resolve(live)),
      agent({
        backend: "codex",
        model: "gpt-5.5",
        config: { codex: { approvalPolicy: "untrusted", sandbox: "read-only" } },
      }),
    );
    // The two halves: the app-server's answer, and the config's.
    expect(snapshot?.codex?.mcpServers).toEqual(live.mcpServers);
    expect(snapshot?.codex?.approvalPolicy).toBe("untrusted");
    expect(snapshot?.codex?.sandbox).toBe("read-only");
    expect(snapshot?.codex?.model).toBe("gpt-5.5");
  });

  it("merges the API loop's tool list with its provider", async () => {
    const snapshot = await harnessDescribeSnapshot(
      harness("api", () => ({ tools: ["read", "bash"], mcpServers: [] })),
      agent({ backend: "api", model: "gpt-5.5", config: { api: { provider: "openai", model: "gpt-5.5" } } }),
    );
    expect(snapshot?.api?.tools).toEqual(["read", "bash"]);
    expect(snapshot?.api?.provider).toBe("openai");
  });

  it("has no snapshot for a harness that offers no getter", async () => {
    const bare = { backend: "claude", capabilities: () => CAPS };
    expect(await harnessDescribeSnapshot(bare, agent())).toBeUndefined();
  });

  it("has no snapshot when the getter throws — a card never fails a lookup", async () => {
    const thrower = harness("claude", () => {
      throw new Error("app-server is shutting down");
    });
    expect(await harnessDescribeSnapshot(thrower, agent())).toBeUndefined();
  });

  it("has no snapshot when there is no harness at all (agent has not spoken)", async () => {
    expect(await harnessDescribeSnapshot(undefined, agent())).toBeUndefined();
  });
});
