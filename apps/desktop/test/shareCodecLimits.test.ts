import { describe, expect, it } from "vitest";
import { SHARE_LIMITS, type Block, type TurnRole } from "@capygen/shared";
import { ShareCodecError, projectShareBundle, type ShareProjectionInput } from "../src/sharing/index.js";

const block = (index: number, over: Record<string, unknown>): Block => ({
  id: `blk_${index}`, turnId: "trn_1", sessionId: "ses_1", index,
  createdAt: 1_757_000_000_000 + index, updatedAt: 1_757_000_000_000 + index, ...over,
}) as unknown as Block;

const text = (index: number): ShareProjectionInput["blocks"][number] =>
  ({ block: block(index, { kind: "text", text: `Message ${index}` }), turnRole: "agent" as TurnRole });

const agent = (n: number) => ({ label: `Agent ${n}`, backend: null, model: null });

const comment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `${n}`.padStart(32, "0"), entryIndex: null, author: `Author ${n}`, body: `Note ${n}`,
  createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false, ...over,
});

function project(over: Partial<ShareProjectionInput> = {}) {
  return projectShareBundle({
    blocks: [text(0)],
    metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    comments: [],
    options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
    ...over,
  });
}

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof ShareCodecError ? error.code : `unexpected: ${String(error)}`;
  }
  return "no-throw";
};

describe("cardinality caps refuse rather than quietly discard", () => {
  it("refuses more entries than the limit instead of dropping the tail", () => {
    const blocks = [text(0), text(1), text(2)];
    const limits = { maxEntries: 2 };
    expect(codeOf(() => project({ blocks, options: {
      bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z", limits } })))
      .toBe("over-limit");

    // Exactly at the cap is kept whole — nothing is lost at the boundary.
    const atCap = project({ blocks: blocks.slice(0, 2), options: {
      bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z", limits } });
    expect(atCap.entries).toHaveLength(2);
    expect(atCap.counts.entries).toBe(2);
    expect((atCap.entries[1] as { text: string }).text).toBe("Message 1");
  });

  it("refuses more agents than the limit instead of slicing the list", () => {
    const metadata = (count: number) => ({ title: "T", mode: "solo" as const,
      startedAt: null, endedAt: null, agents: Array.from({ length: count }, (_, i) => agent(i)) });
    const options = { bundleId: "a".repeat(32), appVersion: "0.1.0",
      createdAt: "2026-09-07T10:00:00Z", limits: { maxAgents: 2 } };
    expect(codeOf(() => project({ metadata: metadata(3), options }))).toBe("over-limit");
    const atCap = project({ metadata: metadata(2), options });
    expect(atCap.source.agents.map((a) => a.label)).toEqual(["Agent 0", "Agent 1"]);
  });

  it("refuses more comments than the limit instead of slicing them", () => {
    const options = { bundleId: "a".repeat(32), appVersion: "0.1.0",
      createdAt: "2026-09-07T10:00:00Z", limits: { maxComments: 2 } };
    expect(codeOf(() => project({ comments: [comment(1), comment(2), comment(3)], options })))
      .toBe("over-limit");
    const atCap = project({ comments: [comment(1), comment(2)], options });
    expect(atCap.comments.map((c) => c.body)).toEqual(["Note 1", "Note 2"]);
  });

  it("refuses comment input the bundle could not represent faithfully", () => {
    expect(codeOf(() => project({ comments: [comment(1), comment(1, { body: "Different" })] })))
      .toBe("over-limit");
    expect(codeOf(() => project({ comments: [comment(1, { replyToId: comment(9).id })] })))
      .toBe("over-limit");
    // A reply to an earlier comment is fine.
    expect(project({ comments: [comment(1), comment(2, { replyToId: comment(1).id })] })
      .comments[1]!.replyToId).toBe(comment(1).id);
  });

  it("keeps projection limits tighten-only against the shared contract", () => {
    for (const limits of [{ maxEntries: SHARE_LIMITS.maxEntries + 1 },
      { maxComments: SHARE_LIMITS.maxComments + 1 }, { maxAgents: 0 }]) {
      expect(() => project({ options: { bundleId: "a".repeat(32), appVersion: "0.1.0",
        createdAt: "2026-09-07T10:00:00Z", limits } })).toThrow();
    }
  });
});

describe("documented omissions stay omissions", () => {
  it("still drops reasoning, interaction and widgets against their counters", () => {
    const bundle = project({ blocks: [
      text(0),
      { block: block(1, { kind: "thinking", text: "reasoning" }), turnRole: "agent" },
      { block: block(2, { kind: "permission", request: { toolName: "Bash", input: {} },
        decision: { outcome: "allow" } }), turnRole: "agent" },
      { block: block(3, { kind: "widget", toolCallId: "t", serverName: "s", toolName: "w",
        resourceUri: "ui://x", html: "<b>x</b>", htmlStatus: "ready", toolInput: {},
        toolResult: null, meta: null }), turnRole: "agent" },
      { block: block(4, { kind: "usage", totals: { input: 1, output: 1, cached: 0, costUsd: 0 } }),
        turnRole: "agent" },
    ] });
    expect(bundle.counts).toMatchObject({ entries: 1, droppedThinking: 1, droppedInteractive: 1,
      droppedWidgets: 1, droppedUsage: 1 });
  });

  it("still clips over-long text and flags it rather than refusing the export", () => {
    const bundle = project({ blocks: [
      { block: block(0, { kind: "text", text: "z".repeat(70_000) }), turnRole: "agent" }] });
    expect(bundle.entries[0]!.truncated).toBe(true);
    expect(bundle.counts.truncatedTexts).toBe(1);
    expect(new TextEncoder().encode((bundle.entries[0] as { text: string }).text).byteLength)
      .toBeLessThanOrEqual(65_536);
  });
});

describe("an unmodelled block kind is a refusal, not a silent omission", () => {
  it("refuses rather than claiming a complete projection it cannot count", () => {
    const future = { block: block(1, { kind: "holo-render", payload: "sk-ant-api03-SECRETVALUE" }),
      turnRole: "agent" as TurnRole };
    let message = "";
    const code = codeOf(() => {
      try {
        return project({ blocks: [text(0), future] });
      } catch (error) {
        message = (error as Error).message;
        throw error;
      }
    });
    expect(code).toBe("unsupported-block");
    // The refusal names no value from the block it refused.
    expect(message).not.toContain("holo-render");
    expect(message).not.toContain("sk-ant");
  });
});
