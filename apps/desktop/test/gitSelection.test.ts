/**
 * Explicit commit selection, against **real** temporary Git repositories.
 *
 * A fake client can prove which argv `GitService` builds; only real `git` can
 * prove what that argv does to an index. The whole promise of the Diff pane's
 * checkboxes — "commit these, leave everything else exactly as it is" — is a
 * claim about git's partial-commit behaviour, so it is asserted against git.
 *
 * **Isolation.** Every repository gets its own `HOME`, `XDG_CONFIG_HOME`,
 * system config off and a fixture identity, with every inherited `GIT_*`
 * scrubbed first (`gitEnv`). No test here reads or writes the developer's
 * `~/.gitconfig`, and a machine-level `core.autocrlf`, `commit.gpgsign` or
 * hook path cannot change an outcome. Nothing spawns a model.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  GitSelectionError,
  GitService,
  assertSelectionShape,
  gitChildEnv,
  resolveCommitPathspecs,
} from "../src/workspace/GitService.js";

const created: string[] = [];
afterAll(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const LOG = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * A git environment that cannot see the developer's configuration.
 *
 * Order matters: inherited `GIT_*` routing/config is scrubbed **first**, then
 * the isolated homes, system-off switch and fixture identity are applied — so
 * an inherited `GIT_DIR` or `GIT_AUTHOR_NAME` can never outrank them. This
 * env is used by the verification `execFile` calls too, not only by the
 * service under test.
 *
 * `identityFromEnv: false` drops the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` pair so
 * a test can prove git read the *isolated HOME's* config — those variables
 * outrank config and would mask it.
 */
function gitEnv(home: string, identityFromEnv = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Every GIT_* the parent might carry: routing (GIT_DIR, GIT_WORK_TREE, …)
    // and config (GIT_CONFIG*, GIT_AUTHOR_*, …). Dropping the whole prefix is
    // simpler than a list and cannot miss one.
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
  if (identityFromEnv) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: "capygen fixture",
      GIT_AUTHOR_EMAIL: "fixture@capygen.invalid",
      GIT_COMMITTER_NAME: "capygen fixture",
      GIT_COMMITTER_EMAIL: "fixture@capygen.invalid",
    });
  }
  return env;
}

interface Repo {
  root: string;
  /** The isolated HOME this repo's git reads its global config from. */
  home: string;
  git: (...args: string[]) => string;
  service: GitService;
  write: (rel: string, text: string) => void;
  /** `git status --porcelain -z`, split — the ground truth for "what changed". */
  porcelain: () => string[];
  head: () => string;
  /** Paths in the commit `sha` touches, relative to its parent. */
  committedPaths: (sha: string) => string[];
}

function makeRepo(tag: string, identityFromEnv = true): Repo {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-githome-${tag}-`));
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `capygen-gitrepo-${tag}-`)),
  );
  created.push(home, root);
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  const env = gitEnv(home, identityFromEnv);

  // `-c core.quotepath=false` on the *verification* git too. Without it git
  // octal-escapes every non-ASCII byte (`"\346\227\245…"`), so a Unicode
  // path would fail the comparison even though the commit was correct — which
  // is precisely why `GitService`'s own client sets the same switch.
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
    });

  git("init", "--initial-branch=main");
  git("config", "user.name", "capygen fixture");
  git("config", "user.email", "fixture@capygen.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");

  const write = (rel: string, text: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
  };

  const store = {
    projects: { get: (id: string) => (id === "p1" ? { id, path: root } : null) },
  } as never;
  // The real `simple-git` client, built by `GitService`'s own factory — the
  // env/config hardening under test is inside it — but pointed at this repo's
  // isolated HOME.
  const service = new GitService({
    store,
    log: LOG,
    createClient: async (base: string) => {
      const mod = await import("simple-git");
      const factory = (
        mod as unknown as {
          simpleGit: (o: { baseDir: string; config: string[] }) => Record<string, unknown>;
        }
      ).simpleGit;
      const client = factory({ baseDir: base, config: ["core.quotepath=false"] }) as {
        env(e: Record<string, string>): unknown;
      };
      // `gitChildEnv` is the product's own hardening; the test only supplies a
      // different *base* (the isolated HOME), so what runs here is what ships.
      client.env(gitChildEnv(env));
      return client as never;
    },
  });

  return {
    root,
    home,
    git,
    service,
    write,
    porcelain: () =>
      git("status", "--porcelain", "-z").split("\0").filter((line) => line.length > 0),
    head: () => git("rev-parse", "HEAD").trim(),
    committedPaths: (sha: string) =>
      git("show", "--name-only", "--pretty=format:", "--no-renames", sha)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .sort(),
  };
}

/** A repo with one commit already in it, so HEAD exists. */
function seeded(tag: string): Repo {
  const repo = makeRepo(tag);
  repo.write("README.md", "# fixture\n");
  repo.git("add", "README.md");
  repo.git("commit", "-m", "initial");
  return repo;
}

// ---------------------------------------------------------------------------
// refusals — no repository needed
// ---------------------------------------------------------------------------

describe("assertSelectionShape", () => {
  it("refuses a missing or empty selection instead of committing everything", () => {
    for (const selection of [undefined, []]) {
      expect(() => assertSelectionShape(selection)).toThrow(GitSelectionError);
      expect(() => assertSelectionShape(selection)).toThrow(/non-empty selection/);
    }
  });

  it("refuses pathspec magic, the one input that can widen a commit", () => {
    for (const spec of [":(exclude)src", ":!src", ":/", ":(top)", ":(glob)**/*.ts"]) {
      expect(() => assertSelectionShape([spec]), spec).toThrow(/pathspec, not a path/);
    }
  });

  it("refuses a NUL byte and an empty string", () => {
    expect(() => assertSelectionShape(["src/a.ts\u0000b"])).toThrow(/NUL/);
    expect(() => assertSelectionShape([""])).toThrow(/empty path/);
  });

  it("refuses absolute, drive-relative, UNC and ..-escaping paths by name", () => {
    for (const bad of [
      "/etc/passwd",
      "/outside/file",
      "C:/Windows/System32/x",
      "C:relative",
      "\\\\server\\share\\x",
      "\\outside",
      "../secrets.txt",
      "src/../../etc/passwd",
    ]) {
      expect(() => assertSelectionShape([bad]), bad).toThrow(/project-relative/);
    }
  });

  it("preserves bytes exactly — no trimming, no separator rewriting", () => {
    // ` file` and `file` are different names; turning one into the other would
    // commit a file the user did not select.
    const exact = [" leading space.txt", "trailing space .txt", "-hyphen.txt", "a -> b"];
    expect(assertSelectionShape(exact)).toEqual(exact);
  });
});

describe("resolveCommitPathspecs", () => {
  const changed = [
    { path: "src/a.ts", index: " ", working_dir: "M" },
    { path: "a -> b", index: "?", working_dir: "?" },
    { path: "A.txt", index: "?", working_dir: "?" },
    { path: "a.txt", index: "?", working_dir: "?" },
    { path: "new name.txt", index: "R", working_dir: " ", from: "old name.txt" },
  ];

  it("passes an exact changed file straight through", () => {
    expect(resolveCommitPathspecs(["src/a.ts"], changed)).toEqual({
      add: ["src/a.ts"],
      commit: ["src/a.ts"],
    });
  });

  it("treats a file literally named 'a -> b' as one path, never two", () => {
    expect(resolveCommitPathspecs(["a -> b"], changed)).toEqual({
      add: ["a -> b"],
      commit: ["a -> b"],
    });
  });

  it("names a reported rename's original at commit time but never adds it", () => {
    // The old name is already staged and gone from the worktree, so `git add`
    // would fail on it; it still has to be committed to record the deletion.
    expect(resolveCommitPathspecs(["new name.txt"], changed)).toEqual({
      add: ["new name.txt"],
      commit: ["new name.txt", "old name.txt"],
    });
  });

  it("never pulls in a copy's source — only a rename's original", () => {
    // `C` means git found a similar file, not that it moved. The source may
    // have its own unchecked changes, so committing it would be committing a
    // file the user did not select.
    const withCopy = [
      { path: "copy.txt", index: "C", working_dir: " ", from: "source.txt" },
      { path: "moved.txt", index: "R", working_dir: " ", from: "was.txt" },
    ];
    expect(resolveCommitPathspecs(["copy.txt"], withCopy)).toEqual({
      add: ["copy.txt"],
      commit: ["copy.txt"],
    });
    expect(resolveCommitPathspecs(["moved.txt"], withCopy).commit).toEqual([
      "moved.txt",
      "was.txt",
    ]);
  });

  it("does not stage an already-staged deletion, but still commits it", () => {
    const staged = [
      { path: "gone.txt", index: "D", working_dir: " " },
      { path: "kept.txt", index: " ", working_dir: "D" },
    ];
    // `D ` is absent from index and worktree: `git add` on it fails.
    expect(resolveCommitPathspecs(["gone.txt"], staged)).toEqual({
      add: [],
      commit: ["gone.txt"],
    });
    // ` D` is an unstaged deletion of a tracked file; `git add` records it.
    expect(resolveCommitPathspecs(["kept.txt"], staged)).toEqual({
      add: ["kept.txt"],
      commit: ["kept.txt"],
    });
  });

  it("keeps case-distinct paths distinct", () => {
    expect(resolveCommitPathspecs(["A.txt", "a.txt"], changed).commit).toEqual([
      "A.txt",
      "a.txt",
    ]);
  });

  it("de-duplicates an exactly repeated path", () => {
    expect(resolveCommitPathspecs(["src/a.ts", "src/a.ts"], changed)).toEqual({
      add: ["src/a.ts"],
      commit: ["src/a.ts"],
    });
  });

  it("refuses a directory, a path prefix and a stale path", () => {
    for (const notAnEntry of ["src", "src/", "src/a", "gone.ts", ""]) {
      expect(() => resolveCommitPathspecs([notAnEntry], changed), notAnEntry).toThrow(
        /not one of the\s+changed files/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// real repositories
// ---------------------------------------------------------------------------

describe("GitService.commit against a real repository", () => {
  it("commits only the selected path, leaving unrelated staged AND unstaged work alone", async () => {
    const repo = seeded("only");
    repo.write("selected.txt", "selected\n");
    repo.write("staged-elsewhere.txt", "staged\n");
    repo.write("unstaged.txt", "unstaged\n");
    repo.git("add", "staged-elsewhere.txt");
    // README is modified in the working tree and not staged.
    repo.write("README.md", "# fixture\nedited\n");

    const before = repo.head();
    const result = await repo.service.commit({
      projectId: "p1",
      message: "only the selection",
      paths: ["selected.txt"],
    });

    expect(result.ok).toBe(true);
    expect(result.sha).not.toBe(before);
    expect(repo.committedPaths(result.sha!)).toEqual(["selected.txt"]);

    // The other three are exactly as the user left them.
    const status = repo.porcelain().map((line) => `${line.slice(0, 2)} ${line.slice(2).trim()}`);
    expect(status).toEqual(
      expect.arrayContaining(["A  staged-elsewhere.txt", "?? unstaged.txt", " M README.md"]),
    );
    expect(status.some((l) => l.includes("selected.txt"))).toBe(false);
  });

  it("refuses an empty selection without touching the repository", async () => {
    const repo = seeded("empty");
    repo.write("a.txt", "a\n");
    const before = repo.head();
    const statusBefore = repo.porcelain();

    await expect(
      repo.service.commit({ projectId: "p1", message: "nope", paths: [] }),
    ).rejects.toThrow(/non-empty selection/);
    await expect(
      repo.service.commit({ projectId: "p1", message: "nope" }),
    ).rejects.toThrow(GitSelectionError);

    expect(repo.head()).toBe(before);
    expect(repo.porcelain()).toEqual(statusBefore);
  });

  it("commits paths with spaces and non-ASCII names", async () => {
    const repo = seeded("unicode");
    repo.write("a folder/mon fichier é.txt", "accents\n");
    repo.write("日本語/ファイル.txt", "japanese\n");
    repo.write("untouched.txt", "untouched\n");

    const result = await repo.service.commit({
      projectId: "p1",
      message: "unicode",
      paths: ["a folder/mon fichier é.txt", "日本語/ファイル.txt"],
    });
    // Compared NFC-normalised: the filesystem may hand back NFD on some
    // platforms, and the point of the test is the round trip, not the form.
    expect(repo.committedPaths(result.sha!).map((p) => p.normalize("NFC")).sort()).toEqual(
      ["a folder/mon fichier é.txt", "日本語/ファイル.txt"].map((p) => p.normalize("NFC")).sort(),
    );
    expect(repo.porcelain().join("\n")).toContain("untouched.txt");
  });

  it("treats a leading-hyphen file name as a file, not an option", async () => {
    const repo = seeded("hyphen");
    repo.write("-oops.txt", "hyphen\n");
    repo.write("other.txt", "other\n");

    const result = await repo.service.commit({
      projectId: "p1",
      message: "hyphen",
      paths: ["-oops.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["-oops.txt"]);
    expect(repo.porcelain().join("\n")).toContain("other.txt");
  });

  it("cannot be widened by a hostile pathspec", async () => {
    const repo = seeded("hostile");
    repo.write("wanted.txt", "wanted\n");
    repo.write("secret.txt", "secret\n");

    await expect(
      repo.service.commit({
        projectId: "p1",
        message: "hostile",
        paths: [":(exclude)nothing", "wanted.txt"],
      }),
    ).rejects.toThrow(/pathspec, not a path/);
    // Refused before any git ran: both files are still uncommitted.
    expect(repo.porcelain().join("\n")).toContain("secret.txt");
    expect(repo.porcelain().join("\n")).toContain("wanted.txt");
  });

  it("commits a deletion when the deleted path is selected", async () => {
    const repo = seeded("delete");
    repo.write("doomed.txt", "doomed\n");
    repo.write("keep.txt", "keep\n");
    repo.git("add", "doomed.txt", "keep.txt");
    repo.git("commit", "-m", "add two");

    fs.rmSync(path.join(repo.root, "doomed.txt"));
    fs.rmSync(path.join(repo.root, "keep.txt"));

    const result = await repo.service.commit({
      projectId: "p1",
      message: "delete one",
      paths: ["doomed.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["doomed.txt"]);
    // The other deletion is still just a working-tree change.
    expect(repo.porcelain().join("\n")).toContain("keep.txt");
    expect(
      repo.git("ls-tree", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean).sort(),
    ).toEqual(["README.md", "keep.txt"]);
  });

  it("commits both halves of a rename git reports as one entry", async () => {
    const repo = seeded("rename");
    repo.write("old name.txt", "same bytes\n");
    repo.git("add", "old name.txt");
    repo.git("commit", "-m", "add old");

    fs.renameSync(path.join(repo.root, "old name.txt"), path.join(repo.root, "new name.txt"));
    // Staged, which is when git reports `R` with a `from` field — the only
    // source this code takes a rename pair from.
    repo.git("add", "--", "old name.txt", "new name.txt");

    const result = await repo.service.commit({
      projectId: "p1",
      message: "rename",
      paths: ["new name.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["new name.txt", "old name.txt"]);
    expect(
      repo.git("ls-tree", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean).sort(),
    ).toEqual(["README.md", "new name.txt"]);
  });

  it("commits an unstaged rename when both of its two entries are selected", async () => {
    const repo = seeded("rename-unstaged");
    repo.write("before.txt", "same bytes\n");
    repo.git("add", "before.txt");
    repo.git("commit", "-m", "add before");

    fs.renameSync(path.join(repo.root, "before.txt"), path.join(repo.root, "after.txt"));
    // Before staging git sees a deletion and an untracked file, not a rename,
    // so the pane shows two rows and both must be selected.
    const status = await repo.service.status({ projectId: "p1" });
    expect(status!.entries.map((e) => e.path).sort()).toEqual(["after.txt", "before.txt"]);

    const result = await repo.service.commit({
      projectId: "p1",
      message: "unstaged rename",
      paths: ["before.txt", "after.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["after.txt", "before.txt"]);
  });

  it("refuses a directory selection instead of committing everything under it", async () => {
    const repo = seeded("dir");
    repo.write("newdir/a.txt", "a\n");
    repo.write("newdir/sub/b.txt", "b\n");

    // git's own porcelain summarises an untracked tree as `newdir/`; the
    // service must enumerate the individual files instead.
    const status = await repo.service.status({ projectId: "p1" });
    expect(status!.entries.map((e) => e.path).sort()).toEqual([
      "newdir/a.txt",
      "newdir/sub/b.txt",
    ]);

    for (const dir of ["newdir", "newdir/"]) {
      await expect(
        repo.service.commit({ projectId: "p1", message: "dir", paths: [dir] }),
      ).rejects.toThrow(/not one of the/);
    }
    // Selecting one real file commits only that one.
    const result = await repo.service.commit({
      projectId: "p1",
      message: "one file",
      paths: ["newdir/a.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["newdir/a.txt"]);
  });

  it("commits an already-staged deletion, which cannot be re-added", async () => {
    const repo = seeded("staged-delete");
    repo.write("doomed.txt", "doomed\n");
    repo.write("staged-elsewhere.txt", "staged\n");
    repo.git("add", "doomed.txt");
    repo.git("commit", "-m", "add doomed");

    // `git rm` stages the deletion: the path is in neither the worktree nor
    // the index, so `git add -- doomed.txt` fails pathspec-not-found.
    repo.git("rm", "--", "doomed.txt");
    repo.write("unrelated.txt", "unrelated\n");
    repo.git("add", "staged-elsewhere.txt");

    const entry = (await repo.service.status({ projectId: "p1" }))!.entries.find(
      (e) => e.path === "doomed.txt",
    );
    expect(entry?.status).toBe("D");

    const result = await repo.service.commit({
      projectId: "p1",
      message: "commit the staged deletion",
      paths: ["doomed.txt"],
    });
    expect(repo.committedPaths(result.sha!)).toEqual(["doomed.txt"]);
    expect(
      repo.git("ls-tree", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean).sort(),
    ).toEqual(["README.md"]);

    // The unrelated staged file is still staged, and still uncommitted.
    const status = repo.porcelain().map((line) => `${line.slice(0, 2)} ${line.slice(2).trim()}`);
    expect(status).toEqual(
      expect.arrayContaining(["A  staged-elsewhere.txt", "?? unrelated.txt"]),
    );
  });

  it("does not commit a copy's source, whose own changes were not selected", async () => {
    const repo = seeded("copy");
    repo.write("source.txt", "aaa\nbbb\nccc\nddd\n");
    repo.git("add", "source.txt");
    repo.git("commit", "-m", "add source");

    // Copy detection is off by default; ask for it explicitly.
    repo.git("config", "status.renames", "copies");
    repo.write("copy.txt", "aaa\nbbb\nccc\nddd\n");
    repo.write("source.txt", "aaa\nbbb\nccc\nddd\nsource changed\n");
    repo.git("add", "--", "copy.txt", "source.txt");

    const entries = (await repo.service.status({ projectId: "p1" }))!.entries;
    const copy = entries.find((e) => e.path === "copy.txt");
    // Git only reports `C` when it chooses to; when it reports `A` instead the
    // resolver unit test above is the coverage for the `C` branch.
    const result = await repo.service.commit({
      projectId: "p1",
      message: "copy only",
      paths: ["copy.txt"],
    });
    expect(copy?.status === "C" || copy?.status === "A").toBe(true);
    expect(repo.committedPaths(result.sha!)).toEqual(["copy.txt"]);
    // The source's own staged change is untouched either way.
    expect(repo.porcelain().join("\n")).toContain("source.txt");
  });

  it("refuses a stale path that is no longer changed", async () => {
    const repo = seeded("stale");
    repo.write("gone.txt", "gone\n");
    repo.git("add", "gone.txt");
    repo.git("commit", "-m", "already committed");

    await expect(
      repo.service.commit({ projectId: "p1", message: "stale", paths: ["gone.txt"] }),
    ).rejects.toThrow(/refresh the pane/);
  });

  it("surfaces a failing pre-commit hook and never reports a commit that did not happen", async () => {
    const repo = seeded("hook");
    const hooks = path.join(repo.root, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    // `sh` is what git runs hooks with on Windows too (Git for Windows ships it).
    fs.writeFileSync(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\necho 'capygen fixture hook says no' >&2\nexit 1\n",
      "utf8",
    );
    fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);

    repo.write("blocked.txt", "blocked\n");
    const before = repo.head();

    await expect(
      repo.service.commit({ projectId: "p1", message: "blocked", paths: ["blocked.txt"] }),
    ).rejects.toThrow();
    // HEAD did not move, and — crucially — the user's work was not discarded by
    // a rollback: the file is still there and still staged by the `add`.
    expect(repo.head()).toBe(before);
    expect(fs.existsSync(path.join(repo.root, "blocked.txt"))).toBe(true);
    expect(repo.porcelain().join("\n")).toContain("blocked.txt");
  });

  it("commits into a repository that has no commits yet", async () => {
    const repo = makeRepo("unborn");
    repo.write("first.txt", "first\n");
    repo.write("second.txt", "second\n");

    const result = await repo.service.commit({
      projectId: "p1",
      message: "first commit",
      paths: ["first.txt"],
    });
    expect(result.ok).toBe(true);
    expect(repo.committedPaths(result.sha!)).toEqual(["first.txt"]);
    expect(repo.porcelain().join("\n")).toContain("second.txt");
  });
});

// ---------------------------------------------------------------------------
// the child environment
// ---------------------------------------------------------------------------

describe("gitChildEnv", () => {
  it("scrubs repository redirection so an explicit project cannot be diverted", () => {
    // capygen launched from inside a hook or a rebase inherits these pointing
    // at *that* repository; the explicit baseDir must be the only decider.
    const env = gitChildEnv({
      GIT_DIR: "C:/elsewhere/.git",
      GIT_WORK_TREE: "C:/elsewhere",
      GIT_INDEX_FILE: "C:/elsewhere/.git/index",
      GIT_COMMON_DIR: "C:/elsewhere/.git",
      GIT_OBJECT_DIRECTORY: "C:/elsewhere/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "C:/elsewhere/objects",
      GIT_NAMESPACE: "refs/other",
      GIT_CEILING_DIRECTORIES: "C:/",
      GIT_PREFIX: "sub/",
      GIT_INDEX_VERSION: "4",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      PATH: "C:/bin",
    });
    for (const key of Object.keys(env)) {
      expect(key === "PATH" || key === "GIT_LITERAL_PATHSPECS", key).toBe(true);
    }
    expect(env.GIT_LITERAL_PATHSPECS).toBe("1");
  });

  it("scrubs case-insensitively, the way Windows resolves variables", () => {
    const env = gitChildEnv({ git_dir: "C:/elsewhere/.git", Git_Work_Tree: "C:/elsewhere" });
    expect(Object.keys(env)).toEqual(["GIT_LITERAL_PATHSPECS"]);
  });

  it("scrubs the variables simple-git itself refuses, so a repo is not misread as a non-repo", () => {
    const env = gitChildEnv({ EDITOR: "vim", PAGER: "less", PREFIX: "/usr/local" });
    expect(Object.keys(env)).toEqual(["GIT_LITERAL_PATHSPECS"]);
  });

  it("keeps the variables that point git at an isolated configuration", () => {
    // The whole test suite's isolation rests on these surviving.
    const env = gitChildEnv({
      HOME: "/iso/home",
      USERPROFILE: "C:/iso/home",
      XDG_CONFIG_HOME: "/iso/home/.config",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env.HOME).toBe("/iso/home");
    expect(env.USERPROFILE).toBe("C:/iso/home");
    expect(env.XDG_CONFIG_HOME).toBe("/iso/home/.config");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("isolation survives the scrub, against real git", () => {
  it("reads identity from the isolated HOME, not the developer's", async () => {
    // No GIT_AUTHOR_*/GIT_COMMITTER_* in the environment and no repo-local
    // identity, so the only place git can find one is the isolated HOME —
    // which is exactly what `gitChildEnv` has to preserve.
    const repo = makeRepo("isohome", false);
    fs.writeFileSync(
      path.join(repo.home, ".gitconfig"),
      "[user]\n\tname = isolated home identity\n\temail = isolated@capygen.invalid\n",
      "utf8",
    );
    repo.git("config", "--unset", "user.name");
    repo.git("config", "--unset", "user.email");

    repo.write("who.txt", "who\n");
    const result = await repo.service.commit({
      projectId: "p1",
      message: "identity",
      paths: ["who.txt"],
      });
    const author = repo
      .git("show", "--no-patch", "--format=%an <%ae>", result.sha!)
      .trim();
    expect(author).toBe("isolated home identity <isolated@capygen.invalid>");
  });

  it("commits into the project repository even when GIT_DIR points elsewhere", async () => {
    const repo = seeded("redirect");
    const decoy = seeded("decoy");
    const decoyHead = decoy.head();

    repo.write("target.txt", "target\n");
    // The service's own client factory builds the environment; this proves the
    // scrub by putting the redirection into the *inherited* environment.
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(decoy.root, ".git");
    try {
      const result = await repo.service.commit({
        projectId: "p1",
        message: "not the decoy",
        paths: ["target.txt"],
      });
      expect(repo.committedPaths(result.sha!)).toEqual(["target.txt"]);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    // The decoy repository is untouched.
    expect(decoy.head()).toBe(decoyHead);
  });
});

// ---------------------------------------------------------------------------
// what a post-commit HEAD lookup failure is allowed to claim
// ---------------------------------------------------------------------------

describe("commit result reporting", () => {
  /** A client whose `commit` succeeds and whose `revparse` behaves as scripted. */
  function stub(revparse: (call: number) => Promise<string>): {
    service: GitService;
    calls: { add: string[][]; commit: string[][] };
  } {
    const calls = { add: [] as string[][], commit: [] as string[][] };
    let seen = 0;
    const client = {
      checkIsRepo: async () => true,
      status: async () => ({ files: [{ path: "a.txt", index: "?", working_dir: "?" }] }),
      diff: async () => "",
      add: async (files: string[]) => void calls.add.push(files),
      commit: async (_m: string, files?: string[]) => void calls.commit.push(files ?? []),
      revparse: async () => revparse(seen++),
    };
    const store = {
      projects: { get: (id: string) => (id === "p1" ? { id, path: "C:/proj" } : null) },
    } as never;
    return {
      service: new GitService({ store, log: LOG, createClient: () => client as never }),
      calls,
    };
  }

  it("reports success without an id when HEAD cannot be read after the commit", async () => {
    // The commit did not throw, so it very likely landed. Claiming failure
    // here would invite a retry that double-commits.
    const { service } = stub(async (call) =>
      call === 0 ? "aaaa" : Promise.reject(new Error("fatal: unable to read the index")),
    );
    await expect(
      service.commit({ projectId: "p1", message: "m", paths: ["a.txt"] }),
    ).resolves.toEqual({ ok: true });
  });

  it("fails when HEAD is readable and unchanged — nothing was committed", async () => {
    const { service } = stub(async () => "aaaa");
    await expect(
      service.commit({ projectId: "p1", message: "m", paths: ["a.txt"] }),
    ).rejects.toThrow(/HEAD is unchanged/);
  });

  it("does not mistake an unreadable repository for an unborn one", async () => {
    // Before: a real access failure, not "no commits yet". After: a new sha.
    // The two must not be compared as if the repo had simply been empty.
    const { service } = stub(async (call) =>
      call === 0 ? Promise.reject(new Error("fatal: not a git repository")) : "bbbb",
    );
    await expect(
      service.commit({ projectId: "p1", message: "m", paths: ["a.txt"] }),
    ).resolves.toEqual({ ok: true, sha: "bbbb" });
  });

  it("stages the selection and commits it, in that order", async () => {
    const { service, calls } = stub(async (call) => (call === 0 ? "aaaa" : "bbbb"));
    await service.commit({ projectId: "p1", message: "m", paths: ["a.txt"] });
    expect(calls.add).toEqual([["--", "a.txt"]]);
    expect(calls.commit).toEqual([["--", "a.txt"]]);
  });
});
