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
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitChildEnv, GitService, splitUnifiedDiff } from "../src/workspace/GitService.js";
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
let gitHome: string;
let gitEnv: Record<string, string>;

function isolatedGitEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || key.toUpperCase().startsWith("GIT_")) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  return env;
}

function git(args: string[], cwd = h.root): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", windowsHide: true });
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-git-" });
  gitHome = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-git-home-"));
  fs.mkdirSync(path.join(gitHome, ".config"), { recursive: true });
  gitEnv = isolatedGitEnv(gitHome);
  service = new GitService({
    store: h.store,
    log: h.log,
    createClient: async (root: string) => {
      const mod = await import("simple-git");
      const client = (mod.simpleGit as unknown as (options: { baseDir: string; config: string[] }) => {
        env: (env: Record<string, string>) => unknown;
      })({ baseDir: root, config: ["core.quotepath=false"] });
      client.env(gitChildEnv(gitEnv));
      return client as never;
    },
  });
});

afterEach(() => {
  h.close();
  fs.rmSync(gitHome, { recursive: true, force: true });
});

describe("git.status", () => {
  it("answers null for a folder that is not a repository — not an error", async () => {
    seed(h.root, { "a.txt": "hello\n" });
    await expect(service.status({ projectId: h.projectId })).resolves.toBeNull();
  });

  it("answers [] from git.diff on a non-repo too", async () => {
    await expect(service.diff({ projectId: h.projectId, staged: false })).resolves.toEqual([]);
  });

  it("refuses to commit into a non-repo, loudly", async () => {
    // A nonempty selection, so this reaches the repository check rather than
    // the selection check that now runs first.
    await expect(
      service.commit({ projectId: h.projectId, message: "nope", paths: ["tracked.txt"] }),
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

  it("refuses a missing selection instead of committing the whole tree", async () => {
    // This used to run `git commit --all`, so a dropped `paths` field turned
    // "commit nothing" into "commit everything the user had open".
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "changed\n");
    await expect(
      service.commit({ projectId: h.projectId, message: "commit -a" }),
    ).rejects.toThrow(/non-empty selection/);
    const status = await service.status({ projectId: h.projectId });
    expect(status?.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
  });

  it("commits only the named path, leaving other changes alone", async () => {
    fs.writeFileSync(path.join(h.root, "tracked.txt"), "changed\n");
    fs.writeFileSync(path.join(h.root, "src", "app.ts"), "export const a = 2;\n");
    const result = await service.commit({
      projectId: h.projectId,
      message: "one path",
      paths: ["tracked.txt"],
    });
    expect(result.ok).toBe(true);
    const status = await service.status({ projectId: h.projectId });
    expect(status?.entries.map((entry) => entry.path)).toEqual(["src/app.ts"]);
  });
});

/**
 * simple-git appends `files` to the argv verbatim (`addTask` → `["add",
 * ...files]`, `commitTask` → `[…, "commit", "-m", msg, ...files]`), so
 * without a `--` a path beginning with `-` is parsed by git as an option:
 * `paths: ["-p"]` becomes `git add -p`, which waits on stdin forever. The
 * fake client here is the only way to assert on the argv git would receive.
 */
describe("git.commit argv", () => {
  it("separates pathspecs from options with --", async () => {
    const addCalls: string[][] = [];
    const commitCalls: unknown[][] = [];
    const fakeService = new GitService({
      store: h.store,
      log: h.log,
      createClient: () => ({
        checkIsRepo: async () => true,
        status: async () => ({
          files: [
            { path: "-p", index: " ", working_dir: "M" },
            { path: "src/app.ts", index: " ", working_dir: "M" },
          ],
          current: "main",
          ahead: 0,
          behind: 0,
        }),
        diff: async () => "",
        add: async (files: string[]) => void addCalls.push(files),
        commit: async (
          message: string,
          files?: string[],
          options?: Record<string, null>,
        ) => void commitCalls.push([message, files, options]),
        // Different before/after, so the commit is not read as a no-op.
        revparse: (() => {
          let call = 0;
          return async () => (call++ === 0 ? "0".repeat(40) : "1".repeat(40));
        })(),
      }),
    });

    await fakeService.commit({
      projectId: h.projectId,
      message: "one",
      paths: ["-p", "src/app.ts"],
    });

    // A file really named `-p` is a path, not an option — `--` is what keeps
    // `git add -p` (which waits on stdin forever) from being the command.
    expect(addCalls).toEqual([["--", "-p", "src/app.ts"]]);
    expect(commitCalls[0]).toEqual(["one", ["--", "-p", "src/app.ts"], undefined]);
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
