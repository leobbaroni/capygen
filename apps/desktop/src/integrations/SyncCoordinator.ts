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

/**
 * One request's project scope (Phase 7-P0). `projectId` is `null` for the
 * global-only scope; `projectPath` is the concrete execution directory the
 * project-scope files live in. A scope value is built once per request and
 * never mutated, so an operation that awaits a slow CLI finishes against the
 * project it started on.
 */
export interface ProjectScope {
  projectId: string | null;
  projectPath: string | null;
}

/** The global-only scope — what an integrations call with no `projectId` gets. */
export const GLOBAL_SCOPE: ProjectScope = { projectId: null, projectPath: null };

/** Cache/watcher key: one entry per (backend, scope), never shared between them. */
export function scopeKey(backend: Backend, scope: ProjectScope): string {
  return `${backend}\u0000${scope.projectId ?? ""}`;
}

/** One backend's half of the coordinator. */
export interface BackendSyncSource {
  /** Read the backend's own files for this scope. Never throws — a store logs
   *  and returns []. */
  read: (scope: ProjectScope) => IntegrationsSnapshot;
  /** Files and directories whose change means "read again" for this scope. */
  watchTargets: (scope: ProjectScope) => string[];
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
  /** How many **project** scopes may hold watchers at once, per backend-set.
   *  Beyond this the least-recently-used project scope is closed. */
  maxProjectWatchers?: number;
  /** How long a (backend, scope) whose watcher failed to open waits before it
   *  is tried again. */
  watchRetryCooldownMs?: number;
}

export const DEFAULT_SYNC_TTL_MS = 5_000;
export const DEFAULT_SYNC_DEBOUNCE_MS = 300;
/**
 * [review] Project watchers used to grow without bound: every project a window
 * ever looked at kept a chokidar instance (and its OS handles) alive for the
 * life of the app. A session that visits fifty projects had fifty times three
 * backends of watchers on directories nobody is looking at. This is the cap on
 * **project** scopes; the global scopes are never evicted, because every read
 * layers on them.
 */
export const DEFAULT_MAX_PROJECT_WATCHERS = 8;
/** A watcher that could not be created is not retried on every keystroke. */
export const DEFAULT_WATCH_RETRY_COOLDOWN_MS = 30_000;

interface CacheEntry {
  at: number;
  snapshot: IntegrationsSnapshot;
}

/** A live watcher plus the scope it was opened for, so `dispose` can close it. */
interface WatchEntry {
  scope: ProjectScope;
  backend: Backend;
  watcher: Promise<WatcherLike>;
}

export class SyncCoordinator {
  /** Every map below is keyed by `scopeKey(backend, scope)`: a project read
   *  never shares a cache entry, an in-flight read, a watcher or a debounce
   *  timer with the global read or with another project. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<IntegrationKind[]>>();
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Epoch ms of the last completed read — `TimestampSchema` is a number. */
  private readonly lastSync = new Map<string, number>();
  /** `projectId` → when that project was last asked about, for LRU eviction. */
  private readonly projectLastUsed = new Map<string, number>();
  /** Key → when its watcher creation last failed, for the retry cooldown. */
  private readonly watchFailedAt = new Map<string, number>();
  private readonly ttl: number;
  private readonly debounce: number;
  private readonly maxProjectWatchers: number;
  private readonly retryCooldown: number;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly deps: SyncCoordinatorDeps) {
    this.ttl = deps.ttlMs ?? DEFAULT_SYNC_TTL_MS;
    this.debounce = deps.debounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.maxProjectWatchers = deps.maxProjectWatchers ?? DEFAULT_MAX_PROJECT_WATCHERS;
    this.retryCooldown = deps.watchRetryCooldownMs ?? DEFAULT_WATCH_RETRY_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;
  }

  /** When this backend/scope last completed a read; `null` until the first. */
  lastSyncAt(backend: Backend, scope: ProjectScope = GLOBAL_SCOPE): number | null {
    return this.lastSync.get(scopeKey(backend, scope)) ?? null;
  }

  /** The current view for one scope, from cache when it is fresh enough. */
  snapshot(backend: Backend, scope: ProjectScope = GLOBAL_SCOPE): IntegrationsSnapshot {
    const key = scopeKey(backend, scope);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttl) return cached.snapshot;
    return this.readAndPersist(backend, scope).snapshot;
  }

  /**
   * `integrations.refresh` and every post-write re-read: force a read for this
   * scope, persist it (global scope only — see `persist`), and broadcast the
   * kinds that moved. Concurrent callers **on the same scope** share the one
   * read; a different scope is a different read.
   *
   * Two fan-outs, both of them correctness rather than convenience:
   *
   *  - **A global read invalidates every project snapshot of that backend
   *    first.** Every project read layers on top of the global files, so a
   *    listener that reloads on this broadcast must not be served the project
   *    snapshot that was computed against the *previous* global content. The
   *    invalidation happens before the read, so it is in place before anything
   *    can act on the event.
   *  - **A `claude`/`codex` read moves `api` too.** The `api` backend's list is
   *    its own servers plus everything it inherits from the other two, and it
   *    watches no files of its own — so nothing else would ever tell an `api`
   *    listener that its inherited half changed.
   */
  async refresh(backend: Backend, scope: ProjectScope = GLOBAL_SCOPE): Promise<IntegrationKind[]> {
    const kinds = await this.refreshOne(backend, scope);
    if (backend !== "api") await this.refreshOne("api", scope);
    return kinds;
  }

  /**
   * One (backend, scope) read. Always re-reads — the caller does **not** need
   * to `invalidate` first, and must not: dropping the memo also drops the
   * `before` snapshot `changedKinds` diffs against, which turns every refresh
   * into a "everything changed" broadcast and makes the honesty rule at the top
   * of this file a no-op.
   */
  private async refreshOne(backend: Backend, scope: ProjectScope): Promise<IntegrationKind[]> {
    const key = scopeKey(backend, scope);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = (async (): Promise<IntegrationKind[]> => {
      // Before the read, so it is done before the broadcast this may produce.
      if (scope.projectId === null) this.invalidateProjectScopes(backend);
      const before = this.cache.get(key)?.snapshot ?? emptySnapshot();
      const { snapshot, existed } = this.readAndPersist(backend, scope);
      const kinds = existed ? changedKinds(before, snapshot) : [...(["mcpServers", "plugins", "skills", "tools"] as const)];
      if (kinds.length > 0 && !this.disposed) {
        this.deps.broadcast("integrations.changed", {
          backend,
          kinds,
          projectId: scope.projectId,
        });
      }
      return kinds;
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  /** Start watching every backend's **global** config paths (SPEC R29's "next
   *  open"). A project's paths are watched by `ensureWatched` the first time
   *  that project is actually asked about. */
  async start(): Promise<void> {
    await Promise.all(
      (Object.keys(this.deps.sources) as Backend[]).map((backend) =>
        this.watch(backend, GLOBAL_SCOPE),
      ),
    );
  }

  /**
   * Make sure this scope's files are watched, without making the caller wait
   * for chokidar's initial scan (`integrations.list` answers from a read it
   * has already done). Safe to call on every request: `watch` is a no-op once
   * the (backend, scope) pair has a watcher.
   */
  ensureWatched(backend: Backend, scope: ProjectScope): void {
    if (this.disposed || scope.projectId === null) return;
    this.projectLastUsed.set(scope.projectId, this.now());
    void this.watch(backend, scope).catch((err: unknown) => {
      this.deps.log.warn(`[integrations] watching ${backend} for a project: ${describe(err)}`);
    });
    this.evictColdProjects(scope.projectId);
  }

  /**
   * Close every watcher (and drop every snapshot) of the least-recently-used
   * projects once more than `maxProjectWatchers` of them are live.
   *
   * Eviction is by **project**, not by (backend, project): the three backends'
   * watchers on one project are opened together by one window looking at it,
   * and evicting half of them would leave a scope that is watched for `claude`
   * and silently stale for `codex`. The project currently being asked about is
   * never the victim.
   */
  private evictColdProjects(keep: string): void {
    const live = [...this.projectLastUsed.entries()]
      .filter(([id]) => id !== keep)
      .sort((a, b) => a[1] - b[1]);
    // +1 for the project we are keeping, which is not in `live`.
    let excess = live.length + 1 - this.maxProjectWatchers;
    for (const [projectId] of live) {
      if (excess <= 0) break;
      excess -= 1;
      this.projectLastUsed.delete(projectId);
      this.dropProject(projectId);
    }
  }

  /** Close the watchers, cancel the timers and drop the snapshots of one
   *  project, in every backend. Called by LRU eviction. */
  private dropProject(projectId: string): void {
    for (const backend of Object.keys(this.deps.sources) as Backend[]) {
      const key = scopeKey(backend, { projectId, projectPath: null });
      this.cache.delete(key);
      this.lastSync.delete(key);
      this.watchFailedAt.delete(key);
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      const entry = this.watchers.get(key);
      if (!entry) continue;
      this.watchers.delete(key);
      void (async () => {
        try {
          await (await entry.watcher).close();
        } catch (err) {
          this.deps.log.warn(`[integrations] closing ${backend} watcher: ${describe(err)}`);
        }
      })();
    }
    this.deps.log.info(`[integrations] released the watchers for project ${projectId}`);
  }

  /** How many projects currently hold watchers — the LRU's own size, exposed
   *  so a test can assert the bound rather than infer it. */
  watchedProjectCount(): number {
    return this.projectLastUsed.size;
  }

  private async watch(backend: Backend, scope: ProjectScope): Promise<void> {
    const key = scopeKey(backend, scope);
    if (this.disposed || this.watchers.has(key)) return;
    // [review] A path that cannot be watched (a project on a disconnected
    // network share, a directory the user has no rights to) used to be retried
    // by *every* `integrations.list`, so one bad project meant a failed
    // chokidar start per keystroke. Back off instead.
    const failedAt = this.watchFailedAt.get(key);
    if (failedAt !== undefined && this.now() - failedAt < this.retryCooldown) return;
    const source = this.deps.sources[backend];
    let targets = source?.watchTargets(scope) ?? [];
    if (scope.projectId !== null && source) {
      // Only the paths this project *adds*. A backend's own home files are
      // already watched by the global scope, whose refresh now invalidates
      // every project snapshot before it broadcasts — so watching them once
      // per open project would only cost N duplicate refreshes (and N
      // duplicate `integrations.changed` events, each claiming a project
      // scope) for one edit to `~/.claude.json`.
      const globalTargets = new Set(source.watchTargets(GLOBAL_SCOPE));
      targets = targets.filter((target) => !globalTargets.has(target));
    }
    if (targets.length === 0) return;
    const create = this.deps.createWatcher ?? defaultCreateWatcher;
    // An `async` wrapper, not `Promise.resolve(create(...))`: a factory that
    // throws **synchronously** (a path the OS refuses outright) would otherwise
    // escape past the failure handling below and reject `start()` itself.
    const starting = (async (): Promise<WatcherLike> => {
      const watcher = await create(targets);
      for (const kind of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
        watcher.on(kind, () => this.queue(backend, scope));
      }
      watcher.on("error", (err: unknown) => {
        this.deps.log.warn(`[integrations] watcher ${backend}: ${String(err)}`);
      });
      return watcher;
    })();
    // Registered before the await so a second concurrent `ensureWatched` for
    // the same pair joins this one instead of opening a second watcher.
    this.watchers.set(key, { backend, scope, watcher: starting });
    try {
      const watcher = await starting;
      // [review] `dispose()` may have run while chokidar was scanning. It
      // closed whatever was in the map at that moment; this entry has to close
      // itself, or a watcher outlives the service and its callbacks resurrect
      // refreshes (and broadcasts) after shutdown.
      if (this.disposed || this.watchers.get(key)?.watcher !== starting) {
        // Disposed, or evicted by the LRU while chokidar was still scanning.
        if (this.watchers.get(key)?.watcher === starting) this.watchers.delete(key);
        await watcher.close();
        return;
      }
      this.watchFailedAt.delete(key);
      this.deps.log.info(
        `[integrations] watching ${targets.length} path(s) for ${backend}` +
          `${scope.projectId ? ` in project ${scope.projectId}` : ""}`,
      );
    } catch (err) {
      // A missing home is not an error: a machine without Codex has no
      // `~/.codex` to watch, and the settings page should still open.
      if (this.watchers.get(key)?.watcher === starting) this.watchers.delete(key);
      this.watchFailedAt.set(key, this.now());
      this.deps.log.warn(`[integrations] could not watch ${backend}: ${describe(err)}`);
    }
  }

  private queue(backend: Backend, scope: ProjectScope): void {
    if (this.disposed) return;
    const key = scopeKey(backend, scope);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.disposed) return;
      void this.refresh(backend, scope).catch((err: unknown) => {
        this.deps.log.warn(`[integrations] refresh ${backend}: ${describe(err)}`);
      });
    }, this.debounce);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private readAndPersist(
    backend: Backend,
    scope: ProjectScope,
  ): {
    snapshot: IntegrationsSnapshot;
    existed: boolean;
  } {
    const key = scopeKey(backend, scope);
    const source = this.deps.sources[backend];
    const existed = this.cache.has(key);
    if (!source) return { snapshot: emptySnapshot(), existed };
    let snapshot: IntegrationsSnapshot;
    try {
      snapshot = source.read(scope);
    } catch (err) {
      // A backend whose config cannot be read contributes nothing rather than
      // failing the whole page (SPEC §Edge Cases: report, never swallow — the
      // report is the log line and an empty list the user can see is empty).
      this.deps.log.warn(`[integrations] reading ${backend}: ${describe(err)}`);
      snapshot = emptySnapshot();
    }
    this.persist(backend, source, snapshot, scope);
    this.cache.set(key, { at: this.now(), snapshot });
    this.lastSync.set(key, this.now());
    return { snapshot, existed };
  }

  /**
   * Replace this backend's cached rows with what the **global** files just said.
   *
   * A wholesale `DELETE … WHERE backend = ?` and re-insert, rather than a
   * per-row diff: the files are the truth, so a row capygen holds that the
   * files no longer mention is by definition stale. Only the policy scopes the
   * backend actually owns are cleared — capygen's own `session` rules, and
   * every rule for a backend with no permission file at all, survive.
   *
   * [7-P0] A **project** read is not persisted at all. These tables have one
   * row per (backend, scope, name) and no project column, so projecting one
   * project into them overwrote the global rows with that project's view — and
   * whichever window read last won. The projection exists to answer for the
   * globals cheaply; a project's answer is served from the in-memory
   * per-scope cache above and from the files themselves.
   */
  private persist(
    backend: Backend,
    source: BackendSyncSource,
    snapshot: IntegrationsSnapshot,
    scope: ProjectScope,
  ): void {
    if (scope.projectId !== null) return;
    const { store } = this.deps;
    try {
      store.db.transaction(() => {
        store.db.run("DELETE FROM mcp_servers WHERE backend = ?", backend);
        store.db.run("DELETE FROM plugins WHERE backend = ?", backend);
        store.db.run("DELETE FROM skills WHERE backend = ?", backend);
        for (const scopeName of source.toolPolicyScopes) {
          store.db.run("DELETE FROM policies WHERE backend = ? AND scope = ?", backend, scopeName);
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

  /** Drop the memo for one backend in one scope so the next `snapshot`
   *  re-reads. */
  invalidate(backend: Backend, scope: ProjectScope = GLOBAL_SCOPE): void {
    this.cache.delete(scopeKey(backend, scope));
  }

  /** Drop this backend's **project** memos, leaving the global one alone —
   *  what a global re-read has to do before it broadcasts. */
  private invalidateProjectScopes(backend: Backend): void {
    const globalKey = scopeKey(backend, GLOBAL_SCOPE);
    const prefix = `${backend}\u0000`;
    for (const key of [...this.cache.keys()]) {
      if (key !== globalKey && key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const entries = [...this.watchers.values()];
    this.watchers.clear();
    for (const entry of entries) {
      try {
        await (await entry.watcher).close();
      } catch (err) {
        this.deps.log.warn(`[integrations] closing ${entry.backend} watcher: ${describe(err)}`);
      }
    }
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
