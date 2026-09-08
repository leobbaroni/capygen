/**
 * The share codec's canonical form and the database's must not drift.
 *
 * `sharing/json.ts` reimplements canonical serialization on purpose — the
 * worker process must stay free of `@capygen/db` and its native SQLite binding
 * — and `SharesRepo.commit` hashes with the database's own copy. A staged
 * import's `contentSha256` is compared against a stored row's, so the moment
 * the two forms disagree, every re-import of an already-stored bundle would be
 * reported as a *conflicting* id rather than a duplicate.
 *
 * That is a silent, data-shaped failure, so it is pinned here rather than left
 * to the comment that asserts it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSha256, canonicalJson as dbCanonicalJson } from "@capygen/db";
import { canonicalJson as codecCanonicalJson } from "../src/sharing/json.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("the two canonical forms agree", () => {
  it.each([
    ["a flat object", { b: 2, a: 1 }],
    ["nested objects with unsorted keys", { z: { y: 1, x: [3, 2, 1] }, a: null }],
    ["arrays whose order is meaning", [{ i: 1 }, { i: 0 }]],
    ["strings that must not be normalized", { a: "café", b: "café" }],
    ["a present-but-undefined member", { a: 1, b: undefined }],
    ["empty containers", { a: {}, b: [] }],
    ["numbers and booleans", { a: 0, b: -1.5, c: true, d: false }],
    ["keys that sort by code unit", { "é": 1, e: 2, Z: 3, a: 4 }],
    ["a bundle-shaped document", {
      kind: "capygen.share", version: 1, bundleId: "a".repeat(32),
      entries: [{ index: 1, text: "second" }, { index: 0, text: "first" }],
      comments: [], counts: { entries: 2 },
    }],
  ])("%s hashes the same on both sides", (_name, value) => {
    expect(codecCanonicalJson(value)).toBe(dbCanonicalJson(value));
    expect(sha(codecCanonicalJson(value))).toBe(canonicalSha256(value));
  });

  it("is what the import preview compares against a stored row", () => {
    // The exact expression `workerJobs.summarize` uses, against the exact one
    // `SharesRepo.commit` stores.
    const bundle = { bundleId: "b".repeat(32), entries: [], comments: [] };
    expect(sha(codecCanonicalJson(bundle))).toBe(canonicalSha256(bundle));
  });
});
