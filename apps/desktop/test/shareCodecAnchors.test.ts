import { describe, expect, it } from "vitest";
import type { Block, TurnRole } from "@capygen/shared";
import {
  ShareCodecError,
  projectShareBundle,
  redactText,
  sanitizeLabel,
  type ShareProjectionInput,
} from "../src/sharing/index.js";

const block = (index: number, over: Record<string, unknown>): Block => ({
  id: `blk_${index}`, turnId: "trn_1", sessionId: "ses_1", index,
  createdAt: 1_757_000_000_000 + index, updatedAt: 1_757_000_000_000 + index, ...over,
}) as unknown as Block;

const at = (index: number, over: Record<string, unknown>) =>
  ({ block: block(index, over), turnRole: "agent" as TurnRole });

/**
 * Source order, with two blocks that are withheld by default:
 *   0 thinking (withheld)   1 text "first"    2 widget (withheld)   3 text "second"
 * so the projected entries are [ "first", "second" ].
 */
const interleaved = (): ShareProjectionInput["blocks"] => [
  at(0, { kind: "thinking", text: "reasoning" }),
  at(1, { kind: "text", text: "first" }),
  at(2, { kind: "widget", toolCallId: "t", serverName: "s", toolName: "w", resourceUri: "ui://x",
    html: "<b>x</b>", htmlStatus: "ready", toolInput: {}, toolResult: null, meta: null }),
  at(3, { kind: "text", text: "second" }),
];

const comment = (n: number, entryIndex: number | null) => ({
  id: `${n}`.padStart(32, "0"), entryIndex, author: `Author ${n}`, body: `Note ${n}`,
  createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false,
});

function project(over: Partial<ShareProjectionInput> = {}, includeReasoning = false) {
  return projectShareBundle({
    blocks: interleaved(),
    metadata: { title: "T", mode: "solo", startedAt: null, endedAt: null, agents: [] },
    comments: [],
    options: { bundleId: "a".repeat(32), appVersion: "0.1.0",
      createdAt: "2026-09-07T10:00:00Z", includeReasoning },
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

describe("comment anchors are mapped from source blocks, not copied", () => {
  it("follows the block a comment was written on when earlier blocks are withheld", () => {
    const bundle = project({ comments: [comment(1, 1), comment(2, 3)] });
    expect(bundle.entries.map((entry) => (entry as { text: string }).text)).toEqual(["first", "second"]);
    // Source 1 is projected entry 0, source 3 is projected entry 1. Copying the
    // numbers through would have pointed both at the wrong text.
    expect(bundle.comments.map((c) => c.entryIndex)).toEqual([0, 1]);
  });

  it("does not let a comment on a withheld block land on an unrelated entry", () => {
    const bundle = project({ comments: [comment(1, 0), comment(2, 2)] });
    expect(bundle.comments.map((c) => c.entryIndex)).toEqual([null, null]);
    expect(bundle.comments).toHaveLength(2);
  });

  it("re-maps when opting reasoning in shifts every later entry", () => {
    const withReasoning = project({ comments: [comment(1, 1), comment(2, 3), comment(3, 0)] }, true);
    expect(withReasoning.entries.map((entry) => entry.kind))
      .toEqual(["thinking", "message", "message"]);
    // Source 0 now exists as entry 0, so its comment anchors instead of nulling.
    expect(withReasoning.comments.map((c) => c.entryIndex)).toEqual([1, 2, 0]);

    const withoutReasoning = project({ comments: [comment(1, 1), comment(2, 3), comment(3, 0)] });
    expect(withoutReasoning.comments.map((c) => c.entryIndex)).toEqual([0, 1, null]);
  });

  it("keeps a session-level comment unanchored", () => {
    expect(project({ comments: [comment(1, null)] }).comments[0]!.entryIndex).toBeNull();
  });

  it("refuses an anchor that names no source block", () => {
    for (const anchor of [4, 99, -1, 1.5, Number.NaN]) {
      expect(codeOf(() => project({ comments: [comment(1, anchor)] }))).toBe("invalid-anchor");
    }
  });
});

describe("display labels cannot forge their own framing", () => {
  it("strips bidi overrides and isolates while keeping real RTL letters", () => {
    const forged = `Reviewer‮Owner‬`;
    const result = sanitizeLabel(forged, 120);
    for (const control of ["‪", "‫", "‬", "‭", "‮",
      "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"]) {
      expect(sanitizeLabel(`A${control}B`, 120).text).toBe("AB");
    }
    expect(result.text).toBe("ReviewerOwner");
    // Arabic and Hebrew letters are content, not framing.
    expect(sanitizeLabel("مرحبا شالوم", 120).text).toBe("مرحبا شالوم");
  });

  it("keeps the projected source labels clean", () => {
    const bundle = projectShareBundle({
      blocks: [at(0, { kind: "tool_call", name: "Ba‮sh", status: "success", input: {} })],
      metadata: { title: "T⁦itle", mode: "solo", startedAt: null, endedAt: null,
        agents: [{ label: "Agent‮ Owner", backend: null, model: null }] },
      comments: [{ id: "b".repeat(32), entryIndex: null, author: "Rev⁩iewer", body: "n",
        createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false }],
      options: { bundleId: "a".repeat(32), appVersion: "0.1.0", createdAt: "2026-09-07T10:00:00Z" },
    });
    const serialized = JSON.stringify(bundle);
    for (const control of ["‮", "⁦", "⁩"]) expect(serialized).not.toContain(control);
    expect(bundle.source.title).toBe("Title");
    expect(bundle.source.agents[0]!.label).toBe("Agent Owner");
    expect(bundle.comments[0]!.author).toBe("Reviewer");
  });
});

describe("redaction stays linear on large plain text", () => {
  it("scans half a megabyte well inside a bound a quadratic rule would blow", () => {
    // The URL rule was once quadratic: ~4 s at 70 KB, minutes at this size.
    // Any future unbounded quantifier fails here rather than in a user's export.
    const text = `${"z".repeat(262_144)} https://example.com/docs ${"q".repeat(262_144)}`;
    const started = performance.now();
    const result = redactText(text);
    const elapsed = performance.now() - started;
    expect(result.redactions).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
