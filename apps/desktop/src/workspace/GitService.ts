/**
 * The Diff pane's git (SPEC R16), and the commit button behind it.
 *
 * `simple-git` 3.36 is the driver: it spawns the user's own `git.exe` rather
 * than reimplementing the format, so what the pane shows is what the CLI in
 * the Terminal pane would show one line later.
 *
 * The rule that shapes the whole file: **a project that is not a repository is
 * not an error.** capygen opens any folder the user points it at, and most of
 * them are repos, but the Diff pane must render "not a git repository" rather
 * than a red toast — hence `git.status` answering `null` (its IPC output is
 * `GitStatusSchema.nullable()`), `git.diff` answering `[]`, and only
 * `git.commit` — which the user asked for explicitly — throwing.
 */
import type { CapygenStore } from "@capygen/db";
import { cleanEnv } from "@capygen/engine";
import type { GitDiff, GitStatus, GitStatusEntry } from "@capygen/shared";
import { projectRoot } from "./paths.js";
import type { EngineLogger } from "../engine/types.js";

/** The slice of `simple-git`'s API this service uses. Declared structurally so
 *  the tests can drive a fake and so an upgrade that moves something else in
 *  that large surface cannot silently change what capygen depends on. */
export interface GitClientLike {
  checkIsRepo(): Promise<boolean>;
  status(): Promise<{
    current?: string | null;
    tracking?: string | null;
    ahead?: number;
    behind?: number;
    files: { path: string; index: string; working_dir: string; from?: string }[];
  }>;
  diff(options: string[]): Promise<string>;
  add(files: string[]): Promise<unknown>;
  commit(message: string, files?: string[], options?: Record<string, null>): Promise<unknown>;
  revparse(options: string[]): Promise<string>;
}

/**
 * Everything `commit` refuses, in one place so the rules can be tested without
 * a repository and quoted back to the user verbatim.
 *
 * A selected path arrives as project-relative POSIX text typed by nobody — the
 * pane sends back what `status()` gave it — but it crosses IPC, so it is
 * treated as hostile input all the same (`workspace/paths.ts` states the rule
 * this follows).
 */
export class GitSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSelectionError";
  }
}

export interface GitServiceDeps {
  store: CapygenStore;
  log: EngineLogger;
  /** Overridable in tests; the default loads `simple-git` lazily per root. */
  createClient?: (root: string) => Promise<GitClientLike> | GitClientLike;
}

export class GitService {
  constructor(private readonly deps: GitServiceDeps) {}

  private async client(projectId: string): Promise<GitClientLike> {
    const { root } = projectRoot(this.deps.store, projectId);
    return (this.deps.createClient ?? defaultCreateClient)(root);
  }

  /** `null` when the folder is not a repository at all — not an error. */
  async status(args: { projectId: string }): Promise<GitStatus | null> {
    const git = await this.client(args.projectId);
    if (!(await isRepo(git))) return null;
    const raw = await git.status();
    const entries: GitStatusEntry[] = raw.files.map((file) => ({
      path: file.path.split("\\").join("/"),
      // The two porcelain columns, joined and trimmed: "M ", " M", "MM", "??".
      // Kept as free text because the vocabulary is git's, not capygen's
      // (`GitStatusEntrySchema`).
      status: `${file.index}${file.working_dir}`.trim() || "?",
    }));
    return {
      // A repository with no commits yet has no branch name; "HEAD" is what
      // git itself prints there, and an empty string would fail the schema's
      // intent as much as a lie would.
      branch: raw.current ?? "HEAD",
      ahead: raw.ahead ?? 0,
      behind: raw.behind ?? 0,
      entries,
    };
  }

  /**
   * One `GitDiff` per changed file. `staged` reads the index (`--cached`),
   * otherwise the working tree; `path` narrows to a single file.
   *
   * git emits one patch containing every file, so the split happens here on
   * the `diff --git` headers rather than by running git once per file — a
   * 200-file working tree would otherwise be 200 process spawns.
   */
  async diff(args: {
    projectId: string;
    path?: string;
    staged: boolean;
  }): Promise<GitDiff[]> {
    const git = await this.client(args.projectId);
    if (!(await isRepo(git))) return [];
    const options = ["--no-color", "--unified=3"];
    if (args.staged) options.push("--cached");
    if (args.path) options.push("--", args.path);
    let patch: string;
    try {
      patch = await git.diff(options);
    } catch (err) {
      this.deps.log.warn(`[git] diff failed: ${(err as Error).message}`);
      throw err;
    }
    return splitUnifiedDiff(patch);
  }

  /**
   * Commit **exactly** the selected paths — never more.
   *
   * An empty or missing selection is an error, not `--all`. This used to fall
   * back to `git commit --all`, so a dropped field or a stale renderer payload
   * turned "commit nothing" into "commit the whole working tree" — the kind of
   * mistake whose next step is usually a push.
   *
   * `git add` then `git commit`, each with its own pathspec list (see
   * {@link resolveCommitPathspecs}): the `add` is what lets a new file be
   * committed and what records an unstaged deletion, and `git commit
   * <pathspec>` is a partial commit, which git documents as committing the
   * named files "without recording the changes already added to the index" —
   * so a file staged elsewhere and left unchecked stays staged and
   * uncommitted, which is the promise the checkbox makes.
   *
   * Nothing is rolled back on failure. A rejected hook, a locked index or a
   * bad message throws with git's own message and whatever the `add` staged
   * stays staged, where the user's work is safest. A speculative `git reset`
   * would be the one operation here able to destroy work.
   */
  async commit(args: {
    projectId: string;
    message: string;
    paths?: string[];
  }): Promise<{ ok: boolean; sha?: string }> {
    projectRoot(this.deps.store, args.projectId);
    // Shape is checked before any child runs, so a hostile selection never
    // reaches git even if the repository probe below were to hang.
    const selection = assertSelectionShape(args.paths);

    const git = await this.client(args.projectId);
    if (!(await isRepo(git))) throw new Error("not a git repository");

    const raw = await git.status();
    const { add, commit } = resolveCommitPathspecs(selection, raw.files);

    const before = await headState(git);
    // `git add --` with no pathspec is not a no-op; skip it entirely when the
    // selection is only already-staged deletions.
    if (add.length > 0) await git.add(["--", ...add]);
    await git.commit(args.message, ["--", ...commit]);
    const after = await headState(git);

    if (after.kind === "sha" && before.kind === "sha" && after.sha === before.sha) {
      throw new Error(
        "git commit did not create a commit (HEAD is unchanged); " +
          "the selected paths may already be committed",
      );
    }
    if (after.kind !== "sha") {
      // The commit itself did not throw, so it very likely landed; only the id
      // lookup failed. Saying "nothing was written" here would invite a retry
      // that double-commits. Report success without an id instead.
      this.deps.log.warn(
        `[git] commit succeeded but HEAD could not be read (${after.kind}); reporting no sha`,
      );
      return { ok: true };
    }
    return { ok: true, sha: after.sha };
  }
}

/**
 * `HEAD` as three distinguishable outcomes. `unborn` (no commit yet) and
 * `unavailable` (git could not be asked) must not be conflated: only the first
 * proves the repository is empty.
 */
type HeadState =
  | { kind: "sha"; sha: string }
  | { kind: "unborn" }
  | { kind: "unavailable" };

async function headState(git: GitClientLike): Promise<HeadState> {
  try {
    const sha = (await git.revparse(["HEAD"])).trim();
    if (sha.length > 0) return { kind: "sha", sha };
  } catch (err) {
    // git's own wording for "the ref does not exist yet"; anything else is a
    // repository we failed to read, which is not the same claim.
    const text = err instanceof Error ? err.message : String(err);
    if (/unknown revision|ambiguous argument|bad revision|needed a single revision/i.test(text)) {
      return { kind: "unborn" };
    }
    return { kind: "unavailable" };
  }
  return { kind: "unborn" };
}

/**
 * Shape checks on a selection, byte-for-byte. Exported for the tests.
 *
 * Deliberately **not** normalising: no trimming, no separator rewriting, no
 * stripping of leading slashes. ` file.txt` and `file.txt` are different names
 * on every filesystem capygen supports, and silently turning one into the
 * other would commit a file the user did not select. Anything that is not
 * already a plain project-relative path is refused by name instead.
 */
export function assertSelectionShape(paths: string[] | undefined): string[] {
  if (paths === undefined || paths.length === 0) {
    throw new GitSelectionError(
      "commit needs an explicit, non-empty selection of paths; " +
        "refusing to commit the whole working tree",
    );
  }
  for (const candidate of paths) {
    if (typeof candidate !== "string") {
      throw new GitSelectionError(
        `commit selection contains a non-string path: ${String(candidate)}`,
      );
    }
    if (candidate === "") {
      throw new GitSelectionError("commit selection contains an empty path");
    }
    if (candidate.includes("\0")) {
      throw new GitSelectionError("commit selection contains a NUL byte");
    }
    // Pathspec magic (`:(exclude)…`, `:!…`, `:/`) matches files other than the
    // one named — the only input class that can widen a commit past what was
    // checked. `GIT_LITERAL_PATHSPECS` on the child already neuters it; this
    // refuses it too, so the guarantee does not rest on one variable.
    if (candidate.startsWith(":")) {
      throw new GitSelectionError(
        `commit selection contains a git pathspec, not a path: ${candidate}`,
      );
    }
    if (isNotProjectRelative(candidate)) {
      throw new GitSelectionError(
        `commit selection must be a project-relative path, got: ${candidate}`,
      );
    }
    // A leading hyphen is a literal file name here, not an option: `--` in the
    // argv and `GIT_LITERAL_PATHSPECS` both make it so. Not refused.
  }
  return [...paths];
}

/** Absolute POSIX, drive-absolute, drive-relative (`C:x`), UNC or `..`-escaping. */
function isNotProjectRelative(candidate: string): boolean {
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(candidate)) return true;
  return candidate.split(/[/\\]/).includes("..");
}

/** An entry whose content is in neither the index nor the worktree: `git add`
 *  on it fails pathspec-not-found. Staged deletion is porcelain `D `. */
function isAlreadyStagedDeletion(index: string, workingDir: string): boolean {
  return index === "D" && workingDir.trim() === "";
}

/**
 * The pathspecs to hand git, split by the command that takes them.
 *
 * Every selected path must be an **exact** current changed file. Matching
 * against the live status list is what makes a directory, a path prefix, a
 * stale path and a path outside the project all fail identically — none of
 * them is an entry.
 *
 * Two entry kinds are named at commit time but deliberately left out of `add`,
 * because `git add` fails on both:
 *
 *  - an **already-staged deletion** (`D `), absent from index and worktree;
 *  - a **rename's original** (`R` + `from`), already staged under the new name.
 *
 * The rename original comes from git's own `from` field, never from parsing
 * display text: a file literally named `a -> b` is one path. `from` is only
 * followed for `R`; a `C` (copy) source is a different file that may carry its
 * own unchecked changes.
 */
export function resolveCommitPathspecs(
  selection: readonly string[],
  files: readonly { path: string; index: string; working_dir: string; from?: string }[],
): { add: string[]; commit: string[] } {
  const posix = (value: string): string => value.split("\\").join("/");
  const byPath = new Map<string, { index: string; working_dir: string; from?: string }>();
  for (const file of files) {
    byPath.set(posix(file.path), file);
  }

  const add: string[] = [];
  const commit: string[] = [];
  // Exact strings, case-sensitively: a case-sensitive volume can hold both
  // `A.txt` and `a.txt`, and folding them would commit the wrong one.
  const seenAdd = new Set<string>();
  const seenCommit = new Set<string>();
  const push = (list: string[], seen: Set<string>, value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };

  for (const candidate of selection) {
    const entry = byPath.get(candidate);
    if (!entry) {
      throw new GitSelectionError(
        `commit selection names "${candidate}", which is not one of the ` +
          "changed files git currently reports; refresh the pane and try again",
      );
    }
    push(commit, seenCommit, candidate);
    if (!isAlreadyStagedDeletion(entry.index, entry.working_dir)) {
      push(add, seenAdd, candidate);
    }
    if (entry.index === "R" && entry.from) {
      push(commit, seenCommit, posix(entry.from));
    }
  }
  return { add, commit };
}

/** `checkIsRepo()` throws on a path git refuses outright; both answers mean
 *  the same thing to the panes. */
async function isRepo(git: GitClientLike): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/**
 * Split one combined patch into per-file `GitDiff`s.
 *
 * The path comes from the `+++ b/...` line when there is one (it survives a
 * rename and quoting better than the `diff --git` header) and falls back to
 * the header's `b/` half for a deletion, which has `+++ /dev/null`.
 */
export function splitUnifiedDiff(patch: string): GitDiff[] {
  const out: GitDiff[] = [];
  if (patch.trim() === "") return out;
  const lines = patch.split(/\r?\n/);
  let current: { header: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const unified = [current.header, ...current.body].join("\n");
    const binary = current.body.some((line) => line.startsWith("Binary files "));
    out.push({
      path: pathFromChunk(current.header, current.body),
      unified: binary ? "" : unified,
      ...(binary ? { binary: true } : {}),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { header: line, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return out;
}

function pathFromChunk(header: string, body: string[]): string {
  for (const line of body) {
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length).trim();
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      return line.slice(4).trim();
    }
  }
  // `diff --git a/<p> b/<p>` — take the b-side, which is the post-image name.
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(header);
  if (match) return (match[2] ?? match[1] ?? header).trim();
  return header;
}

/**
 * Environment variables a git child must not inherit. The five operations here
 * (`status`, `diff`, `add`, `commit`, `rev-parse`) are non-interactive and
 * local, so none of these costs anything to remove.
 *
 * `HOME`/`XDG_CONFIG_HOME` are deliberately **kept**: they are how a caller
 * (and the test suite) points git at an isolated configuration.
 */
const GIT_UNSAFE_ENV = [
  // Refused by simple-git unless the matching `unsafe.*` flag is set
  // (`@simple-git/argv-parser@1.1.1`, dist/index.mjs:394-412). EDITOR, PAGER
  // and PREFIX are ordinary developer-shell variables, so forwarding
  // `process.env` unfiltered made `checkIsRepo()` throw — and `isRepo()` turns
  // a throw into "not a git repository", so the pane reported every repo as a
  // non-repo on those machines.
  "EDITOR",
  "GIT_ASKPASS",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "PAGER",
  "PREFIX",
  "SSH_ASKPASS",
  // Repository redirection. If capygen is itself launched from a shell inside
  // a git operation (a hook, a rebase, `git bisect run`), these point at *that*
  // repository — so an inherited value would silently make the pane read and
  // commit to a different repo or index than the project the user selected.
  // The explicit `baseDir` must be the only thing that decides.
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

/**
 * The `simple-git` instance every call in this file runs through. Three
 * departures from the default construction, checked against the installed
 * 3.36.0 (`dist/cjs/index.js`; `SimpleGitOptions` in
 * `dist/src/lib/types/index.d.ts`):
 *
 *  1. **Environment.** simple-git spawns with `env: this.env`, which stays
 *     `undefined` until `.env()` is called, so the child inherited all of
 *     capygen's `process.env`. It now gets `cleanEnv` minus
 *     {@link GIT_UNSAFE_ENV}.
 *  2. **`GIT_LITERAL_PATHSPECS=1`** so git reads every argument as a literal
 *     path — a second, independent guard against pathspec magic.
 *  3. **`core.quotepath=false`** so a non-ASCII filename comes back as itself
 *     rather than octal-escaped, which the pane would send back unmatched.
 *
 * `windowsHide` needs nothing from us: 3.36.0 passes `windowsHide: true` on
 * every spawn, and its `spawnOptions` is `Pick<SpawnOptions, "uid" | "gid">`,
 * which would reject one.
 */
async function defaultCreateClient(root: string): Promise<GitClientLike> {
  const mod = await import("simple-git");
  const factory = (
    mod as unknown as {
      simpleGit: (options: { baseDir: string; config: string[] }) => GitClientLike & {
        env(env: Record<string, string>): unknown;
      };
    }
  ).simpleGit;
  const git = factory({
    baseDir: root,
    // `-c` switches, applied to every command this instance runs.
    config: ["core.quotepath=false"],
  });
  git.env(gitChildEnv(cleanEnv(process.env)));
  return git;
}

/**
 * The environment a git child gets: string values only, no
 * {@link GIT_UNSAFE_ENV}, literal pathspecs. Exported so the test suite can
 * assert the stripping without spawning anything.
 */
export function gitChildEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const unsafe = new Set(GIT_UNSAFE_ENV.map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // Case-insensitively: Windows environment variables are, and simple-git
    // lower-cases the name before looking it up in its own table.
    if (typeof value !== "string" || unsafe.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.GIT_LITERAL_PATHSPECS = "1";
  return out;
}
