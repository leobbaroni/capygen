import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  WorktreeError,
  WorktreeService,
  parseWorktreePorcelain,
  type GitCommandRunner,
} from "../src/workspace/WorktreeService.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let home: string;
let repo: string;
let store: CapygenStore;
let projectId: string;
let fixtureEnv: Record<string, string>;

function git(cwd: string, args: string[], ok = true): string {
  const result = spawnSync("git", args, {
    cwd,
    env: fixtureEnv,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (ok && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function write(relative: string, text: string, root = repo): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function branch(name: string): void {
  git(repo, ["branch", name]);
}

function realRunner(
  inspect?: (args: string[]) => { code: number; stdout: Buffer; stderr: string } | null,
): GitCommandRunner {
  return async (args, options) => {
    const override = inspect?.(args);
    if (override) return override;
    const result = spawnSync("git", args, {
      cwd: options.cwd,
      env: options.env,
      encoding: null,
      windowsHide: options.windowsHide,
      shell: false,
    });
    if (result.error) throw result.error;
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  };
}

function service(overrides: Partial<ConstructorParameters<typeof WorktreeService>[0]> = {}): WorktreeService {
  return new WorktreeService({
    store,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    env: fixtureEnv,
    isActive: () => false,
    confirmRemove: async () => false,
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "capygen-worktrees-")));
  home = path.join(dir, "home");
  repo = path.join(dir, "source repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fixtureEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Capygen Fixture"]);
  git(repo, ["config", "user.email", "fixture@capygen.invalid"]);
  write("tracked.txt", "initial\n");
  write(".gitignore", "*.ignored\n");
  git(repo, ["add", "--", "tracked.txt", ".gitignore"]);
  git(repo, ["commit", "-m", "fixture root"]);

  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: fs.realpathSync.native(repo) }).id;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Real Git processes contend with the other desktop fixture suites during the
// full project run. Keep the timeout above Vitest's 5 s unit default so a live
// child is never abandoned into afterEach while it still owns the directory.
describe("WorktreeService Git authority", { timeout: 30_000 }, () => {
  it("creates an existing branch in a spaced Unicode path, registers it, and rediscovers it after restart", async () => {
    branch("feature/existing");
    write("source-only.txt", "uncommitted source\n");
    const destination = path.join(dir, "linked space ç");
    const created = await service().create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "existing", name: "feature/existing" },
    });

    expect(created.worktree).toMatchObject({
      path: fs.realpathSync.native(destination),
      kind: "linked",
      branch: "feature/existing",
      detached: false,
      projectId: created.project.id,
    });
    expect(fs.existsSync(path.join(destination, "source-only.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "source-only.txt"), "utf8")).toContain("uncommitted source");

    const restarted = await service().list({ sourceProjectId: projectId });
    expect(restarted).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: created.worktree.path, projectId: created.project.id }),
    ]));
  });

  it("creates a user-named branch only from a verified committed base", async () => {
    const destination = path.join(dir, "new branch");
    const created = await service().create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "new", name: "feature/new", base: "HEAD" },
    });
    expect(created.worktree.branch).toBe("feature/new");

    await expect(service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "bad base"),
      branch: { mode: "new", name: "feature/missing", base: "does-not-exist" },
    })).rejects.toMatchObject({ code: "missing-base" });
    expect(fs.existsSync(path.join(dir, "bad base"))).toBe(false);
  });

  it("registers only a Git-listed worktree and represents detached HEAD accurately", async () => {
    const detached = path.join(dir, "detached");
    git(repo, ["worktree", "add", "--detach", detached, "HEAD"]);
    const registered = await service().register({ sourceProjectId: projectId, path: detached });
    expect(registered.worktree).toMatchObject({
      path: fs.realpathSync.native(detached),
      kind: "linked",
      branch: null,
      detached: true,
      projectId: registered.project.id,
    });

    const other = path.join(dir, "other repo");
    fs.mkdirSync(other);
    git(other, ["init", "--initial-branch=main"]);
    await expect(service().register({ sourceProjectId: projectId, path: other }))
      .rejects.toMatchObject({ code: "different-repository" });
  });

  it("requires explicit confirmation before dirty, untracked or ignored content is removed", async () => {
    branch("feature/remove-dirty");
    const destination = path.join(dir, "dirty linked");
    const created = await service().create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "existing", name: "feature/remove-dirty" },
    });
    write("tracked.txt", "modified\n", destination);
    write("untracked.txt", "mine\n", destination);
    write("cache.ignored", "mine\n", destination);
    const confirm = vi.fn(async () => false);

    await expect(service({ confirmRemove: confirm }).remove({
      sourceProjectId: projectId,
      path: created.worktree.path,
    })).resolves.toEqual({ ok: false, path: created.worktree.path });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      path: created.worktree.path,
      dirty: true,
      untracked: true,
      ignored: true,
    }));
    expect(fs.readFileSync(path.join(destination, "untracked.txt"), "utf8")).toBe("mine\n");

    await expect(service({ confirmRemove: async () => true }).remove({
      sourceProjectId: projectId,
      path: created.worktree.path,
    })).resolves.toEqual({ ok: true, path: created.worktree.path });
    expect(fs.existsSync(destination)).toBe(false);
    expect(store.projects.get(created.project.id)).not.toBeNull();
  });

  it("rejects main, locked, different-repository and active-session removal", async () => {
    await expect(service().remove({ sourceProjectId: projectId, path: repo }))
      .rejects.toMatchObject({ code: "main-worktree" });

    branch("feature/locked");
    const locked = await service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "locked"),
      branch: { mode: "existing", name: "feature/locked" },
    });
    git(repo, ["worktree", "lock", "--reason", "fixture lock", locked.worktree.path]);
    await expect(service().remove({ sourceProjectId: projectId, path: locked.worktree.path }))
      .rejects.toMatchObject({ code: "locked" });

    const other = path.join(dir, "other removal repo");
    fs.mkdirSync(other);
    git(other, ["init", "--initial-branch=main"]);
    await expect(service().remove({ sourceProjectId: projectId, path: other }))
      .rejects.toMatchObject({ code: "different-repository" });

    branch("feature/active");
    const active = await service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "active"),
      branch: { mode: "existing", name: "feature/active" },
    });
    const session = store.sessions.create({
      projectId: active.project.id,
      mode: "solo",
      agents: [{ name: "capy", backend: "codex", model: "fixture", role: "lead", config: null }],
    }).session;
    store.sessions.setStatus(session.id, "running");
    store.sessions.setArchived(session.id, true);
    await expect(service().remove({ sourceProjectId: projectId, path: active.worktree.path }))
      .rejects.toMatchObject({ code: "active-session" });
    expect(fs.existsSync(active.worktree.path)).toBe(true);
  });

  it("distinguishes invalid branches, occupied branches, missing Git and unborn HEAD", async () => {
    await expect(service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "invalid"),
      branch: { mode: "new", name: "-invalid", base: "HEAD" },
    })).rejects.toMatchObject({ code: "invalid-branch" });
    git(repo, ["checkout", "-b", "previous"]);
    git(repo, ["checkout", "main"]);
    await expect(service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "history expression"),
      branch: { mode: "existing", name: "@{-1}" },
    })).rejects.toMatchObject({ code: "invalid-branch" });
    await expect(service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "occupied"),
      branch: { mode: "existing", name: "main" },
    })).rejects.toMatchObject({ code: "occupied-branch" });
    await expect(service().create({
      sourceProjectId: projectId,
      destinationPath: path.join(dir, "missing branch"),
      branch: { mode: "existing", name: "feature/not-created" },
    })).rejects.toMatchObject({ code: "missing-branch" });

    const missingGit: GitCommandRunner = async () => {
      const error = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      throw error;
    };
    await expect(service({ runGit: missingGit }).list({ sourceProjectId: projectId }))
      .rejects.toMatchObject({ code: "missing-git" });

    const empty = path.join(dir, "unborn");
    fs.mkdirSync(empty);
    git(empty, ["init", "--initial-branch=main"]);
    const emptyProject = store.projects.upsertByPath({ path: fs.realpathSync.native(empty) });
    await expect(service().create({
      sourceProjectId: emptyProject.id,
      destinationPath: path.join(dir, "from unborn"),
      branch: { mode: "new", name: "feature/empty", base: "HEAD" },
    })).rejects.toMatchObject({ code: "unborn-head" });
  });

  it("does not retry a clean removal with force after Git refuses it", async () => {
    branch("feature/no-retry");
    const destination = path.join(dir, "no retry");
    const normal = service();
    const created = await normal.create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "existing", name: "feature/no-retry" },
    });
    const removes: string[][] = [];
    const runGit = realRunner((args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removes.push([...args]);
        return { code: 1, stdout: Buffer.alloc(0), stderr: "fixture refusal" };
      }
      return null;
    });

    await expect(service({ runGit }).remove({
      sourceProjectId: projectId,
      path: created.worktree.path,
    })).rejects.toMatchObject({ code: "access-failure" });
    expect(removes).toEqual([["worktree", "remove", "--", created.worktree.path]]);
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("rechecks active use after the destructive native confirmation returns", async () => {
    branch("feature/confirmation-race");
    const destination = path.join(dir, "confirmation race");
    const created = await service().create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "existing", name: "feature/confirmation-race" },
    });
    write("new.txt", "must survive\n", destination);
    let active = false;
    const confirmRemoval = vi.fn(async () => {
      active = true;
      return true;
    });

    await expect(service({
      isActive: () => active,
      confirmRemove: confirmRemoval,
    }).remove({
      sourceProjectId: projectId,
      path: created.worktree.path,
    })).rejects.toMatchObject({ code: "active-session" });
    expect(confirmRemoval).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(destination, "new.txt"), "utf8")).toBe("must survive\n");
  });

  it("canonicalizes a destination through an existing directory alias", async () => {
    branch("feature/alias");
    const actualParent = path.join(dir, "actual parent");
    const aliasParent = path.join(dir, "parent alias");
    fs.mkdirSync(actualParent);
    fs.symlinkSync(actualParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const destination = path.join(aliasParent, "linked");

    const created = await service().create({
      sourceProjectId: projectId,
      destinationPath: destination,
      branch: { mode: "existing", name: "feature/alias" },
    });
    expect(created.worktree.path).toBe(fs.realpathSync.native(path.join(actualParent, "linked")));
    expect(created.project.path).toBe(created.worktree.path);
  });

  it("reports a surviving directory and branch after a partial Git create failure", async () => {
    branch("feature/partial");
    const destination = path.join(dir, "partial survives");
    let intercepted = false;
    const runGit: GitCommandRunner = async (args, options) => {
      const result = await realRunner()(args, options);
      if (!intercepted && args[0] === "worktree" && args[1] === "add") {
        intercepted = true;
        return { ...result, code: 1, stderr: "fixture post-create failure" };
      }
      return result;
    };

    let failure: unknown;
    try {
      await service({ runGit }).create({
        sourceProjectId: projectId,
        destinationPath: destination,
        branch: { mode: "existing", name: "feature/partial" },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "access-failure",
      survivingPath: fs.realpathSync.native(destination),
      survivingBranch: "feature/partial",
    });
    expect(store.projects.getByPath(fs.realpathSync.native(destination))).toBeNull();
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("refuses to register a prunable path or a path swapped to another repository", async () => {
    const stale = path.join(dir, "stale linked");
    git(repo, ["worktree", "add", "--detach", stale, "HEAD"]);
    fs.rmSync(stale, { recursive: true, force: true });
    await expect(service().register({ sourceProjectId: projectId, path: stale }))
      .rejects.toMatchObject({ code: "not-worktree" });
    expect(store.projects.getByPath(stale)).toBeNull();

    const swapped = path.join(dir, "swapped linked");
    const original = path.join(dir, "swapped original");
    git(repo, ["worktree", "add", "--detach", swapped, "HEAD"]);
    fs.renameSync(swapped, original);
    fs.mkdirSync(swapped);
    git(swapped, ["init", "--initial-branch=main"]);
    await expect(service().register({ sourceProjectId: projectId, path: swapped }))
      .rejects.toMatchObject({ code: "different-repository" });
    expect(store.projects.getByPath(fs.realpathSync.native(swapped))).toBeNull();
  });
});

describe("worktree porcelain and spawn boundaries", () => {
  it("parses NUL-delimited paths and reasons without splitting spaces or Unicode", () => {
    const parsed = parseWorktreePorcelain(Buffer.from(
      `worktree C:/repo main\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0` +
      `worktree C:/répo linked\0HEAD ${"b".repeat(40)}\0detached\0locked portable disk\0prunable gitdir missing\0\0`,
    ));
    expect(parsed).toEqual([
      expect.objectContaining({ path: "C:/repo main", branch: "main", detached: false }),
      expect.objectContaining({
        path: "C:/répo linked",
        branch: null,
        detached: true,
        locked: true,
        lockReason: "portable disk",
        prunable: true,
        pruneReason: "gitdir missing",
      }),
    ]);
  });

  it("passes argument arrays through a hidden cleaned child boundary", async () => {
    const calls: Array<{ args: string[]; options: { cwd: string; env: Record<string, string>; windowsHide: true } }> = [];
    const runGit: GitCommandRunner = async (args, options) => {
      calls.push({ args, options });
      if (args.includes("--is-inside-work-tree")) {
        return { code: 0, stdout: Buffer.from("true\n"), stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: Buffer.from(`${repo}\n`), stderr: "" };
      }
      return {
        code: 0,
        stdout: Buffer.from(`worktree ${repo}\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`),
        stderr: "",
      };
    };
    await service({ runGit, env: { PATH: "fixture", GIT_DIR: "hostile", CLAUDECODE: "nested" } })
      .list({ sourceProjectId: projectId });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => Array.isArray(call.args) && call.options.windowsHide)).toBe(true);
    expect(calls.every((call) => call.options.env.GIT_DIR === undefined)).toBe(true);
    expect(calls.every((call) => call.options.env.CLAUDECODE === undefined)).toBe(true);
  });
});
