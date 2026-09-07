import { describe, expect, it } from "vitest";
import { IpcContractError, parseInvokeArgs } from "./index.js";

describe("selected Git commit IPC", () => {
  it.each([{ paths: undefined }, { paths: [] }])("rejects a missing or empty selection before dispatch", ({ paths }) => {
    expect(() => parseInvokeArgs("git.commit", {
      projectId: "project", message: "Selected changes", paths,
    })).toThrow(IpcContractError);
  });

  it("preserves literal selected paths", () => {
    const paths = ["-notes.txt", " leading space.txt", "日本語/file.txt"];
    expect(parseInvokeArgs("git.commit", {
      projectId: "project", message: "Selected changes", paths,
    }).paths).toEqual(paths);
  });
});
