import { describe, expect, it } from "vitest";
import {
  WorktreeBranchChoiceSchema,
  WorktreeCreateResultSchema,
  WorktreeSchema,
} from "./worktrees.js";

describe("worktree contracts", () => {
  it("represents branch, detached, lock and prune state without guessing", () => {
    expect(WorktreeSchema.parse({
      path: "C:\\repo worktree",
      kind: "linked",
      headCommit: "a".repeat(40),
      branch: null,
      detached: true,
      locked: true,
      lockReason: "portable drive",
      prunable: false,
      pruneReason: null,
      projectId: null,
    })).toMatchObject({ detached: true, branch: null, locked: true });
    expect(WorktreeSchema.safeParse({
      path: "C:\\repo",
      kind: "linked",
      headCommit: "not-a-commit",
      branch: "main",
      detached: true,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
      projectId: null,
    }).success).toBe(false);
  });

  it("requires a committed base only when the user names a new branch", () => {
    expect(WorktreeBranchChoiceSchema.parse({ mode: "existing", name: "feature/x" }))
      .toEqual({ mode: "existing", name: "feature/x" });
    expect(WorktreeBranchChoiceSchema.parse({ mode: "new", name: "feature/y", base: "main" }))
      .toEqual({ mode: "new", name: "feature/y", base: "main" });
    expect(WorktreeBranchChoiceSchema.safeParse({ mode: "new", name: "feature/y" }).success)
      .toBe(false);
  });

  it("returns the concrete registered project with a created worktree", () => {
    const parsed = WorktreeCreateResultSchema.safeParse({ worktree: {}, project: {} });
    expect(parsed.success).toBe(false);
  });
});
