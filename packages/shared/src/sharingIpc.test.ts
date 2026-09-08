import { describe, expect, it } from "vitest";
import { INVOKE_CHANNELS } from "./ipc.js";

describe("paged share comment previews", () => {
  const comment = {
    id: "c".repeat(32), entryIndex: null, author: "Reviewer", body: "A note",
    createdAt: "2026-09-08T01:00:00Z", replyToId: null, resolved: false,
  };

  for (const channel of ["sharing.export.comments", "sharing.import.comments"] as const) {
    it(`${channel} bounds pages and rejects authority or payload injection`, () => {
      const contract = INVOKE_CHANNELS[channel];
      const request = { handle: "a".repeat(32) };
      expect(contract.input.parse(request)).toEqual({ ...request, offset: 0, limit: 50 });
      for (const extra of [{ limit: 101 }, { limit: 0 }, { offset: -1 },
        { ownerId: 1 }, { filePath: "C:/private.json" }, { comments: [comment] }]) {
        expect(contract.input.safeParse({ ...request, ...extra }).success).toBe(false);
      }
      expect(contract.output.parse([comment])).toEqual([comment]);
      expect(contract.output.safeParse(Array(101).fill(comment)).success).toBe(false);
      expect(contract.output.safeParse([{ ...comment, nativeSessionId: "private" }]).success).toBe(false);
    });
  }
});
