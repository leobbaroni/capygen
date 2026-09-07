import { describe, expect, it } from "vitest";
import { INVOKE_CHANNELS } from "./ipc.js";

describe("transcript import IPC", () => {
  it("accepts a destination for the native picker, never renderer-supplied source paths or owners", () => {
    const input = INVOKE_CHANNELS["imports.pick"].input;
    expect(input.parse({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
    expect(input.safeParse({ projectId: "project-1", sourcePath: "C:\\secret", ownerId: 2 }).success).toBe(false);
  });
  it("commits only an opaque preview handle with no replacement destination or snapshot", () => {
    const input = INVOKE_CHANNELS["imports.commit"].input;
    const handle = "a".repeat(32);
    expect(input.parse({ handle })).toEqual({ handle });
    expect(input.safeParse({ handle, projectId: "other" }).success).toBe(false);
    expect(input.safeParse({ handle, snapshot: {} }).success).toBe(false);
  });
  it("bounds history pagination and requires an explicit continuation destination", () => {
    expect(INVOKE_CHANNELS["imports.entries"].input.parse({ sessionId: "import-1" }))
      .toEqual({ sessionId: "import-1", offset: 0, limit: 50 });
    expect(INVOKE_CHANNELS["imports.entries"].input.safeParse({ sessionId: "import-1", limit: 101 }).success).toBe(false);
    expect(INVOKE_CHANNELS["imports.continue"].input.safeParse({ sessionId: "import-1" }).success).toBe(false);
  });
});
