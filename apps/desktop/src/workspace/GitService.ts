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
    files: { path: string; index: string; working_dir: string }[];
  }>;
  diff(options: string[]): Promise<string>;
  add(files: string[]): Promise<unknown>;
  commit(message: string, files?: string[], options?: Record<string, null>): Promise<unknown>;
  revparse(options: string[]): Promise<string>;
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
   * `paths` omitted commits everything already tracked and changed (the `-a`
   * of a plain `git commit -a`); with `paths` those files are staged first, so
   * a brand-new file can be committed from the pane without a separate "add".
   */
  async commit(args: {
    projectId: string;
    message: string;
    paths?: string[];
  }): Promise<{ ok: boolean; sha?: string }> {
    const git = await this.client(args.projectId);
    if (!(await isRepo(git))) throw new Error("not a git repository");
    if (args.paths && args.paths.length > 0) {
      await git.add(args.paths);
      await git.commit(args.message, args.paths);
    } else {
      await git.commit(args.message, undefined, { "--all": null });
    }
    try {
      const sha = (await git.revparse(["HEAD"])).trim();
      return sha ? { ok: true, sha } : { ok: true };
    } catch {
      // The commit landed; only the id lookup failed (a fresh repo mid-write,
      // a detached worktree). Reporting `ok` without a sha beats reporting a
      // failure that did not happen.
      return { ok: true };
    }
  }
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

async function defaultCreateClient(root: string): Promise<GitClientLike> {
  const mod = await import("simple-git");
  const factory = (mod as unknown as { simpleGit: (baseDir: string) => GitClientLike }).simpleGit;
  return factory(root);
}
