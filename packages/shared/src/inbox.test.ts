import { describe, expect, it } from "vitest";
import { InboxItemSchema } from "./inbox.js";

const base = { id: "i", sessionId: "s", turnId: "t", title: "", body: "", targetBlockId: null, createdAt: 1, resolvedAt: null, readAt: null };

describe("inbox contracts", () => {
  it("validates request and terminal dedupe keys", () => {
    expect(InboxItemSchema.safeParse({ ...base, kind: "permission", requestId: "r", dedupeKey: "permission:s:r" }).success).toBe(true);
    expect(InboxItemSchema.safeParse({ ...base, kind: "finished", requestId: null, dedupeKey: "finished:t" }).success).toBe(true);
  });

  it("rejects keys that cannot provide restart deduplication", () => {
    expect(InboxItemSchema.safeParse({ ...base, kind: "question", requestId: null, dedupeKey: "question:s" }).success).toBe(false);
    expect(InboxItemSchema.safeParse({ ...base, kind: "error", requestId: null, dedupeKey: "wrong" }).success).toBe(false);
  });
});
