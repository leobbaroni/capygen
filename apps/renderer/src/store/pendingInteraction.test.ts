/**
 * `pendingInteractionBlock` — "is something actually waiting on the user?".
 *
 * Two consumers depend on the answer: the mascot's `waiting` state
 * (`lib/mascotState.ts`, where `waiting` outranks everything but `listening`)
 * and `PermissionCard`, which arms its Enter/Escape shortcut only on the block
 * this returns.
 */
import { describe, expect, it } from "vitest";
import type { Block } from "@capygen/shared";
import { pendingInteractionBlock, type AppState } from "./appStore";

const base = { turnId: "trn_1", sessionId: "ses_1", index: 0, createdAt: 1, updatedAt: 1 };

function state(blocks: Block[], staleRequests: string[] = []): AppState {
  return {
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    staleRequests,
  } as unknown as AppState;
}

const permission: Block = {
  ...base,
  id: "b-perm",
  kind: "permission",
  request: { requestId: "req-p", toolName: "Bash", input: {}, suggestions: [] },
  decision: null,
};

const elicitation: Block = {
  ...base,
  id: "b-elicit",
  kind: "elicitation",
  requestId: "req-e",
  title: "capyfixture",
  schema: null,
  answers: null,
  status: "pending",
};

describe("pendingInteractionBlock", () => {
  it("counts a pending elicitation, the third interaction kind R32 names", () => {
    // Missing before: a Codex MCP server blocked on an elicitation form left
    // the mascot on "thinking" while the turn was waiting on a click.
    expect(pendingInteractionBlock(state([elicitation]))?.id).toBe("b-elicit");
  });

  it("counts a pending permission and an unanswered question", () => {
    expect(pendingInteractionBlock(state([permission]))?.id).toBe("b-perm");
    const question: Block = {
      ...base,
      id: "b-q",
      kind: "question",
      requestId: "req-q",
      questions: [],
      answers: null,
    };
    expect(pendingInteractionBlock(state([question]))?.id).toBe("b-q");
  });

  it("skips a request the user already answered into the void", () => {
    // The row keeps `decision: null` forever after a stale answer, which used
    // to pin the mascot to "waiting" for the rest of the session.
    expect(pendingInteractionBlock(state([permission], ["req-p"]))).toBeNull();
    expect(pendingInteractionBlock(state([elicitation], ["b-elicit"]))).toBeNull();
  });

  it("skips a cancelled question", () => {
    const cancelled: Block = {
      ...base,
      id: "b-qc",
      kind: "question",
      requestId: "req-qc",
      questions: [],
      answers: null,
      status: "cancelled",
    };
    expect(pendingInteractionBlock(state([cancelled]))).toBeNull();
  });

  it("returns the oldest of several, so exactly one card owns the shortcut", () => {
    const newer: Block = { ...permission, id: "b-perm-2", createdAt: 5 };
    expect(pendingInteractionBlock(state([newer, permission]))?.id).toBe("b-perm");
  });
});
