/**
 * Two-way sync between the backends' own config files and capygen's cache
 * (SPEC R29, PLAN A14).
 *
 * The rule is "the backend's files are the source of truth", so nothing here
 * ever *invents* state: every row in `mcp_servers`/`plugins`/`skills`/
 * `policies` is a projection of what a store just read off disk, and the cache
 * exists only so `integrations.list` can answer without stat-ing forty files on
 * every keystroke.
 *
 * Three bounds, all of them SPEC R23-R26's "efficiency is a requirement":
 *
 *  - **TTL.** A snapshot is reused for `ttlMs` (5 s). The settings page, the
 *    composer and a second window all ask the same question while the user
 *    clicks around; they should not each cost a directory walk.
 *  - **Dedupe.** Concurrent `refresh(backend)` calls share one in-flight
 *    promise — a watcher firing while the user presses Refresh must not run the
 *    read twice and broadcast twice.
 *  - **Debounce.** A watcher event waits `debounceMs` (300 ms) before it
 *    triggers a refresh, because the CLIs write these files in stages: `claude
 *    mcp add` alone rewrites `.claude.json` *and* its own backup.
 *
 * And one honesty rule: `integrations.changed` is only broadcast for the kinds
 * whose lists actually differ (`changedKinds`). A watcher on `~/.claude.json`
 * fires for every unrelated session-bookkeeping write that file gets — which is
 * constantly — and a settings page that re-rendered each time would be unusable.
 */
import type { CapygenStore } from "@capygen/db";
import type { Backend, ToolPolicyScope } from "@capygen/shared";
import {
  changedKinds,
  emptySnapshot,
  type IntegrationKind,
  type IntegrationsSnapshot,
} from "@capygen/engine";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** The minimum of chokidar's `FSWatcher` this service uses (same as `FsService`). */
export interface WatcherLike {
  on(event: string, handler: (path: string) => void): unknown;
  close(): Promise<void> | void;
}

/** One backend's half of the coordinator. */
export interface BackendSyncSource {
  /** Read the backend's own files. Never throws — a store logs and returns []. */
  read: () => IntegrationsSnapshot;
  /** Files and directories whose change means "read again". */
  watchTargets: () => string[];
  /**
   * Which `policies` rows this backend's files own. Everything else in that
   * table is capygen's own (a `session` rule, or any rule for a backend with no
   * permission file — Codex has none) and is never pruned by a re-sync.
   */
  toolPolicyScopes: ToolPolicyScope[];
}

export interface SyncCoordinatorDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  sources: Record<Backend, BackendSyncSource>;
  /** Overridable in tests; the default loads chokidar 5 lazily. */
  createWatcher?: (paths: string[]) => Promise<WatcherLike> | WatcherLike;
  ttlMs?: number;
  debounceMs?: number;
  now?: () => number;
}

export const DEFAULT_SYNC_TTL_MS = 5_000;
export const DEFAULT_SYNC_DEBOUNCE_MS = 300;

interface CacheEntry {
  at: number;
  snapshot: IntegrationsSnapshot;
}

export class SyncCoordinator {
  private readonly cache = new Map<Backend, CacheEntry>();
  private readonly inFlight = new Map<Backend, Promise<IntegrationKind[]>>();
  private readonly watchers = new Map<Backend, Promise<WatcherLike>>();
  private readonly timers = new Map<Backend, NodeJS.Timeout>();
  /** Epoch ms of the last completed read — `TimestampSchema` is a number. */
  private readonly lastSync = new Map<Backend, number>();
  private readonly ttl: number;
  private readonly debounce: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly deps: SyncCoordinatorDeps) {
    this.ttl = deps.ttlMs ?? DEFAULT_SYNC_TTL_MS;
    this.debounce = deps.debounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
  }

  /** When this backend last completed a read; `null` until the first one. */
  lastSyncAt(backend: Backend): number | null {
    return this.lastSync.get(backend) ?? null;
  }

  /** The current view, from cache when it is fresh enough. */
  snapshot(backend: Backend): IntegrationsSnapshot {
    const cached = this.cache.get(backend);
    if (cached && this.now() - cached.at < this.ttl) return cached.snapshot;
    return this.readAndPersist(backend).snapshot;
  }

  /**
   * `integrations.refresh` and every post-write re-read: force a read, persist
   * it, and broadcast the kinds that moved. Concurrent callers share the one
   * read.
   */
  async refresh(backend: Backend): Promise<IntegrationKind[]> {
    const pending = this.inFlight.get(backend);
    if (pending) return pending;
    const run = (async (): Promise<IntegrationKind[]> => {
      const before = this.cache.get(backend)?.snapshot ?? emptySnapshot();
      const { snapshot, existed } = this.readAndPersist(backend);
      const kinds = existed ? changedKinds(before, snapshot) : [...(["mcpServers", "plugins", "skills", "tools"] as const)];
      if (kinds.length > 0 && !this.disposed) {
        this.deps.broadcast("integrations.changed", { backend, kinds });
      }
      return kinds;
    })().finally(() => {
      this.inFlight.delete(backend);
    });
    this.inFlight.set(backend, run);
    return run;
  }

  /** Start watching every backend's config paths (SPEC R29's "next open"). */
  async start(): Promise<void> {
    await Promise.all(
      (Object.keys(this.deps.sources) as Backend[]).map((backend) => this.watch(backend)),
    );
  }

  private async watch(backend: Backend): Promise<void> {
    if (this.watchers.has(backend)) return;
    const targets = this.deps.sources[backend]?.watchTargets() ?? [];
    if (targets.length === 0) return;
    const create = this.deps.createWatcher ?? defaultCreateWatcher;
    const starting = Promise.resolve(create(targets)).then((watcher) => {
      for (const kind of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
        watcher.on(kind, () => this.queue(backend));
      }
      watcher.on("error", (err: unknown) => {
        this.deps.log.warn(`[integrations] watcher ${backend}: ${String(err)}`);
      });
      return watcher;
    });
    this.watchers.set(backend, starting);
    try {
      await starting;
      this.deps.log.info(`[integrations] watching ${targets.length} path(s) for ${backend}`);
    } catch (err) {
      // A missing home is not an error: a machine without Codex has no
      // `~/.codex` to watch, and the settings page should still open.
      this.watchers.delete(backend);
      this.deps.log.warn(`[integrations] could not watch ${backend}: ${describe(err)}`);
    }
  }

  private queue(backend: Backend): void {
    if (this.disposed) return;
    const existing = this.timers.get(backend);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(backend);
      void this.refresh(backend).catch((err: unknown) => {
        this.deps.log.warn(`[integrations] refresh ${backend}: ${describe(err)}`);
      });
    }, this.debounce);
    timer.unref?.();
    this.timers.set(backend, timer);
  }

  private readAndPersist(backend: Backend): {
    snapshot: IntegrationsSnapshot;
    existed: boolean;
  } {
    const source = this.deps.sources[backend];
    const existed = this.cache.has(backend);
    if (!source) return { snapshot: emptySnapshot(), existed };
    let snapshot: IntegrationsSnapshot;
    try {
      snapshot = source.read();
    } catch (err) {
      // A backend whose config cannot be read contributes nothing rather than
      // failing the whole page (SPEC §Edge Cases: report, never swallow — the
      // report is the log line and an empty list the user can see is empty).
      this.deps.log.warn(`[integrations] reading ${backend}: ${describe(err)}`);
      snapshot = emptySnapshot();
    }
    this.persist(backend, source, snapshot);
    this.cache.set(backend, { at: this.now(), snapshot });
    this.lastSync.set(backend, this.now());
    return { snapshot, existed };
  }

  /**
   * Replace this backend's cached rows with what the files just said.
   *
   * A wholesale `DELETE … WHERE backend = ?` and re-insert, rather than a
   * per-row diff: the files are the truth, so a row capygen holds that the
   * files no longer mention is by definition stale. Only the policy scopes the
   * backend actually owns are cleared — capygen's own `session` rules, and
   * every rule for a backend with no permission file at all, survive.
   */
  private persist(
    backend: Backend,
    source: BackendSyncSource,
    snapshot: IntegrationsSnapshot,
  ): void {
    const { store } = this.deps;
    try {
      store.db.transaction(() => {
        store.db.run("DELETE FROM mcp_servers WHERE backend = ?", backend);
        store.db.run("DELETE FROM plugins WHERE backend = ?", backend);
        store.db.run("DELETE FROM skills WHERE backend = ?", backend);
        for (const scope of source.toolPolicyScopes) {
          store.db.run("DELETE FROM policies WHERE backend = ? AND scope = ?", backend, scope);
        }
        for (const entry of snapshot.mcpServers) store.mcpServers.upsert(entry);
        for (const entry of snapshot.plugins) store.plugins.upsert(entry);
        for (const entry of snapshot.skills) store.skills.upsert(entry);
        for (const entry of snapshot.tools) {
          if (!source.toolPolicyScopes.includes(entry.scope)) continue;
          store.toolPolicies.upsert(entry);
        }
      });
    } catch (err) {
      // The cache is an optimisation; losing it must not lose the read.
      this.deps.log.warn(`[integrations] caching ${backend}: ${describe(err)}`);
    }
  }

  /** Drop the memo for one backend so the next `snapshot` re-reads. */
  invalidate(backend: Backend): void {
    this.cache.delete(backend);
  }

  /**
   * Drop every backend's memo, **synchronously**.
   *
   * [review] `retarget()` also clears the cache, but only after it has awaited
   * each watcher's `close()`, and `IntegrationsService.retargetIfProjectMoved`
   * does not await it — so `integrations.list` read the previous project's
   * `.mcp.json`/`.claude/skills` rows out of a still-fresh cache entry for up
   * to `ttlMs` after the active project changed. Every project-scope row is
   * wrong in that window, which is exactly the class of thing R29 says the
   * files are the source of truth about.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Close and re-open every watcher, picking up the sources' current
   * `watchTargets()`. Called when the active project changes: `.mcp.json` and
   * `.claude/settings.local.json` live in the project, so the set of files
   * worth watching moves with it.
   */
  async retarget(): Promise<void> {
    if (this.disposed) return;
    for (const [backend, watcher] of this.watchers) {
      try {
        await (await watcher).close();
      } catch (err) {
        this.deps.log.warn(`[integrations] closing ${backend} watcher: ${describe(err)}`);
      }
    }
    this.watchers.clear();
    this.cache.clear();
    await this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [backend, watcher] of this.watchers) {
      try {
        await (await watcher).close();
      } catch (err) {
        this.deps.log.warn(`[integrations] closing ${backend} watcher: ${describe(err)}`);
      }
    }
    this.watchers.clear();
  }
}

/**
 * chokidar 5, loaded lazily. `depth: 2` because the deepest thing watched is a
 * skills directory's `<name>/SKILL.md`, and `ignoreInitial` because the first
 * read has already happened by the time a watcher attaches.
 */
async function defaultCreateWatcher(paths: string[]): Promise<WatcherLike> {
  const chokidar = await import("chokidar");
  const watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    followSymlinks: false,
    depth: 2,
    // These files are rewritten in stages (temp file + rename), and
    // `.claude.json` is 70 KB of bookkeeping the CLI touches constantly.
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    ignorePermissionErrors: true,
  });
  // Resolve on `ready`, not on the constructor. `chokidar.watch` returns
  // before its initial scan has finished, and with `ignoreInitial: true` a
  // change made during that window is **silently dropped** — measured on this
  // machine: the same edit that fires reliably after `ready` produced no event
  // at all when made immediately after the call. `main.ts` does not await
  // `start()` (the landing page's 3 s budget), so nothing is delayed by this;
  // it only means a watcher that says it is running really is.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    watcher.on("ready", done);
    watcher.on("error", done);
    // A path that cannot be watched at all must not hang start-up.
    const timer = setTimeout(done, WATCHER_READY_TIMEOUT_MS);
    timer.unref?.();
  });
  return watcher as unknown as WatcherLike;
}

/** How long `start()` waits for chokidar's initial scan before giving up on it. */
export const WATCHER_READY_TIMEOUT_MS = 10_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
