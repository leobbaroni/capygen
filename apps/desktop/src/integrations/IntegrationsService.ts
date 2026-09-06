/**
 * Settings ▸ Integrations, for all three backends (SPEC R20, R28-R30).
 *
 * This is the only place that knows *which* store answers a channel, and it
 * enforces the two rules the SPEC puts on that:
 *
 *  - **Every write is followed by a re-read.** The stores each re-read the file
 *    they just changed before returning a row; this service then invalidates
 *    the sync cache and runs a full `refresh`, so the settings page, the
 *    composer and the second window all see the same thing without polling.
 *  - **The backend's files are the source of truth.** Nothing here writes a
 *    row into SQLite as an authority; the cache is only ever a projection of
 *    what a store just read (`SyncCoordinator.persist`). The single exception
 *    is a `codex`/`api` **tool policy**, which has no backend file to live in
 *    (Codex has no per-tool permission list; the `api` backend has no config at
 *    all) and is therefore capygen's own row, enforced by capygen's own
 *    permission cards.
 *
 * **Which project?** `integrations.list` takes only `{backend}` — the contract
 * has no `projectId` — so the project-scope rows (`.mcp.json`,
 * `.claude/settings.local.json`, `.claude/skills`) are read for the
 * **most-recently-touched project**, which is the one the landing page and the
 * open session are already on (`projects.list` is ordered by `updated_at
 * DESC`). When that project changes, the watchers are re-pointed at the new
 * one. A profile with no project at all simply has no project-scope rows,
 * which is the truth.
 */
import type { CapygenStore } from "@capygen/db";
import {
  API_MCP_SETTINGS_KEY,
  ApiConfigStore,
  ClaudeConfigStore,
  CodexConfigStore,
  claudeWatchTargets,
  codexWatchTargets,
  resolveBackendHomes,
  type CliRunner,
  type FileIo,
  type IntegrationsSnapshot,
} from "@capygen/engine";
import type {
  Backend,
  InvokeArgs,
  InvokeResult,
  McpServerEntry,
  McpServerScope,
  ToolPolicyEntry,
} from "@capygen/shared";
import type { Broadcast, EngineLogger } from "../engine/types.js";
import { SyncCoordinator, type BackendSyncSource, type WatcherLike } from "./SyncCoordinator.js";

export interface IntegrationsDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Test seams — the real app passes none of these. */
  env?: Record<string, string | undefined>;
  home?: string;
  io?: FileIo;
  run?: CliRunner;
  claudeBin?: string;
  createWatcher?: (paths: string[]) => Promise<WatcherLike> | WatcherLike;
  ttlMs?: number;
  debounceMs?: number;
  /** Connect to a server and list its tools — `integrations.mcp.test`. */
  probeMcpServer?: (entry: McpServerEntry, projectPath: string | null) => Promise<string[]>;
  /** Reveal a skill file; injected because it needs Electron's `shell`. */
  openPath?: (target: string) => Promise<void> | void;
}

export class IntegrationsService {
  readonly sync: SyncCoordinator;
  private watchedProject: string | null | undefined;

  constructor(private readonly deps: IntegrationsDeps) {
    this.sync = new SyncCoordinator({
      store: deps.store,
      broadcast: deps.broadcast,
      log: deps.log,
      sources: {
        claude: this.source("claude"),
        codex: this.source("codex"),
        api: this.source("api"),
      },
      ...(deps.createWatcher ? { createWatcher: deps.createWatcher } : {}),
      ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
      ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
    });
  }

  async start(): Promise<void> {
    this.watchedProject = this.projectPath();
    await this.sync.start();
  }

  async dispose(): Promise<void> {
    await this.sync.dispose();
  }

  // -------------------------------------------------------------------------
  // stores
  // -------------------------------------------------------------------------

  /** The most-recently-touched project, or null. See this file's header. */
  projectPath(): string | null {
    try {
      return this.deps.store.projects.list()[0]?.path ?? null;
    } catch {
      return null;
    }
  }

  private homes(): { claude: string; codex: string; home: string } {
    return resolveBackendHomes(this.deps.env ?? process.env, this.deps.home);
  }

  claude(): ClaudeConfigStore {
    const homes = this.homes();
    return new ClaudeConfigStore({
      configDir: homes.claude,
      home: homes.home,
      projectPath: this.projectPath(),
      env: this.deps.env ?? process.env,
      ...(this.deps.io ? { io: this.deps.io } : {}),
      ...(this.deps.run ? { run: this.deps.run } : {}),
      ...(this.deps.claudeBin ? { claudeBin: this.deps.claudeBin } : {}),
      log: { info: (m) => this.deps.log.info(m), warn: (m) => this.deps.log.warn(m) },
    });
  }

  codex(): CodexConfigStore {
    return new CodexConfigStore({
      configDir: this.homes().codex,
      projectPath: this.projectPath(),
      ...(this.deps.io ? { io: this.deps.io } : {}),
      log: { info: (m) => this.deps.log.info(m), warn: (m) => this.deps.log.warn(m) },
    });
  }

  api(): ApiConfigStore {
    const settings = this.deps.store.settings;
    return new ApiConfigStore({
      own: {
        read: () => settings.getRaw<Record<string, unknown>>(API_MCP_SETTINGS_KEY, {}),
        write: (value) => settings.setRaw(API_MCP_SETTINGS_KEY, value),
      },
      // What an `api` agent would actually be handed (`loadMcpServers`'s
      // sources), read through the same stores so the settings page and the
      // agent cannot disagree.
      inherited: () => [...this.claude().read().mcpServers, ...this.codex().read().mcpServers],
    });
  }

  private source(backend: Backend): BackendSyncSource {
    if (backend === "claude") {
      return {
        read: () => this.claude().read(),
        watchTargets: () => claudeWatchTargets(this.claude().paths),
        // The two scopes Claude's own settings files own; a `session` rule is
        // capygen's and is never pruned by a re-sync.
        toolPolicyScopes: ["global", "project"],
      };
    }
    if (backend === "codex") {
      return {
        read: () => this.codex().read(),
        watchTargets: () => codexWatchTargets(this.codex().paths),
        toolPolicyScopes: [],
      };
    }
    return {
      read: () => this.api().read(),
      // The `api` backend's own servers live in SQLite, and its inherited ones
      // are already watched under `claude`/`codex` — watching them twice would
      // only double the refreshes.
      watchTargets: () => [],
      toolPolicyScopes: [],
    };
  }

  // -------------------------------------------------------------------------
  // channels
  // -------------------------------------------------------------------------

  list(args: InvokeArgs<"integrations.list">): InvokeResult<"integrations.list"> {
    this.retargetIfProjectMoved();
    const snapshot = this.sync.snapshot(args.backend);
    return {
      mcpServers: snapshot.mcpServers,
      plugins: snapshot.plugins,
      skills: snapshot.skills,
      // A backend with no permission file of its own still has capygen's rows
      // (see this file's header) — those come from the cache, not the store.
      tools: this.toolPolicies(args.backend, snapshot),
      lastSync: this.sync.lastSyncAt(args.backend),
    };
  }

  private toolPolicies(backend: Backend, snapshot: IntegrationsSnapshot): ToolPolicyEntry[] {
    if (backend === "claude") {
      const own = this.deps.store.toolPolicies
        .listByBackend(backend)
        .filter((entry) => entry.scope === "session");
      return [...snapshot.tools, ...own];
    }
    return this.deps.store.toolPolicies.listByBackend(backend);
  }

  async mcpAdd(args: InvokeArgs<"integrations.mcp.add">): Promise<McpServerEntry> {
    const entry = await this.dispatchMcpAdd(args.backend, args.scope, args.entry);
    await this.afterWrite(args.backend);
    return entry;
  }

  private dispatchMcpAdd(
    backend: Backend,
    scope: McpServerScope,
    draft: InvokeArgs<"integrations.mcp.add">["entry"],
  ): Promise<McpServerEntry> | McpServerEntry {
    if (backend === "claude") return this.claude().addMcpServer(scope, draft);
    if (backend === "codex") return this.codex().addMcpServer(scope, draft);
    return this.api().addMcpServer(scope, draft);
  }

  async mcpUpdate(args: InvokeArgs<"integrations.mcp.update">): Promise<McpServerEntry> {
    const entry =
      args.backend === "claude"
        ? await this.claude().updateMcpServer(args.scope, args.name, args.patch)
        : args.backend === "codex"
          ? this.codex().updateMcpServer(args.scope, args.name, args.patch)
          : this.api().updateMcpServer(args.scope, args.name, args.patch);
    await this.afterWrite(args.backend);
    return entry;
  }

  async mcpRemove(args: InvokeArgs<"integrations.mcp.remove">): Promise<{ ok: boolean }> {
    const result =
      args.backend === "claude"
        ? await this.claude().removeMcpServer(args.scope, args.name)
        : args.backend === "codex"
          ? this.codex().removeMcpServer(args.scope, args.name)
          : this.api().removeMcpServer(args.scope, args.name);
    await this.afterWrite(args.backend);
    return result;
  }

  /**
   * `integrations.mcp.test` — a **live** connect-and-list, never a cache read.
   *
   * For `claude` this also asks the CLI, because a claude.ai cloud connector
   * exists in no file capygen can reach and `claude mcp list` is the only thing
   * that knows whether it is authenticated. When capygen can reach the server
   * itself (a stdio or HTTP entry), its own MCP client is preferred: it returns
   * the tool *names*, which the CLI's one-line status never does.
   */
  async mcpTest(
    args: InvokeArgs<"integrations.mcp.test">,
  ): Promise<InvokeResult<"integrations.mcp.test">> {
    const snapshot = this.sync.snapshot(args.backend);
    const entry = snapshot.mcpServers.find(
      (candidate) =>
        candidate.name === args.name && (args.scope === undefined || candidate.scope === args.scope),
    );
    if (!entry) {
      return { ok: false, status: "unknown", error: `no MCP server named "${args.name}"` };
    }
    if (this.deps.probeMcpServer && entry.transport !== "claudeai-proxy") {
      try {
        const tools = await this.deps.probeMcpServer(entry, this.projectPath());
        return { ok: true, status: "connected", tools };
      } catch (err) {
        // Fall through to the CLI only for Claude; for the others this *is*
        // the answer, and it must carry the real message (SPEC §Edge Cases).
        if (args.backend !== "claude") {
          return { ok: false, status: "failed", error: describe(err) };
        }
        this.deps.log.warn(`[integrations] probing ${entry.name}: ${describe(err)}`);
      }
    }
    if (args.backend === "claude") {
      const rows = await this.claude().liveMcpStatus();
      const row = rows.find((candidate) => candidate.name === entry.name);
      if (row) return { ok: row.status === "connected", status: row.status };
    }
    return {
      ok: false,
      status: "unknown",
      error: "capygen has no way to reach this server from here",
    };
  }

  async pluginInstall(
    args: InvokeArgs<"integrations.plugin.install">,
  ): Promise<InvokeResult<"integrations.plugin.install">> {
    if (args.backend !== "claude") throw new Error(pluginsAreClaudeOnly(args.backend));
    const entry = await this.claude().installPlugin(args.marketplace, args.name);
    await this.afterWrite(args.backend);
    return entry;
  }

  async pluginUninstall(
    args: InvokeArgs<"integrations.plugin.uninstall">,
  ): Promise<{ ok: boolean }> {
    const result =
      args.backend === "claude"
        ? await this.claude().uninstallPlugin(args.name)
        : args.backend === "codex"
          ? this.codex().removePlugin(args.name)
          : (() => {
              throw new Error(pluginsAreClaudeOnly(args.backend));
            })();
    await this.afterWrite(args.backend);
    return result;
  }

  async pluginSetEnabled(
    args: InvokeArgs<"integrations.plugin.setEnabled">,
  ): Promise<InvokeResult<"integrations.plugin.setEnabled">> {
    const entry =
      args.backend === "claude"
        ? await this.claude().setPluginEnabled(args.name, args.enabled)
        : args.backend === "codex"
          ? this.codex().setPluginEnabled(args.name, args.enabled)
          : (() => {
              throw new Error(pluginsAreClaudeOnly(args.backend));
            })();
    await this.afterWrite(args.backend);
    return entry;
  }

  async marketplaces(
    args: InvokeArgs<"integrations.plugin.marketplaces">,
  ): Promise<InvokeResult<"integrations.plugin.marketplaces">> {
    if (args.backend === "claude") return this.claude().marketplaces();
    if (args.backend === "codex") return this.codex().read().marketplaces;
    return [];
  }

  async skillSetEnabled(
    args: InvokeArgs<"integrations.skill.setEnabled">,
  ): Promise<InvokeResult<"integrations.skill.setEnabled">> {
    const entry =
      args.backend === "claude"
        ? this.claude().setSkillEnabled(args.name, args.enabled, args.scope)
        : args.backend === "codex"
          ? this.codex().setSkillEnabled(args.name, args.enabled, args.scope)
          : (() => {
              throw new Error(
                "the api backend has no skill loader — a skill reaches an api agent as " +
                  "prompt text, not as a backend feature",
              );
            })();
    await this.afterWrite(args.backend);
    return entry;
  }

  async skillCreate(
    args: InvokeArgs<"integrations.skill.create">,
  ): Promise<InvokeResult<"integrations.skill.create">> {
    const entry =
      args.backend === "claude"
        ? this.claude().createSkill(args.scope, args.name, args.markdown)
        : args.backend === "codex"
          ? this.codex().createSkill(args.scope, args.name, args.markdown)
          : (() => {
              throw new Error("the api backend has no skill loader");
            })();
    await this.afterWrite(args.backend);
    return entry;
  }

  async skillOpen(args: InvokeArgs<"integrations.skill.open">): Promise<{ ok: boolean }> {
    if (!this.deps.openPath) throw new Error("integrations.skill.open: no shell is wired");
    await this.deps.openPath(args.path);
    return { ok: true };
  }

  /**
   * A `claude` policy is written into Claude's own `permissions` arrays so the
   * CLI honours it too (R29); every other backend/scope is capygen's own row.
   */
  async setToolPolicy(
    args: InvokeArgs<"integrations.tools.setPolicy">,
  ): Promise<ToolPolicyEntry> {
    const owned = args.backend === "claude" && args.scope !== "session";
    const entry: ToolPolicyEntry = owned
      ? this.claude().setToolPolicy(args.scope, args.pattern, args.decision)
      : this.deps.store.toolPolicies.upsert({
          backend: args.backend,
          scope: args.scope,
          pattern: args.pattern,
          decision: args.decision,
        });
    if (owned) await this.afterWrite(args.backend);
    return entry;
  }

  async removeToolPolicy(
    args: InvokeArgs<"integrations.tools.removePolicy">,
  ): Promise<{ ok: boolean }> {
    const owned = args.backend === "claude" && args.scope !== "session";
    const result = owned
      ? this.claude().removeToolPolicy(args.scope, args.pattern)
      : { ok: this.deps.store.toolPolicies.remove(args.backend, args.scope, args.pattern) };
    if (owned) await this.afterWrite(args.backend);
    return result;
  }

  async refresh(args: InvokeArgs<"integrations.refresh">): Promise<{ ok: boolean }> {
    this.retargetIfProjectMoved();
    this.sync.invalidate(args.backend);
    await this.sync.refresh(args.backend);
    return { ok: true };
  }

  /** Re-read and broadcast after any write (SPEC R20's round-trip rule). */
  private async afterWrite(backend: Backend): Promise<void> {
    this.sync.invalidate(backend);
    await this.sync.refresh(backend);
    // An `api` row can be inherited from either of the others, so a Claude or
    // Codex write moves the `api` view too.
    if (backend !== "api") {
      this.sync.invalidate("api");
      await this.sync.refresh("api");
    }
  }

  private retargetIfProjectMoved(): void {
    const current = this.projectPath();
    if (this.watchedProject === undefined || this.watchedProject === current) return;
    this.watchedProject = current;
    this.deps.log.info(`[integrations] project changed; re-pointing watchers at ${current ?? "(none)"}`);
    void this.sync.retarget().catch((err: unknown) => {
      this.deps.log.warn(`[integrations] retarget: ${describe(err)}`);
    });
  }
}

function pluginsAreClaudeOnly(backend: Backend): string {
  return (
    `the ${backend} backend has no plugin host capygen can drive — ` +
    "Claude Code's `claude plugin` CLI is the only one (PLAN A9)"
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
