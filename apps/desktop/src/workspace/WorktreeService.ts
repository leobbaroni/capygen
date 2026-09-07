/**
 * Git-authoritative worktree operations for one explicit source project.
 * No worktree inventory is persisted: project rows merely register concrete
 * execution directories and are joined onto Git's live porcelain output.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CapygenStore } from "@capygen/db";
import { cleanEnv } from "@capygen/engine";
import {
  WorktreeSchema,
  type Worktree,
  type WorktreeBranchChoice,
  type WorktreeCreateResult,
  type WorktreeRemoveResult,
} from "@capygen/shared";
import type { EngineLogger } from "../engine/types.js";
import { gitChildEnv } from "./GitService.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 120_000;

export type WorktreeErrorCode =
  | "missing-git"
  | "unknown-project"
  | "not-repository"
  | "unborn-head"
  | "invalid-branch"
  | "missing-branch"
  | "missing-base"
  | "occupied-branch"
  | "invalid-destination"
  | "not-worktree"
  | "different-repository"
  | "main-worktree"
  | "locked"
  | "active-session"
  | "access-failure";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly survivingPath?: string;
  readonly survivingBranch?: string | null;

  constructor(
    code: WorktreeErrorCode,
    message: string,
    surviving?: { path: string; branch: string | null },
  ) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    if (surviving) {
      this.survivingPath = surviving.path;
      this.survivingBranch = surviving.branch;
    }
  }
}

export interface GitCommandResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitCommandOptions {
  cwd: string;
  env: Record<string, string>;
  windowsHide: true;
}

export type GitCommandRunner = (
  args: string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

export interface WorktreeRemovalRisk {
  path: string;
  dirty: boolean;
  untracked: boolean;
  ignored: boolean;
}

export interface WorktreeServiceDeps {
  store: CapygenStore;
  log: EngineLogger;
  runGit?: GitCommandRunner;
  env?: Record<string, string | undefined>;
  /** Runner-owned activity not visible in the persisted session status. */
  isActive: (path: string) => boolean | Promise<boolean>;
  /** Native destructive confirmation. Its prompt must name `risk.path`. */
  confirmRemove: (risk: WorktreeRemovalRisk) => boolean | Promise<boolean>;
}

interface RawWorktree {
  path: string;
  headCommit: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

interface RepositoryContext {
  sourcePath: string;
  commonDir: string;
  worktrees: Worktree[];
}

export class WorktreeService {
  private readonly runGit: GitCommandRunner;
  private readonly env: Record<string, string>;

  constructor(private readonly deps: WorktreeServiceDeps) {
    this.runGit = deps.runGit ?? defaultRunGit;
    this.env = gitChildEnv(cleanEnv(deps.env ?? process.env));
  }

  async list(args: { sourceProjectId: string }): Promise<Worktree[]> {
    return (await this.repository(args.sourceProjectId)).worktrees;
  }

  /** Validate everything known before main opens a native destination picker.
   * `create` repeats this after the dialog because refs can move while it is open. */
  async validateCreate(args: {
    sourceProjectId: string;
    branch: WorktreeBranchChoice;
  }): Promise<void> {
    await this.prepareCreate(args.sourceProjectId, args.branch);
  }

  async create(args: {
    sourceProjectId: string;
    destinationPath: string;
    branch: WorktreeBranchChoice;
  }): Promise<WorktreeCreateResult> {
    const prepared = await this.prepareCreate(args.sourceProjectId, args.branch);
    const { repository } = prepared;
    const destinationPath = await canonicalDestination(args.destinationPath);

    if (repository.worktrees.some((entry) => samePath(entry.path, destinationPath))) {
      throw new WorktreeError("invalid-destination", `destination is already a worktree: ${destinationPath}`);
    }

    let command: string[];
    if (args.branch.mode === "existing") {
      command = ["worktree", "add", "--", destinationPath, args.branch.name];
    } else {
      command = ["worktree", "add", "-b", args.branch.name, "--", destinationPath, prepared.base!];
    }

    const result = await this.command(repository.sourcePath, command);
    if (result.code !== 0) {
      const surviving = await this.findAfterFailure(args.sourceProjectId, destinationPath);
      const detail = commandError(result);
      throw new WorktreeError(
        classifyCreateFailure(detail),
        surviving
          ? `git reported failure, but a worktree survives at ${surviving.path}` +
            (surviving.branch ? ` on branch ${surviving.branch}` : " with detached HEAD")
          : `git could not create the worktree: ${detail}`,
        surviving ? { path: surviving.path, branch: surviving.branch } : undefined,
      );
    }

    const refreshed = await this.repository(args.sourceProjectId);
    const verifiedDestination = await canonicalExisting(destinationPath, "access-failure");
    const created = refreshed.worktrees.find((entry) => samePath(entry.path, verifiedDestination));
    if (!created) {
      throw new WorktreeError(
        "access-failure",
        `git returned success but did not list the new worktree at ${destinationPath}`,
      );
    }
    return this.registerListed(created, refreshed.commonDir);
  }

  async register(args: { sourceProjectId: string; path: string }): Promise<WorktreeCreateResult> {
    const repository = await this.repository(args.sourceProjectId);
    const requested = await canonicalIfPresent(args.path);
    const listed = repository.worktrees.find((entry) => samePath(entry.path, requested));
    if (!listed) {
      await this.assertNotDifferentRepository(repository, args.path);
      throw new WorktreeError("not-worktree", `Git does not list this directory as a worktree: ${args.path}`);
    }
    return this.registerListed(listed, repository.commonDir);
  }

  async remove(args: { sourceProjectId: string; path: string }): Promise<WorktreeRemoveResult> {
    let repository = await this.repository(args.sourceProjectId);
    let listed = await this.removalTarget(repository, args.path);
    await this.assertRemovalAllowed(listed);

    const risk = await this.removalRisk(listed.path);
    const destructive = risk.dirty || risk.untracked || risk.ignored;
    if (destructive && !(await this.deps.confirmRemove(risk))) {
      return { ok: false, path: listed.path };
    }

    if (destructive) {
      // A native dialog yields the event loop. Re-read Git's inventory and
      // activity after it closes so a directory swap, lock, or newly-running
      // session cannot turn an earlier approval into removal of new state.
      repository = await this.repository(args.sourceProjectId);
      listed = await this.removalTarget(repository, listed.path);
      await this.assertRemovalAllowed(listed);
    }

    // Force is used only after the separate destructive confirmation. A clean
    // refusal is surfaced as-is; there is deliberately no automatic retry.
    const command = destructive
      ? ["worktree", "remove", "--force", "--", listed.path]
      : ["worktree", "remove", "--", listed.path];
    const result = await this.command(repository.sourcePath, command);
    if (result.code !== 0) {
      const detail = commandError(result);
      throw new WorktreeError(
        /lock/i.test(detail) ? "locked" : "access-failure",
        `git could not remove the worktree: ${detail}`,
      );
    }
    this.deps.log.info(`[worktree] removed ${listed.path}`);
    // Project rows stay: completed or archived session history may still point
    // at this execution directory.
    return { ok: true, path: listed.path };
  }

  private async repository(sourceProjectId: string): Promise<RepositoryContext> {
    const project = this.deps.store.projects.get(sourceProjectId);
    if (!project) throw new WorktreeError("unknown-project", `unknown project: ${sourceProjectId}`);
    const sourcePath = await canonicalExisting(project.path, "access-failure");
    const inside = await this.command(sourcePath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
      throw new WorktreeError("not-repository", `not a Git working tree: ${sourcePath}`);
    }
    const common = await this.command(sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (common.code !== 0) {
      throw new WorktreeError("access-failure", `could not resolve Git repository identity: ${commandError(common)}`);
    }
    const commonDir = normalizePath(common.stdout.toString("utf8").trim());
    const listed = await this.command(sourcePath, ["worktree", "list", "--porcelain", "-z"]);
    if (listed.code !== 0) {
      throw new WorktreeError("access-failure", `could not list Git worktrees: ${commandError(listed)}`);
    }
    const raw = parseWorktreePorcelain(listed.stdout);
    const projects = await this.projectPaths();
    const worktrees: Worktree[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index]!;
      const canonicalPath = await canonicalIfPresent(entry.path);
      worktrees.push(WorktreeSchema.parse({
        ...entry,
        path: canonicalPath,
        kind: index === 0 ? "main" : "linked",
        projectId: projects.get(pathKey(canonicalPath))?.id ?? null,
      }));
    }
    return { sourcePath, commonDir, worktrees };
  }

  private async projectPaths(): Promise<Map<string, { id: string }>> {
    const out = new Map<string, { id: string }>();
    for (const project of this.deps.store.projects.list()) {
      const canonical = await canonicalIfPresent(project.path);
      out.set(pathKey(canonical), { id: project.id });
    }
    return out;
  }

  private async registerListed(listed: Worktree, expectedCommonDir: string): Promise<WorktreeCreateResult> {
    if (listed.prunable) {
      throw new WorktreeError(
        "not-worktree",
        `a prunable worktree cannot be registered${listed.pruneReason ? `: ${listed.pruneReason}` : ""}`,
      );
    }
    const canonicalPath = await canonicalExisting(listed.path, "not-worktree");
    await this.assertSameRepository(expectedCommonDir, canonicalPath);
    const project = this.deps.store.projects.upsertByPath({ path: canonicalPath });
    this.deps.log.info(`[worktree] registered ${canonicalPath} as ${project.id}`);
    return {
      project,
      worktree: { ...listed, path: canonicalPath, projectId: project.id },
    };
  }

  private async validateBranch(cwd: string, branch: string): Promise<void> {
    const checked = await this.command(cwd, ["check-ref-format", "--branch", branch]);
    // `--branch` expands previous-checkout syntax such as `@{-1}`. That is a
    // useful command-line convenience, but here the user must name the exact
    // branch that will be created or checked out.
    if (checked.code !== 0 || checked.stdout.toString("utf8").trim() !== branch) {
      throw new WorktreeError("invalid-branch", `invalid branch name: ${branch}`);
    }
  }

  private async prepareCreate(
    sourceProjectId: string,
    branch: WorktreeBranchChoice,
  ): Promise<{ repository: RepositoryContext; base?: string }> {
    const repository = await this.repository(sourceProjectId);
    await this.requireCommittedHead(repository.sourcePath);
    await this.validateBranch(repository.sourcePath, branch.name);
    const exists = await this.localBranchExists(repository.sourcePath, branch.name);
    if (branch.mode === "existing") {
      if (!exists) {
        throw new WorktreeError("missing-branch", `local branch does not exist: ${branch.name}`);
      }
      if (repository.worktrees.some((entry) => entry.branch === branch.name)) {
        throw new WorktreeError("occupied-branch", `branch is already checked out: ${branch.name}`);
      }
      return { repository };
    }
    if (exists) {
      throw new WorktreeError("occupied-branch", `branch already exists: ${branch.name}`);
    }
    return {
      repository,
      base: await this.resolveCommit(repository.sourcePath, branch.base, "missing-base"),
    };
  }

  private async removalTarget(
    repository: RepositoryContext,
    candidate: string,
  ): Promise<Worktree> {
    const requested = await canonicalIfPresent(candidate);
    const listed = repository.worktrees.find((entry) => samePath(entry.path, requested));
    if (listed) {
      if (fs.existsSync(listed.path)) {
        await this.assertSameRepository(repository.commonDir, listed.path);
      }
      return listed;
    }
    await this.assertNotDifferentRepository(repository, candidate);
    throw new WorktreeError("not-worktree", `Git does not list this directory as a worktree: ${candidate}`);
  }

  private async assertRemovalAllowed(listed: Worktree): Promise<void> {
    if (listed.kind === "main") {
      throw new WorktreeError("main-worktree", `the main worktree cannot be removed: ${listed.path}`);
    }
    if (listed.locked) {
      throw new WorktreeError(
        "locked",
        `worktree is locked${listed.lockReason ? `: ${listed.lockReason}` : ""}`,
      );
    }
    if (await this.hasActiveSession(listed)) {
      throw new WorktreeError("active-session", `an active session is using ${listed.path}`);
    }
  }

  private async assertSameRepository(expectedCommonDir: string, candidate: string): Promise<void> {
    const common = await this.command(candidate, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      common.code !== 0 ||
      !samePath(normalizePath(common.stdout.toString("utf8").trim()), expectedCommonDir)
    ) {
      throw new WorktreeError(
        "different-repository",
        `directory no longer belongs to the source Git repository: ${candidate}`,
      );
    }
  }

  private async localBranchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await this.command(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new WorktreeError("access-failure", `could not inspect branch ${branch}: ${commandError(result)}`);
  }

  private async requireCommittedHead(cwd: string): Promise<void> {
    const result = await this.command(cwd, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
    if (result.code !== 0) {
      throw new WorktreeError("unborn-head", "the source repository has an unborn HEAD; make its first commit first");
    }
  }

  private async resolveCommit(
    cwd: string,
    value: string,
    code: "missing-base",
  ): Promise<string> {
    const result = await this.command(cwd, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]);
    const commit = result.stdout.toString("utf8").trim();
    if (result.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new WorktreeError(code, `base does not resolve to a committed revision: ${value}`);
    }
    return commit;
  }

  private async findAfterFailure(sourceProjectId: string, destination: string): Promise<Worktree | null> {
    try {
      const refreshed = await this.repository(sourceProjectId);
      return refreshed.worktrees.find((entry) => samePath(entry.path, destination)) ?? null;
    } catch {
      return null;
    }
  }

  private async assertNotDifferentRepository(
    repository: RepositoryContext,
    candidate: string,
  ): Promise<void> {
    let cwd: string;
    try {
      cwd = await canonicalExisting(candidate, "not-worktree");
    } catch {
      return;
    }
    const common = await this.command(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return;
    if (!samePath(normalizePath(common.stdout.toString("utf8").trim()), repository.commonDir)) {
      throw new WorktreeError("different-repository", `directory belongs to a different Git repository: ${candidate}`);
    }
  }

  private async hasActiveSession(worktree: Worktree): Promise<boolean> {
    const persisted = worktree.projectId
      ? this.deps.store.sessions
          .list({ projectId: worktree.projectId, includeArchived: true })
          .some((session) => session.status === "running" || session.status === "waiting")
      : false;
    return persisted || Boolean(await this.deps.isActive(worktree.path));
  }

  private async removalRisk(worktreePath: string): Promise<WorktreeRemovalRisk> {
    const result = await this.command(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    if (result.code !== 0) {
      throw new WorktreeError("access-failure", `could not inspect worktree contents: ${commandError(result)}`);
    }
    let dirty = false;
    let untracked = false;
    let ignored = false;
    for (const record of result.stdout.toString("utf8").split("\0")) {
      if (record.startsWith("?? ")) untracked = true;
      else if (record.startsWith("!! ")) ignored = true;
      else if (record.length >= 3) dirty = true;
    }
    return { path: worktreePath, dirty, untracked, ignored };
  }

  private async command(cwd: string, args: string[]): Promise<GitCommandResult> {
    try {
      return await this.runGit([...args], { cwd, env: this.env, windowsHide: true });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") {
        throw new WorktreeError("missing-git", "Git is not installed or is not available on PATH");
      }
      throw new WorktreeError(
        "access-failure",
        `could not run Git: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Parse `git worktree list --porcelain -z` without line/path splitting. */
export function parseWorktreePorcelain(output: Buffer): RawWorktree[] {
  const records: RawWorktree[] = [];
  let current: Partial<RawWorktree> | null = null;
  const flush = (): void => {
    if (!current?.path) return;
    records.push({
      path: current.path,
      headCommit: current.headCommit ?? null,
      branch: current.branch ?? null,
      detached: current.detached ?? current.branch === undefined,
      locked: current.locked ?? false,
      lockReason: current.lockReason ?? null,
      prunable: current.prunable ?? false,
      pruneReason: current.pruneReason ?? null,
    });
    current = null;
  };
  for (const token of output.toString("utf8").split("\0")) {
    if (token === "") {
      flush();
      continue;
    }
    const split = token.indexOf(" ");
    const key = split === -1 ? token : token.slice(0, split);
    const value = split === -1 ? "" : token.slice(split + 1);
    if (key === "worktree") {
      flush();
      current = { path: value };
    } else if (current && key === "HEAD") {
      current.headCommit = /^0+$/.test(value) ? null : value;
    } else if (current && key === "branch") {
      current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
      current.detached = false;
    } else if (current && key === "detached") {
      current.branch = null;
      current.detached = true;
    } else if (current && key === "locked") {
      current.locked = true;
      current.lockReason = value || null;
    } else if (current && key === "prunable") {
      current.prunable = true;
      current.pruneReason = value || null;
    }
  }
  flush();
  return records;
}

async function canonicalDestination(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new WorktreeError("invalid-destination", `worktree destination must be an absolute path: ${candidate}`);
  }
  let existing = normalizePath(path.resolve(candidate));
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new WorktreeError("invalid-destination", `worktree destination has no accessible parent: ${candidate}`);
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalParent = await canonicalExisting(existing, "access-failure");
  return normalizePath(path.join(canonicalParent, ...suffix));
}

async function canonicalExisting(candidate: string, code: WorktreeErrorCode): Promise<string> {
  try {
    return normalizePath(await fs.promises.realpath(candidate));
  } catch (error) {
    throw new WorktreeError(code, `cannot access ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function canonicalIfPresent(candidate: string): Promise<string> {
  try {
    return normalizePath(await fs.promises.realpath(candidate));
  } catch {
    return normalizePath(path.resolve(candidate));
  }
}

function normalizePath(candidate: string): string {
  const parsed = path.parse(candidate);
  let normalized = path.normalize(candidate);
  while (normalized.length > parsed.root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return normalized;
}

function pathKey(candidate: string): string {
  const normalized = normalizePath(candidate);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function commandError(result: GitCommandResult): string {
  return result.stderr.trim() || result.stdout.toString("utf8").trim() || `exit ${result.code}`;
}

function classifyCreateFailure(message: string): WorktreeErrorCode {
  if (/already checked out|already exists|is already used by worktree/i.test(message)) return "occupied-branch";
  if (/locked/i.test(message)) return "locked";
  return "access-failure";
}

async function defaultRunGit(args: string[], options: GitCommandOptions): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, MAX_GIT_RUNTIME_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      } else stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: overflow || timedOut ? -1 : code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: overflow
          ? "Git output exceeded 4 MiB"
          : timedOut
            ? "Git command exceeded 120 seconds"
            : Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
