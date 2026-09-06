/**
 * `GitService` against a real temp repository driven by the real `git.exe`
 * (SPEC R16, Diff pane).
 *
 * A fake `simple-git` would prove nothing about the one thing that actually
 * breaks here — the shape of git's own output — so the repo is real and only
 * the "no git on this machine" case is skipped, with the reason printed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService, splitUnifiedDiff } from "../src/workspace/GitService.js";
import { makeHarness, seed, type Harness } from "./workspaceHarness.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

let h: Harness;
let service: GitService;

function git(args: string[], cwd = h.root): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-git-" });
  service = new GitService({ store: h.store, log: h.log });
});

afterEach(() => h.close());

describe("git.status", () => {
  it("answers null for a folder that is not a repository — not an error", async () => {
    seed(h.root, { "a.txt": "hello\n" });
    await expect(service.status({ projectId: h.projectId })).resolves.toBeNull();
  });

  it("answers [] from git.diff on a non-repo too", async () => {
    await expect(service.diff({ projectId: h.projectId, staged: false })).resolves.toEqual([]);
  });

  it("refuses to commit into a non-repo, loudly", async () => {
    await expect(
      service.commit({ projectId: h.projectId, message: "nope" }),
    ).rejects.toThrow(/not a git repository/);
  });
});

describe.skipIf(!HAS_GIT)("git.status / diff / commit on a real repo", () => {
  beforeEach(() => {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@capygen.local"]);
    git(["config", "user.name", "capygen test"]);
    seed(h.root, { "tracked.txt": "one\n", "src/app.ts": "export const a = 1;\n" });
    git(["add", "."]);
    git(["commit", "-m", "initial"]);
  });

  it("reports the branch and one entry per changed file", async () => {
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(h.root, "untracked.txt"), "new\n");

    const status = await service.status({ projectId: h.projectId });
    expect(status).not.toBeNull();
    expect(status?.branch).toBe("main");
    expect(status?.ahead).toBe(0);
    expect(status?.behind).toBe(0);

    const byPath = Object.fromEntries((status?.entries ?? []).map((e) => [e.path, e.status]));
    expect(byPath["tracked.txt"]).toBe("M");
    expect(byPath["untracked.txt"]).toBe("??");
  });

  it("splits the working-tree diff into one entry per file, POSIX paths", async () => {
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(h.root, "src", "app.ts"), "export const a = 2;\n");

    const diffs = await service.diff({ projectId: h.projectId, staged: false });
    expect(diffs.map((d) => d.path).sort()).toEqual(["src/app.ts", "tracked.txt"]);
    const tracked = diffs.find((d) => d.path === "tracked.txt");
    expect(tracked?.unified).toContain("-one");
    expect(tracked?.unified).toContain("+two");
    // Each entry carries only its own file's patch.
    expect(tracked?.unified).not.toContain("src/app.ts");
  });

  it("narrows to one path, and reads the index when staged", async () => {
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(h.root, "src", "app.ts"), "export const a = 2;\n");
    git(["add", "src/app.ts"]);

    const oneFile = await service.diff({
      projectId: h.projectId,
      path: "tracked.txt",
      staged: false,
    });
    expect(oneFile.map((d) => d.path)).toEqual(["tracked.txt"]);

    const staged = await service.diff({ projectId: h.projectId, staged: true });
    expect(staged.map((d) => d.path)).toEqual(["src/app.ts"]);
  });

  it("commits named paths (including a brand-new file) and returns the sha", async () => {
    fs.writeFileSync(path.join(h.root, "added.txt"), "fresh\n");

    const result = await service.commit({
      projectId: h.projectId,
      message: "add a file",
      paths: ["added.txt"],
    });
    expect(result.ok).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git(["log", "-1", "--pretty=%s"]).trim()).toBe("add a file");
  });

  it("commits everything tracked when no paths are given", async () => {
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "changed\n");
    const result = await service.commit({ projectId: h.projectId, message: "commit -a" });
    expect(result.ok).toBe(true);
    const status = await service.status({ projectId: h.projectId });
    expect(status?.entries).toEqual([]);
  });
});

describe("splitUnifiedDiff", () => {
  it("returns nothing for an empty patch", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("\n  \n")).toEqual([]);
  });

  it("takes the post-image path and keeps each file's own hunk", () => {
    const patch = [
      "diff --git a/one.txt b/one.txt",
      "index 111..222 100644",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "--- a/old.txt",
      "+++ b/new.txt",
    ].join("\n");

    const diffs = splitUnifiedDiff(patch);
    expect(diffs.map((d) => d.path)).toEqual(["one.txt", "new.txt"]);
    expect(diffs[0]?.unified).toContain("+b");
    expect(diffs[1]?.unified).not.toContain("+b");
  });

  it("flags a binary file and sends no patch the renderer cannot show", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

    const [diff] = splitUnifiedDiff(patch);
    expect(diff?.path).toBe("logo.png");
    expect(diff?.binary).toBe(true);
    expect(diff?.unified).toBe("");
  });
});
