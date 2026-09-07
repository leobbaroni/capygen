import { describe, expect, it } from "vitest";
import { INVOKE_CHANNELS } from "./ipc.js";

describe("worktree IPC", () => {
  it("always requires the explicit source project", () => {
    for (const channel of ["worktrees.list", "worktrees.create", "worktrees.register", "worktrees.remove"] as const) {
      expect(INVOKE_CHANNELS[channel].input.safeParse({}).success).toBe(false);
    }
  });

  it("keeps native destination authority out of create and force out of remove", () => {
    const create = INVOKE_CHANNELS["worktrees.create"].input;
    expect(create.parse({
      sourceProjectId: "project-1",
      branch: { mode: "new", name: "feature/x", base: "main" },
    })).toEqual({
      sourceProjectId: "project-1",
      branch: { mode: "new", name: "feature/x", base: "main" },
    });
    expect(create.safeParse({
      sourceProjectId: "project-1",
      destinationPath: "C:\\chosen-by-renderer",
      branch: { mode: "existing", name: "feature/x" },
    }).success).toBe(false);
    expect(INVOKE_CHANNELS["worktrees.remove"].input.safeParse({
      sourceProjectId: "project-1",
      path: "C:\\worktree",
      force: true,
    }).success).toBe(false);
  });
});
