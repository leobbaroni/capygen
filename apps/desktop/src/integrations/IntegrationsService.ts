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
 * **Which project? (Phase 7-P0)** Every channel carries an optional explicit
 * `projectId`, and this service resolves it **once per request** into an
 * immutable `ProjectScope`:
 *
 *  - **omitted → global only.** The project-scope files (`.mcp.json`,
 *    `.claude/settings.local.json`, `<project>/.claude/skills`) are not read at
 *    all. It used to mean "the most-recently-touched project", which made every
 *    answer depend on which window last touched a session row: two windows on
 *    two projects read and wrote each other's scope.
 *  - **present → that project plus the globals.** A Project id names one
 *    concrete execution directory; a future worktree is a Project id of its own
 *    and must never resolve to its repository's root.
 *  - **unknown → refused**, before any read, write, probe or shell open.
 *  - a **project/local mutation needs one**: there is no implicit target.
 *
 * The scope is a value, not service state. Nothing here holds an "active
 * project", so an operation that awaits a dialog or a CLI finishes against the
 * project it started on even though another window has moved on.
 */
import path from "node:path";
import fs from "node:fs";
import type { CapygenStore } from "@capygen/db";
import {
  API_MCP_SETTINGS_KEY,
  ApiConfigStore,
  nodeFileIo,
  ClaudeConfigStore,
  CodexConfigStore,
  claudeWatchTargets,
  codexWatchTargets,
  resolveBackendHomes,
  resolveMcpServerConfigs,
  fromMcpServersObject,
  type ApiMcpSecrets,
  type CliRunner,
  type FileIo,
  type IntegrationsSnapshot,
  type McpServerConfig,
} from "@capygen/engine";
import type {
  Backend,
  InvokeArgs,
  InvokeResult,
  McpServerEntry,
  McpServerScope,
  ToolPolicyEntry,
} from "@capygen/shared";
import { assertNoInlineAgentMcpCredentials } from "@capygen/shared";
import { sharedSkillMetadataIo, type SharedSkillSource } from "../engine/sharedSkills.js";
import type { Broadcast, EngineLogger } from "../engine/types.js";
import { defaultConfirm } from "../prereqs/electronDefaults.js";
import type { ConfirmOptions } from "../prereqs/runGate.js";
import {
  pluginCancelled,
  pluginCommand,
  pluginConfirmOptions,
  type PluginGateAction,
} from "./installGate.js";
import {
  GLOBAL_SCOPE,
  SyncCoordinator,
  type BackendSyncSource,
  type ProjectScope,
  type WatcherLike,
} from "./SyncCoordinator.js";

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
  /** Bounds on the project watcher pool; see `SyncCoordinator`. Test seams. */
  maxProjectWatchers?: number;
  watchRetryCooldownMs?: number;
  now?: () => number;
  /** Connect to a server and list its tools — `integrations.mcp.test`. */
  probeMcpServer?: (entry: McpServerConfig, projectPath: string | null) => Promise<string[]>;
  /** Reveal a skill file; injected because it needs Electron's `shell`. */
  openPath?: (target: string) => Promise<void> | void;
  /**
   * The R27 gate for `plugin.install`/`plugin.uninstall`: resolves `true` only
   * when the user clicked the affirmative button. Defaults to the same native
   * `dialog.showMessageBox` the setup panel uses (`prereqs/electronDefaults`),
   * so the gate exists with no wiring in `main.ts`; a test injects a fake.
   */
  confirmInstall?: (options: ConfirmOptions) => Promise<boolean>;
  /** Main-process-only encrypted references for API-owned MCP values. */
  mcpSecrets?: ApiMcpSecrets;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Where the thing a write touched actually lives — which decides what has to be
 * re-read, not the `projectId` the caller happened to send. `global` is the
 * backend's own home files (`~/.claude.json`, `settings.json`,
 * `installed_plugins.json`, `config.toml`, capygen's own SQLite rows);
 * `project` is the selected project's directory, or its node inside
 * `.claude.json` (a `local`-scope MCP server).
 */
type WriteReach = "global" | "project";

export class IntegrationsService {
  readonly sync: SyncCoordinator;

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
      ...(deps.maxProjectWatchers !== undefined
        ? { maxProjectWatchers: deps.maxProjectWatchers }
        : {}),
      ...(deps.watchRetryCooldownMs !== undefined
        ? { watchRetryCooldownMs: deps.watchRetryCooldownMs }
        : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  async start(): Promise<void> {
    await this.sync.start();
  }

  async dispose(): Promise<void> {
    await this.sync.dispose();
  }

  // -------------------------------------------------------------------------
  // stores
  // -------------------------------------------------------------------------

  /**
   * Resolve one request's `projectId` into the scope it runs in, once, before
   * anything is read or written.
   *
   * `undefined` is the global-only scope. A string that names no project row
   * throws — the caller asked about a project that does not exist, and
   * answering with the globals (or with somebody else's project) would be a
   * silently wrong answer to a specific question.
   */
  scopeFor(projectId: string | undefined): ProjectScope {
    if (projectId === undefined) return GLOBAL_SCOPE;
    const project = this.deps.store.projects.get(projectId);
    if (!project) {
      throw new Error(
        `unknown project "${projectId}": capygen has no project with that id, so there is ` +
          "no directory to read or write for it",
      );
    }
    return { projectId: project.id, projectPath: project.path };
  }

  /**
   * The scope a project/local mutation needs. Writing `.mcp.json`,
   * `.claude/settings.local.json` or a project skill has no implicit target:
   * without an explicit id there is nothing to write *to*, and picking the
   * most-recent project would write into whichever directory another window
   * happened to touch last.
   */
  private mutationScope(projectId: string | undefined, what: string): ProjectScope {
    const scope = this.scopeFor(projectId);
    if (scope.projectPath === null) {
      throw new Error(
        `a ${what} needs an explicit project: send \`projectId\` with this request ` +
          "(capygen never picks a project for you)",
      );
    }
    return scope;
  }

  private homes(): { claude: string; codex: string; home: string } {
    return resolveBackendHomes(this.deps.env ?? process.env, this.deps.home);
  }

  sharedSkillSources(projectId?: string): SharedSkillSource[] {
    const scope = this.scopeFor(projectId);
    const homes = this.homes();
    const claudePaths = this.claude(scope).paths;
    const codexPaths = this.codex(scope).paths;
    const rootsFor = (paths: typeof claudePaths | typeof codexPaths) => [paths.userSkillsDir, path.join(paths.configDir, "plugins"), ...(paths.projectSkillsDir ? [paths.projectSkillsDir] : [])];
    const claudeRoots = rootsFor(claudePaths), codexRoots = rootsFor(codexPaths);
    const base = this.deps.io ?? nodeFileIo;
    const claude = new ClaudeConfigStore({ configDir: homes.claude, home: homes.home, env: this.deps.env ?? process.env, projectPath: scope.projectPath, io: sharedSkillMetadataIo(base, claudeRoots) }).read();
    const codex = new CodexConfigStore({ configDir: homes.codex, projectPath: scope.projectPath, io: sharedSkillMetadataIo(base, codexRoots) }).read();
    return [{ skills: claude.skills, plugins: claude.plugins, roots: claudeRoots }, { skills: codex.skills, plugins: codex.plugins, roots: codexRoots }];
  }

  claude(scope: ProjectScope = GLOBAL_SCOPE): ClaudeConfigStore {
    const homes = this.homes();
    return new ClaudeConfigStore({
      configDir: homes.claude,
      home: homes.home,
      projectPath: scope.projectPath,
      env: this.deps.env ?? process.env,
      ...(this.deps.io ? { io: this.deps.io } : {}),
      ...(this.deps.run ? { run: this.deps.run } : {}),
      ...(this.deps.claudeBin ? { claudeBin: this.deps.claudeBin } : {}),
      log: { info: (m) => this.deps.log.info(m), warn: (m) => this.deps.log.warn(m) },
    });
  }

  codex(scope: ProjectScope = GLOBAL_SCOPE): CodexConfigStore {
    return new CodexConfigStore({
      configDir: this.homes().codex,
      projectPath: scope.projectPath,
      ...(this.deps.io ? { io: this.deps.io } : {}),
      log: { info: (m) => this.deps.log.info(m), warn: (m) => this.deps.log.warn(m) },
    });
  }

  api(scope: ProjectScope = GLOBAL_SCOPE): ApiConfigStore {
    const settings = this.deps.store.settings;
    return new ApiConfigStore({
      own: {
        read: () => settings.getRaw<Record<string, unknown>>(API_MCP_SETTINGS_KEY, {}),
        write: (value) => settings.setRaw(API_MCP_SETTINGS_KEY, value),
      },
      // What an `api` agent would actually be handed (`loadMcpServers`'s
      // sources), read through the same stores so the settings page and the
      // agent cannot disagree.
      inherited: () => [
        ...this.claude(scope).read().mcpServers,
        ...this.codex(scope).read().mcpServers,
      ],
      ...(this.deps.mcpSecrets ? { secrets: this.deps.mcpSecrets } : {}),
    });
  }

  /**
   * Resolve the exact server snapshot a harness lifecycle captures. Every home
   * and project path comes from this service's explicit scope; no caller can
   * fall through to os.homedir().
   */
  resolveMcpServers(args: {
    backend: Backend;
    projectId?: string;
    agentConfig?: unknown;
  }): McpServerConfig[] {
    const scope = this.scopeFor(args.projectId);
    assertNoInlineAgentMcpCredentials(
      { [args.backend]: args.agentConfig } as import("@capygen/shared").AgentConfig,
    );
    const config = asRecord(args.agentConfig);
    const agent = fromMcpServersObject(config?.mcpServers, "agent");
    const claude = args.backend === "api" || args.backend === "claude"
      ? this.claude(scope).runtimeMcpServers()
      : [];
    const codex = args.backend === "api" || args.backend === "codex"
      ? this.codex(scope).runtimeMcpServers()
      : [];
    return resolveMcpServerConfigs({
      backend: args.backend,
      agent,
      api: args.backend === "api" ? this.api(scope).runtimeMcpServers() : [],
      claude,
      codex,
    });
  }

  private source(backend: Backend): BackendSyncSource {
    if (backend === "claude") {
      return {
        read: (scope) => this.claude(scope).read(),
        watchTargets: (scope) => claudeWatchTargets(this.claude(scope).paths),
        // The two scopes Claude's own settings files own; a `session` rule is
        // capygen's and is never pruned by a re-sync.
        toolPolicyScopes: ["global", "project"],
      };
    }
    if (backend === "codex") {
      return {
        read: (scope) => this.codex(scope).read(),
        watchTargets: (scope) => codexWatchTargets(this.codex(scope).paths),
        toolPolicyScopes: [],
      };
    }
    return {
      read: (scope) => this.api(scope).read(),
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
    const scope = this.scopeFor(args.projectId);
    this.watchForRead(args.backend, scope);
    const snapshot = this.sync.snapshot(args.backend, scope);
    return {
      mcpServers: snapshot.mcpServers,
      plugins: snapshot.plugins,
      skills: snapshot.skills,
      // A backend with no permission file of its own still has capygen's rows
      // (see this file's header) — those come from the cache, not the store.
      tools: this.toolPolicies(args.backend, snapshot),
      lastSync: this.sync.lastSyncAt(args.backend, scope),
    };
  }

  /** Only canonical backend directories can reach the shell; never a renderer path. */
  async openFolder(args: InvokeArgs<"integrations.openFolder">): Promise<{ ok: boolean }> {
    if (!this.deps.openPath) throw new Error("Folder opening is unavailable in this host.");
    const paths = args.backend === "claude" ? this.claude().paths : this.codex().paths;
    const directory = args.kind === "skills" ? paths.userSkillsDir
      : args.kind === "plugins" ? path.join(paths.configDir, "plugins")
      : args.backend === "claude" ? path.dirname(this.claude().paths.globalConfig)
      : path.dirname(this.codex().paths.configToml);
    // Missing child folders fall back to their existing backend directory. Opening
    // a folder never creates configuration or installs a backend as a side effect.
    let target = directory;
    if (!fs.existsSync(target) && args.kind !== "mcp") target = paths.configDir;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("This backend configuration folder does not exist yet. Set up the backend first.");
    }
    await this.deps.openPath(target);
    return { ok: true };
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
    const { scope, reach } = this.scopeForMcpWrite(args.scope, args.projectId);
    const entry = await this.dispatchMcpAdd(args.backend, args.scope, args.entry, scope);
    await this.afterWrite(args.backend, scope, reach);
    return entry;
  }

  /**
   * A `project`/`local` MCP server lives in (or is keyed by) the project
   * directory, so those scopes need an explicit id and are re-read per project;
   * `user`/`plugin` land in the backend's own home files and are global no
   * matter which project the window that asked was on.
   */
  private scopeForMcpWrite(
    mcpScope: McpServerScope,
    projectId: string | undefined,
  ): { scope: ProjectScope; reach: WriteReach } {
    if (mcpScope === "project" || mcpScope === "local") {
      return {
        scope: this.mutationScope(projectId, `${mcpScope}-scope MCP server`),
        reach: "project",
      };
    }
    return { scope: this.scopeFor(projectId), reach: "global" };
  }

  private dispatchMcpAdd(
    backend: Backend,
    mcpScope: McpServerScope,
    draft: InvokeArgs<"integrations.mcp.add">["entry"],
    scope: ProjectScope,
  ): Promise<McpServerEntry> | McpServerEntry {
    if (backend === "claude") return this.claude(scope).addMcpServer(mcpScope, draft);
    if (backend === "codex") return this.codex(scope).addMcpServer(mcpScope, draft);
    return this.api(scope).addMcpServer(mcpScope, draft);
  }

  async mcpUpdate(args: InvokeArgs<"integrations.mcp.update">): Promise<McpServerEntry> {
    const { scope, reach } = this.scopeForMcpWrite(args.scope, args.projectId);
    const entry =
      args.backend === "claude"
        ? await this.claude(scope).updateMcpServer(args.scope, args.name, args.patch)
        : args.backend === "codex"
          ? this.codex(scope).updateMcpServer(args.scope, args.name, args.patch)
          : this.api(scope).updateMcpServer(args.scope, args.name, args.patch);
    await this.afterWrite(args.backend, scope, reach);
    return entry;
  }

  async mcpRemove(args: InvokeArgs<"integrations.mcp.remove">): Promise<{ ok: boolean }> {
    const { scope, reach } = this.scopeForMcpWrite(args.scope, args.projectId);
    const result =
      args.backend === "claude"
        ? await this.claude(scope).removeMcpServer(args.scope, args.name)
        : args.backend === "codex"
          ? this.codex(scope).removeMcpServer(args.scope, args.name)
          : this.api(scope).removeMcpServer(args.scope, args.name);
    await this.afterWrite(args.backend, scope, reach);
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
    const scope = this.scopeFor(args.projectId);
    const snapshot = this.sync.snapshot(args.backend, scope);
    const entry = snapshot.mcpServers.find(
      (candidate) =>
        candidate.name === args.name && (args.scope === undefined || candidate.scope === args.scope),
    );
    if (!entry) {
      return { ok: false, status: "unknown", error: `no MCP server named "${args.name}"` };
    }
    if (this.deps.probeMcpServer && entry.transport !== "claudeai-proxy") {
      try {
        const runtimeEntry = this.resolveMcpServers({
          backend: args.backend,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
        }).find((candidate) => candidate.name === entry.name);
        if (!runtimeEntry) throw new Error(`MCP server "${entry.name}" is disabled or unavailable`);
        const tools = await this.deps.probeMcpServer(runtimeEntry, scope.projectPath);
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
      const rows = await this.claude(scope).liveMcpStatus();
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
    const scope = this.scopeFor(args.projectId);
    const id = args.name.includes("@") ? args.name : `${args.name}@${args.marketplace}`;
    await this.confirmPluginCommand("install", id);
    const entry = await this.claude(scope).installPlugin(args.marketplace, args.name);
    // A plugin is installed into the backend's own home, never into a project.
    await this.afterWrite(args.backend, scope, "global");
    return entry;
  }

  async pluginUninstall(
    args: InvokeArgs<"integrations.plugin.uninstall">,
  ): Promise<{ ok: boolean }> {
    if (args.backend === "api") throw new Error(pluginsAreClaudeOnly(args.backend));
    const scope = this.scopeFor(args.projectId);
    await this.confirmPluginCommand("uninstall", args.name);
    const result =
      args.backend === "claude"
        ? await this.claude(scope).uninstallPlugin(args.name)
        : this.codex(scope).removePlugin(args.name);
    await this.afterWrite(args.backend, scope, "global");
    return result;
  }

  /**
   * SPEC R27 / CLAUDE.md: nothing is installed or uninstalled before this
   * resolves `true`. A dialog that throws reads the same as Cancel — "nothing
   * ran" is always the safe outcome of a broken gate — and the refusal carries
   * the exact command so the settings page can say what did not happen.
   */
  private async confirmPluginCommand(action: PluginGateAction, id: string): Promise<void> {
    const confirm = this.deps.confirmInstall ?? defaultConfirm;
    let approved: boolean;
    try {
      approved = await confirm(pluginConfirmOptions(action, id));
    } catch (err) {
      this.deps.log.warn(`[integrations] plugin ${action} confirm failed: ${describe(err)}`);
      approved = false;
    }
    if (!approved) {
      this.deps.log.info(`[integrations] cancelled: \`${pluginCommand(action, id)}\``);
      throw new Error(pluginCancelled(action, id));
    }
    this.deps.log.info(`[integrations] confirmed: \`${pluginCommand(action, id)}\``);
  }

  async pluginSetEnabled(
    args: InvokeArgs<"integrations.plugin.setEnabled">,
  ): Promise<InvokeResult<"integrations.plugin.setEnabled">> {
    const scope = this.scopeFor(args.projectId);
    const entry =
      args.backend === "claude"
        ? await this.claude(scope).setPluginEnabled(args.name, args.enabled)
        : args.backend === "codex"
          ? this.codex(scope).setPluginEnabled(args.name, args.enabled)
          : (() => {
              throw new Error(pluginsAreClaudeOnly(args.backend));
            })();
    await this.afterWrite(args.backend, scope, "global");
    return entry;
  }

  async marketplaces(
    args: InvokeArgs<"integrations.plugin.marketplaces">,
  ): Promise<InvokeResult<"integrations.plugin.marketplaces">> {
    const scope = this.scopeFor(args.projectId);
    if (args.backend === "claude") return this.claude(scope).marketplaces();
    if (args.backend === "codex") return this.codex(scope).read().marketplaces;
    return [];
  }

  async skillSetEnabled(
    args: InvokeArgs<"integrations.skill.setEnabled">,
  ): Promise<InvokeResult<"integrations.skill.setEnabled">> {
    // `skillOverrides` for a project skill live in the project's settings file;
    // a user skill's override is in the backend's home settings.
    const reach: WriteReach = args.scope === "project" ? "project" : "global";
    const scope =
      args.scope === "project"
        ? this.mutationScope(args.projectId, "project-scope skill")
        : this.scopeFor(args.projectId);
    const entry =
      args.backend === "claude"
        ? this.claude(scope).setSkillEnabled(args.name, args.enabled, args.scope)
        : args.backend === "codex"
          ? this.codex(scope).setSkillEnabled(args.name, args.enabled, args.scope)
          : (() => {
              throw new Error(
                "the api backend has no skill loader — a skill reaches an api agent as " +
                  "prompt text, not as a backend feature",
              );
            })();
    await this.afterWrite(args.backend, scope, reach);
    return entry;
  }

  async skillCreate(
    args: InvokeArgs<"integrations.skill.create">,
  ): Promise<InvokeResult<"integrations.skill.create">> {
    const reach: WriteReach = args.scope === "project" ? "project" : "global";
    const scope =
      args.scope === "project"
        ? this.mutationScope(args.projectId, "project-scope skill")
        : this.scopeFor(args.projectId);
    const entry =
      args.backend === "claude"
        ? this.claude(scope).createSkill(args.scope, args.name, args.markdown)
        : args.backend === "codex"
          ? this.codex(scope).createSkill(args.scope, args.name, args.markdown)
          : (() => {
              throw new Error("the api backend has no skill loader");
            })();
    await this.afterWrite(args.backend, scope, reach);
    return entry;
  }

  /**
   * Reveal a skill file.
   *
   * [review] The path is checked against the skill files capygen has actually
   * read before it reaches the shell. `shell.openPath` launches whatever the
   * OS associates with the extension, so forwarding an arbitrary caller string
   * turns this channel into "run this program": the contract's schema is only
   * `{ path: string.min(1) }`, and contextIsolation protects a *clean*
   * renderer, not a compromised one. The allowlist is the current snapshot of
   * both backends that have skill files — the same list the page just rendered
   * the Open button from — so a legitimate click always matches.
   */
  async skillOpen(args: InvokeArgs<"integrations.skill.open">): Promise<{ ok: boolean }> {
    if (!this.deps.openPath) throw new Error("integrations.skill.open: no shell is wired");
    const scope = this.scopeFor(args.projectId);
    if (!this.isKnownSkillFile(args.path, scope)) {
      throw new Error(
        `integrations.skill.open refuses "${args.path}": it is not one of the skill files ` +
          "capygen lists (only a path from Settings ▸ Skills can be opened)",
      );
    }
    await this.deps.openPath(args.path);
    return { ok: true };
  }

  /** Case-insensitive path match against every skill the backends report. */
  private isKnownSkillFile(candidate: string, scope: ProjectScope): boolean {
    const wanted = normalizePath(candidate);
    // `api` has no skill loader, so only these two ever produce a path.
    for (const backend of ["claude", "codex"] as const) {
      for (const skill of this.sync.snapshot(backend, scope).skills) {
        if (normalizePath(skill.path) === wanted) return true;
      }
    }
    return false;
  }

  /**
   * A `claude` policy is written into Claude's own `permissions` arrays so the
   * CLI honours it too (R29); a `global` policy for the other backends is
   * capygen's own SQLite row.
   *
   * [review] **Every other combination is refused.** The `policies` table is
   * keyed by `(backend, scope, pattern)` and carries **no project or session
   * id**, so a `project`- or `session`-scope row for `codex`/`api` — and a
   * `session` row for `claude` — is a scoped promise the schema cannot keep:
   * it is one global row wearing a scope label, and the next project would read
   * (and overwrite) it. Storing it silently as if it were scoped is the exact
   * class of thing 7-P0 exists to remove, so until Phase 9 gives these rows a
   * real identity and an enforcement point, the write is refused with the
   * reason. Reading an existing row still works, and so does removing one, so
   * nothing already on disk becomes unreachable.
   */
  async setToolPolicy(
    args: InvokeArgs<"integrations.tools.setPolicy">,
  ): Promise<ToolPolicyEntry> {
    const native = args.backend === "claude" && args.scope !== "session";
    if (!native && args.scope !== "global") {
      throw new Error(unscopedToolPolicy(args.backend, args.scope));
    }
    const reach: WriteReach = native && args.scope === "project" ? "project" : "global";
    const scope =
      reach === "project"
        ? this.mutationScope(args.projectId, "project-scope tool policy")
        : this.scopeFor(args.projectId);
    const entry: ToolPolicyEntry = native
      ? this.claude(scope).setToolPolicy(args.scope, args.pattern, args.decision)
      : this.deps.store.toolPolicies.upsert({
          backend: args.backend,
          scope: args.scope,
          pattern: args.pattern,
          decision: args.decision,
        });
    if (native) await this.afterWrite(args.backend, scope, reach);
    return entry;
  }

  /** Removal is allowed at every scope, including the ones `setToolPolicy`
   *  refuses: a row written before this rule existed must stay deletable. */
  async removeToolPolicy(
    args: InvokeArgs<"integrations.tools.removePolicy">,
  ): Promise<{ ok: boolean }> {
    const native = args.backend === "claude" && args.scope !== "session";
    const reach: WriteReach = native && args.scope === "project" ? "project" : "global";
    const scope =
      reach === "project"
        ? this.mutationScope(args.projectId, "project-scope tool policy")
        : this.scopeFor(args.projectId);
    const result = native
      ? this.claude(scope).removeToolPolicy(args.scope, args.pattern)
      : { ok: this.deps.store.toolPolicies.remove(args.backend, args.scope, args.pattern) };
    if (native) await this.afterWrite(args.backend, scope, reach);
    return result;
  }

  async refresh(args: InvokeArgs<"integrations.refresh">): Promise<{ ok: boolean }> {
    const scope = this.scopeFor(args.projectId);
    this.watchForRead(args.backend, scope);
    this.sync.invalidate(args.backend, scope);
    await this.sync.refresh(args.backend, scope);
    return { ok: true };
  }

  /**
   * Start the watchers a read of `backend` in `scope` depends on.
   *
   * [review] The `api` backend watches **no files of its own** — its list is
   * its own SQLite servers plus everything it inherits from Claude and Codex —
   * so a window that only ever opens Settings ▸ MCP ▸ API for a project never
   * caused that project's `.mcp.json` or `.codex/` to be watched, and the
   * inherited half went stale until something else happened to look at it.
   */
  private watchForRead(backend: Backend, scope: ProjectScope): void {
    this.sync.ensureWatched(backend, scope);
    if (backend !== "api") return;
    this.sync.ensureWatched("claude", scope);
    this.sync.ensureWatched("codex", scope);
  }

  /**
   * Re-read and broadcast after a write (SPEC R20's round-trip rule).
   *
   * [review] **The reach is the resource's, not the request's.** The settings
   * page sends this window's selected project on every call, including a
   * `user`-scope MCP add or a plugin install, which land in the *global* files.
   * Keying the invalidation off `scope.projectId` therefore refreshed one
   * project and left every other project's snapshot — and the global one, and
   * the global SQLite projection — holding the pre-write content, while the
   * broadcast claimed the change belonged to that one project. A global write
   * is re-read at global scope, which drops every project snapshot of that
   * backend before it broadcasts (`SyncCoordinator.refresh`), re-persists the
   * global projection, and says `projectId: null` so every window reloads.
   */
  private async afterWrite(
    backend: Backend,
    scope: ProjectScope,
    reach: WriteReach,
  ): Promise<void> {
    const target = reach === "global" ? GLOBAL_SCOPE : scope;
    // `refresh` re-reads unconditionally, fans out to `api` (which inherits
    // from the other two) and, for a global read, invalidates every project
    // snapshot before broadcasting. It is deliberately not preceded by an
    // `invalidate`: that would drop the `before` snapshot the change diff is
    // computed against, and every write would claim all four kinds moved.
    await this.sync.refresh(backend, target);
  }
}

/** Why a scoped policy this schema cannot identify is refused (see above). */
function unscopedToolPolicy(backend: Backend, scope: string): string {
  return (
    `capygen cannot store a ${scope}-scope tool policy for the ${backend} backend: ` +
    "its policy rows have no project column, their natural key is " +
    "(backend, scope, pattern), and `session_id` is always written NULL — so the " +
    "rule would carry no project or session identity and would apply everywhere " +
    "while claiming to apply here. Claude's own permission files hold global and " +
    "project rules today; the rest arrive with Phase 9's permission engine."
  );
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

/** Windows paths compare case-insensitively and either slash is legal. */
function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, "\\").toLowerCase();
}
