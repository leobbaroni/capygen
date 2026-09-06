/**
 * The Files and Editor panes' filesystem (SPEC R16), bounded everywhere
 * (R23-R26).
 *
 * Every method is *capped* rather than complete: a directory listing stops at
 * `MAX_ENTRIES_PER_DIR`, a recursive walk at `MAX_TOTAL_ENTRIES`, a read at
 * `DEFAULT_MAX_READ_BYTES`, a search at its `limit` — and each result says so
 * with `truncated` instead of letting the caller infer it from a suspiciously
 * round number. A pane that quietly walks `node_modules` is the difference
 * between an app and a fan.
 *
 * Nothing here ever enters a model's context: these channels answer the
 * renderer only (R26).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CapygenStore } from "@capygen/db";
import type { FileChange, FileEntry, FileListResult, FileReadResult } from "@capygen/shared";
import { ignoredUnder, isIgnoredDirName } from "./ignore.js";
import { projectRoot, resolveExistingInside, resolveInside, toRelPosix } from "./paths.js";
import type { Broadcast, EngineLogger } from "../engine/types.js";

export const MAX_ENTRIES_PER_DIR = 500;
export const MAX_TOTAL_ENTRIES = 5_000;
export const MAX_LIST_DEPTH = 8;
export const DEFAULT_MAX_READ_BYTES = 1_000_000;
export const HARD_MAX_READ_BYTES = 8_000_000;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 1_000;
/** Files a fallback walker will look at before giving up on a search. */
export const MAX_SEARCH_SCAN = 20_000;
/** Bytes sniffed for a NUL before a file is called binary. */
export const BINARY_SNIFF_BYTES = 8_192;
/** How long changes pile up before one `fs.changed` batch goes out (R23). */
export const WATCH_DEBOUNCE_MS = 250;
/** A batch never carries more than this; the flush fires early if it fills. */
export const MAX_CHANGES_PER_BATCH = 200;

/** The minimum of chokidar's `FSWatcher` this service uses. */
export interface WatcherLike {
  on(event: string, handler: (path: string) => void): unknown;
  close(): Promise<void> | void;
}

export interface FsServiceDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Overridable in tests; the default loads chokidar 5 lazily on first watch. */
  createWatcher?: (root: string) => Promise<WatcherLike> | WatcherLike;
  /** Overridable in tests; the default probes `rg --version` once. */
  ripgrepPath?: () => string | null;
}

export class FsService {
  private readonly watchers = new Map<string, Promise<WatcherLike>>();
  private readonly pending = new Map<string, FileChange[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private ripgrep: string | null | undefined;

  constructor(private readonly deps: FsServiceDeps) {}

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  /**
   * One directory, or `depth` levels of it. `depth` omitted (or 0) lists just
   * the directory named; the tree pane asks for one level at a time and only
   * uses a deeper walk when the user expands "reveal in tree".
   */
  list(args: { projectId: string; dir: string; depth?: number }): FileListResult {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const start = resolveExistingInside(root, args.dir);
    const depth = Math.min(Math.max(args.depth ?? 0, 0), MAX_LIST_DEPTH);
    const entries: FileEntry[] = [];
    let truncated = false;

    const walk = (dir: string, level: number): void => {
      if (truncated) return;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        // A directory we cannot open is one row missing, not a failed pane.
        this.deps.log.warn(`[fs] readdir ${dir}: ${(err as Error).message}`);
        return;
      }
      dirents.sort(compareDirents);
      let taken = 0;
      for (const dirent of dirents) {
        if (dirent.isDirectory() && isIgnoredDirName(dirent.name)) continue;
        if (taken >= MAX_ENTRIES_PER_DIR || entries.length >= MAX_TOTAL_ENTRIES) {
          truncated = true;
          return;
        }
        const absolute = path.join(dir, dirent.name);
        const entry = describe(root, absolute, dirent);
        if (!entry) continue;
        entries.push(entry);
        taken += 1;
        if (dirent.isDirectory() && level < depth) walk(absolute, level + 1);
      }
    };

    walk(start, 0);
    return { entries, truncated };
  }

  // -------------------------------------------------------------------------
  // read / write
  // -------------------------------------------------------------------------

  read(args: { projectId: string; path: string; maxBytes?: number }): FileReadResult {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const absolute = resolveExistingInside(root, args.path);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) throw new Error(`not a file: ${args.path}`);
    const cap = Math.min(args.maxBytes ?? DEFAULT_MAX_READ_BYTES, HARD_MAX_READ_BYTES);
    const size = stat.size;
    const wanted = Math.min(size, cap);

    const buffer = Buffer.alloc(wanted);
    const fd = fs.openSync(absolute, "r");
    try {
      fs.readSync(fd, buffer, 0, wanted, 0);
    } finally {
      fs.closeSync(fd);
    }
    const binary = looksBinary(buffer);
    return {
      path: toRelPosix(root, absolute),
      content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      size,
      truncated: wanted < size,
      binary,
    };
  }

  /**
   * Atomic write: the new bytes land in a sibling temp file and are renamed
   * over the target, so a crash mid-write leaves the old file intact rather
   * than a half-written one. The rename is same-directory on purpose — across
   * volumes it is a copy, and would lose the atomicity that is the whole point.
   */
  write(args: { projectId: string; path: string; content: string }): { ok: boolean } {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const absolute = resolveInside(root, args.path);
    const dir = path.dirname(absolute);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.capygen-${process.pid}-${Date.now().toString(36)}.tmp`);
    try {
      fs.writeFileSync(temp, args.content, "utf8");
      fs.renameSync(temp, absolute);
    } catch (err) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* the temp file is best-effort cleanup; the real error is rethrown */
      }
      throw err;
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  /**
   * Filename search (the quick-open box), not content search: `rg --files`
   * when ripgrep is on PATH — it already honours `.gitignore` and is an order
   * of magnitude faster on a big tree — and a bounded walker otherwise. Both
   * match a case-insensitive substring of the project-relative path, so
   * `src/ma` finds `src/main.ts`.
   */
  search(args: { projectId: string; query: string; limit?: number }): FileListResult {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const limit = Math.min(args.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const needle = args.query.trim().toLowerCase();
    if (needle === "") return { entries: [], truncated: false };

    const fromRipgrep = this.searchWithRipgrep(root, needle, limit);
    if (fromRipgrep) return fromRipgrep;
    return this.searchWithWalker(root, needle, limit);
  }

  private searchWithRipgrep(root: string, needle: string, limit: number): FileListResult | null {
    const rg = this.resolveRipgrep();
    if (!rg) return null;
    let stdout: string;
    try {
      const result = spawnSync(rg, ["--files", "--hidden", "--no-messages"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15_000,
      });
      // rg exits 1 for "no files"; only a spawn failure is worth falling back
      // for, and even then the walker still answers.
      if (result.error) throw result.error;
      stdout = result.stdout ?? "";
    } catch (err) {
      this.deps.log.warn(`[fs] ripgrep search failed, falling back: ${(err as Error).message}`);
      this.ripgrep = null;
      return null;
    }
    const entries: FileEntry[] = [];
    let truncated = false;
    for (const line of stdout.split(/\r?\n/)) {
      if (line === "") continue;
      const rel = line.split(path.sep).join("/");
      if (!rel.toLowerCase().includes(needle)) continue;
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      const absolute = path.join(root, rel);
      const entry = describe(root, absolute, null);
      if (entry) entries.push(entry);
    }
    return { entries, truncated };
  }

  private searchWithWalker(root: string, needle: string, limit: number): FileListResult {
    const entries: FileEntry[] = [];
    let scanned = 0;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          if (isIgnoredDirName(dirent.name)) continue;
          stack.push(path.join(dir, dirent.name));
          continue;
        }
        scanned += 1;
        if (scanned > MAX_SEARCH_SCAN) return { entries, truncated: true };
        const absolute = path.join(dir, dirent.name);
        const rel = toRelPosix(root, absolute);
        if (!rel.toLowerCase().includes(needle)) continue;
        if (entries.length >= limit) return { entries, truncated: true };
        const entry = describe(root, absolute, dirent);
        if (entry) entries.push(entry);
      }
    }
    return { entries, truncated: false };
  }

  /** `rg` is probed once per process; a machine without it never pays again. */
  private resolveRipgrep(): string | null {
    if (this.ripgrep !== undefined) return this.ripgrep;
    if (this.deps.ripgrepPath) {
      this.ripgrep = this.deps.ripgrepPath();
      return this.ripgrep;
    }
    try {
      const probe = spawnSync("rg", ["--version"], { windowsHide: true, timeout: 5_000 });
      this.ripgrep = probe.status === 0 ? "rg" : null;
    } catch {
      this.ripgrep = null;
    }
    return this.ripgrep;
  }

  // -------------------------------------------------------------------------
  // watch
  // -------------------------------------------------------------------------

  /** Idempotent — watching an already-watched project is not an error. */
  async watch(args: { projectId: string }): Promise<{ ok: boolean }> {
    if (this.watchers.has(args.projectId)) return { ok: true };
    const { root } = projectRoot(this.deps.store, args.projectId);
    const starting = Promise.resolve(
      (this.deps.createWatcher ?? defaultCreateWatcher)(root),
    ).then((watcher) => {
      for (const kind of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
        watcher.on(kind, (changed: string) => {
          this.queue(args.projectId, { path: toRelPosix(root, changed), kind });
        });
      }
      watcher.on("error", (err: unknown) => {
        this.deps.log.warn(`[fs] watcher ${root}: ${String(err)}`);
      });
      return watcher;
    });
    this.watchers.set(args.projectId, starting);
    try {
      await starting;
    } catch (err) {
      this.watchers.delete(args.projectId);
      throw err;
    }
    this.deps.log.info(`[fs] watching ${root}`);
    return { ok: true };
  }

  /** Idempotent — unwatching a project nothing watches is not an error. */
  async unwatch(args: { projectId: string }): Promise<{ ok: boolean }> {
    const watcher = this.watchers.get(args.projectId);
    this.watchers.delete(args.projectId);
    this.clearTimer(args.projectId);
    this.pending.delete(args.projectId);
    if (!watcher) return { ok: true };
    try {
      await (await watcher).close();
    } catch (err) {
      this.deps.log.warn(`[fs] closing watcher: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  private queue(projectId: string, change: FileChange): void {
    if (change.path === "" || change.path.startsWith("..")) return;
    const batch = this.pending.get(projectId) ?? [];
    // Same path + same kind twice inside one window is one change to the UI.
    if (!batch.some((c) => c.path === change.path && c.kind === change.kind)) batch.push(change);
    this.pending.set(projectId, batch);
    if (batch.length >= MAX_CHANGES_PER_BATCH) {
      this.flush(projectId);
      return;
    }
    if (this.timers.has(projectId)) return;
    const timer = setTimeout(() => this.flush(projectId), WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  private flush(projectId: string): void {
    this.clearTimer(projectId);
    const changes = this.pending.get(projectId);
    this.pending.delete(projectId);
    if (!changes || changes.length === 0) return;
    this.deps.broadcast("fs.changed", { projectId, changes });
  }

  private clearTimer(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
  }

  async dispose(): Promise<void> {
    const ids = [...this.watchers.keys()];
    await Promise.all(ids.map((projectId) => this.unwatch({ projectId })));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Directories first, then case-insensitive by name — the order a file tree
 *  is read in, decided here so every caller agrees. */
function compareDirents(a: fs.Dirent, b: fs.Dirent): number {
  const aDir = a.isDirectory() ? 0 : 1;
  const bDir = b.isDirectory() ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function describe(root: string, absolute: string, dirent: fs.Dirent | null): FileEntry | null {
  let isDir = dirent?.isDirectory() ?? false;
  let size: number | undefined;
  let mtime: number | undefined;
  try {
    const stat = fs.statSync(absolute);
    isDir = stat.isDirectory();
    if (!isDir) size = stat.size;
    mtime = Math.trunc(stat.mtimeMs);
  } catch {
    // A file that vanished between readdir and stat: keep the dirent's word
    // for what it was, drop the size/mtime. With no dirent there is nothing
    // left to describe.
    if (!dirent) return null;
  }
  const rel = toRelPosix(root, absolute);
  if (rel === "" || rel.startsWith("..")) return null;
  return {
    path: rel,
    name: path.basename(absolute),
    kind: isDir ? "dir" : "file",
    ...(size !== undefined ? { size } : {}),
    ...(mtime !== undefined ? { mtime } : {}),
  };
}

/** A NUL byte in the first `BINARY_SNIFF_BYTES` is the usual, cheap test —
 *  the same one git uses. */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true;
  return false;
}

/**
 * chokidar 5, loaded lazily so a profile that never opens a Files pane never
 * pays for it. `ignored` is a predicate, not a glob — chokidar 4 dropped glob
 * support and 5 kept it that way (`ChokidarOptions.ignored: Matcher`).
 */
async function defaultCreateWatcher(root: string): Promise<WatcherLike> {
  const chokidar = await import("chokidar");
  return chokidar.watch(root, {
    ignored: ignoredUnder(root),
    ignoreInitial: true,
    followSymlinks: false,
    depth: 12,
    // Editors write in stages (temp file, rename, truncate); without this the
    // pane sees three events per save and sometimes reads a half-written file.
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignorePermissionErrors: true,
  }) as unknown as WatcherLike;
}
