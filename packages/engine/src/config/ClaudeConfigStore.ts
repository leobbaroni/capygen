/**
 * Claude Code's configuration, read as one merged view and written back into
 * Claude's own files (SPEC R20, R28, R29; PLAN A9/A14).
 *
 * Every surface below was verified against this machine's real installation on
 * 2026-09-06 (Claude Code 2.1.261) — the files by reading them, the CLI shapes
 * by running the read-only commands, and the three MCP scopes by running
 * `claude mcp add` against an isolated `CLAUDE_CONFIG_DIR`:
 *
 * | What | Read from | Written by |
 * |---|---|---|
 * | MCP, scope `user` | `.claude.json` → `mcpServers` | `claude mcp add/remove -s user` |
 * | MCP, scope `local` | `.claude.json` → `projects[<cwd>].mcpServers` | `claude mcp add/remove -s local` (cwd = project) |
 * | MCP, scope `project` | `<project>/.mcp.json` → `mcpServers` | that file, edited in place |
 * | MCP, scope `plugin` | a plugin's own manifest | nothing — capygen never edits a plugin's files |
 * | Tool policies | `permissions.{allow,deny,ask}` in the settings chain | `<configDir>/settings.json` (global) or `<project>/.claude/settings.local.json` (project) |
 * | Skills | `<configDir>/skills`, `<project>/.claude/skills`, each plugin's `skills/` | a `SKILL.md`, and `skillOverrides` for enable/disable |
 * | Plugins | `plugins/installed_plugins.json` + `enabledPlugins` | `claude plugin install/uninstall/enable/disable` |
 * | Marketplaces | `plugins/known_marketplaces.json` | `claude plugin marketplace add/remove` |
 *
 * **The CLI is preferred for `.claude.json`** and only for it. That file is a
 * 70 KB blob of session bookkeeping — onboarding flags, cached experiment
 * payloads, per-project trust dialogs — and re-serialising it to change one
 * `mcpServers` entry is a much larger blast radius than asking the tool that
 * owns it. `.mcp.json` is the opposite: three lines the repo checks in, so it
 * is edited directly and no child process is spawned to add a server.
 *
 * **`skillOverrides` is the real key**, not a capygen invention: the installed
 * SDK bundle declares it as `Record<string, "on" | "name-only" |
 * "user-invocable-only" | "off">` with the description "Per-skill listing
 * overrides keyed by skill name … `off` hides it from both. Absent = on." The
 * user's own `~/.claude/settings.local.json` already uses it. So no
 * enabled/disabled directory shuffling is needed, and capygen never moves a
 * user's skill files.
 */
import path from "node:path";
import type {
  McpServerEntry,
  McpServerEntryDraft,
  McpServerEntryPatch,
  McpServerScope,
  McpServerStatus,
  McpTransport,
  PluginEntry,
  PluginMarketplaceEntry,
  SkillEntry,
  SkillScope,
  ToolPolicyDecision,
  ToolPolicyEntry,
  ToolPolicyScope,
} from "@capygen/shared";
import type { EnvRecord } from "../env.js";
import {
  nodeCliRunner,
  parseJsonOutput,
  runCliOrThrow,
  type CliRunner,
  type RunCliOptions,
} from "./cli.js";
import {
  nodeFileIo,
  readJsonFile,
  readSkillFrontMatter,
  safeChildPath,
  updateJsonFile,
  type FileIo,
} from "./files.js";
import { claudePaths, claudeProjectKey, type ClaudePaths } from "./paths.js";
import type { ConfigStoreLogger, IntegrationsSnapshot } from "./types.js";

export interface ClaudeConfigStoreDeps {
  /** `~/.claude`, or whatever `CLAUDE_CONFIG_DIR` says (`resolveBackendHomes`). */
  configDir: string;
  /** The home directory `.claude.json` falls back to. */
  home: string;
  /** The session's project directory; absent means "user scope only". */
  projectPath?: string | null;
  io?: FileIo;
  run?: CliRunner;
  env?: EnvRecord;
  /** The `claude` executable; overridable so tests can point at a shim. */
  claudeBin?: string;
  log?: ConfigStoreLogger;
}

const NO_LOG: ConfigStoreLogger = { info: () => {}, warn: () => {} };

/**
 * The two things every sub-read of `read()` needs: the merged settings chain
 * and the parsed `.claude.json`. Built once per read pass and threaded down
 * (see `read()`), never memoized on the instance — a store outlives a watcher
 * tick and a cached parse would be exactly the stale-config bug R29 exists to
 * prevent.
 */
interface ClaudeReadContext {
  chain: { file: string; values: Record<string, unknown> }[];
  globalConfig: Record<string, unknown> | undefined;
}

/** `permissions.<bucket>` ⇄ `ToolPolicyDecision`. */
const DECISION_BUCKET: Record<ToolPolicyDecision, "allow" | "deny" | "ask"> = {
  allow: "allow",
  deny: "deny",
  ask: "ask",
};

export class ClaudeConfigStore {
  readonly paths: ClaudePaths;
  private readonly io: FileIo;
  private readonly run: CliRunner;
  private readonly log: ConfigStoreLogger;
  private readonly bin: string;
  private readonly env: EnvRecord;

  constructor(private readonly deps: ClaudeConfigStoreDeps) {
    this.io = deps.io ?? nodeFileIo;
    this.run = deps.run ?? nodeCliRunner;
    this.log = deps.log ?? NO_LOG;
    this.bin = deps.claudeBin ?? "claude";
    this.env = deps.env ?? process.env;
    this.paths = claudePaths({
      configDir: deps.configDir,
      home: deps.home,
      env: this.env,
      projectPath: deps.projectPath ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  /**
   * Everything Settings ▸ Integrations shows for `claude`, from files only —
   * no child process, so the settings page costs a directory walk rather than
   * a CLI spawn (R26). `liveMcpStatus`/`livePlugins`/`marketplaces` are the
   * opt-in CLI half.
   *
   * MCP servers come back in **scope order** (user → local → project →
   * plugin), which is the precedence a person reasons about when two files
   * name the same server, not alphabetical.
   */
  read(): IntegrationsSnapshot {
    // [review] One context per read, not one per sub-read. `settingsChain()`
    // parses up to four settings files and `.claude.json` is the 70 KB
    // bookkeeping blob described above; the previous shape re-read both once
    // per `.mcp.json` server (`mcpJsonApproved`) *and* again in each of
    // `readPlugins`/`readSkills`/`readToolPolicies`, so a project with N
    // project-scope servers cost roughly N+4 parses of the same bytes.
    const ctx = this.context();
    const plugins = this.readPlugins(ctx);
    return {
      mcpServers: this.readMcpServers(plugins, ctx),
      plugins,
      skills: this.readSkills(plugins, ctx),
      tools: this.readToolPolicies(ctx),
      marketplaces: this.readMarketplaces(),
    };
  }

  /** The files every sub-read shares, parsed once. */
  private context(): ClaudeReadContext {
    return {
      chain: this.settingsChain(),
      globalConfig: readJsonFile(this.io, this.paths.globalConfig, (m) =>
        this.log.warn(`[claude] ${m}`),
      ),
    };
  }

  /** `readMcpServers` over a freshly-read context — the shape every write's
   *  read-back needs. */
  private currentMcpServers(): McpServerEntry[] {
    const ctx = this.context();
    return this.readMcpServers(this.readPlugins(ctx), ctx);
  }

  /** `readSkills` over a freshly-read context (see `currentMcpServers`). */
  private currentSkills(): SkillEntry[] {
    const ctx = this.context();
    return this.readSkills(this.readPlugins(ctx), ctx);
  }

  /** The settings chain, lowest precedence first (user < project < local). */
  private settingsChain(): { file: string; values: Record<string, unknown> }[] {
    const files = [
      this.paths.userSettings,
      this.paths.userLocalSettings,
      this.paths.projectSettings,
      this.paths.projectLocalSettings,
    ].filter((file): file is string => file !== null);
    const out: { file: string; values: Record<string, unknown> }[] = [];
    for (const file of files) {
      const values = readJsonFile(this.io, file, (message) => this.log.warn(`[claude] ${message}`));
      if (values) out.push({ file, values });
    }
    return out;
  }

  private readMcpServers(
    plugins: PluginEntry[],
    ctx: ClaudeReadContext = this.context(),
  ): McpServerEntry[] {
    const out: McpServerEntry[] = [];
    const globalConfig = ctx.globalConfig;

    // user scope — `.claude.json` → mcpServers
    for (const entry of toEntries(globalConfig?.mcpServers, "user", this.paths.globalConfig)) {
      out.push(entry);
    }

    // local scope — `.claude.json` → projects[<cwd>].mcpServers
    const project = this.deps.projectPath ?? null;
    if (project) {
      const projects = asRecord(globalConfig?.projects);
      const key = claudeProjectKey(project);
      const node =
        asRecord(projects?.[key]) ??
        asRecord(
          Object.entries(projects ?? {}).find(
            ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
          )?.[1],
        );
      for (const entry of toEntries(node?.mcpServers, "local", this.paths.globalConfig)) {
        out.push(entry);
      }
    }

    // project scope — <project>/.mcp.json
    if (this.paths.projectMcpJson) {
      const mcpJson = readJsonFile(this.io, this.paths.projectMcpJson, (m) =>
        this.log.warn(`[claude] ${m}`),
      );
      for (const entry of toEntries(
        mcpJson?.mcpServers,
        "project",
        this.paths.projectMcpJson,
      )) {
        // `.mcp.json` servers are opt-in per project: `enabledMcpjsonServers` /
        // `disabledMcpjsonServers` (both real settings keys) decide whether the
        // CLI will even connect, so the row says so rather than claiming the
        // server is live.
        out.push({ ...entry, enabled: this.mcpJsonApproved(entry.name, ctx) });
      }
    }

    // plugin scope — read-only, from each installed plugin's own manifest
    for (const plugin of plugins) {
      if (!plugin.path) continue;
      const manifest = readJsonFile(
        this.io,
        path.join(plugin.path, ".claude-plugin", "plugin.json"),
      );
      const servers = asRecord(manifest?.mcpServers);
      if (!servers) continue;
      for (const entry of toEntries(servers, "plugin", `plugin:${plugin.name}`)) {
        out.push({ ...entry, enabled: plugin.enabled });
      }
    }

    return out;
  }

  /** Is a `.mcp.json` server approved for this project? (settings chain). */
  private mcpJsonApproved(name: string, ctx: ClaudeReadContext): boolean {
    let approved: boolean | null = null;
    for (const { values } of ctx.chain) {
      if (values.enableAllProjectMcpServers === true) approved = true;
      const enabled = asStringArray(values.enabledMcpjsonServers);
      const disabled = asStringArray(values.disabledMcpjsonServers);
      if (enabled?.includes(name)) approved = true;
      if (disabled?.includes(name)) approved = false;
    }
    // The project-scope trust flags also live in `.claude.json`'s project node,
    // which is where the CLI actually records an approval.
    const globalConfig = ctx.globalConfig;
    const project = this.deps.projectPath;
    if (project) {
      const node = asRecord(asRecord(globalConfig?.projects)?.[claudeProjectKey(project)]);
      if (asStringArray(node?.enabledMcpjsonServers)?.includes(name)) approved = true;
      if (asStringArray(node?.disabledMcpjsonServers)?.includes(name)) approved = false;
    }
    return approved ?? false;
  }

  private readPlugins(ctx: ClaudeReadContext = this.context()): PluginEntry[] {
    const installed = readJsonFile(this.io, this.paths.installedPlugins, (m) =>
      this.log.warn(`[claude] ${m}`),
    );
    const table = asRecord(installed?.plugins);
    if (!table) return [];

    // `enabledPlugins` is a settings key, merged along the whole chain.
    const enabled = new Map<string, boolean>();
    for (const { values } of ctx.chain) {
      const map = asRecord(values.enabledPlugins);
      if (!map) continue;
      for (const [id, value] of Object.entries(map)) {
        if (typeof value === "boolean") enabled.set(id, value);
        else if (value !== null && value !== undefined) enabled.set(id, true);
      }
    }

    const out: PluginEntry[] = [];
    for (const [id, raw] of Object.entries(table)) {
      const installs = Array.isArray(raw) ? raw : [raw];
      const first = asRecord(installs[0]);
      const installPath = str(first?.installPath);
      const marketplace = id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : undefined;
      out.push({
        backend: "claude",
        name: id,
        ...(str(first?.version) ? { version: str(first?.version) as string } : {}),
        ...(marketplace ? { marketplace } : {}),
        enabled: enabled.get(id) ?? true,
        installed: true,
        ...(installPath ? { path: installPath } : {}),
        commands: installPath ? this.pluginCommands(installPath) : [],
        skills: installPath ? this.io.listDirs(path.join(installPath, "skills")) : [],
        source: this.paths.installedPlugins,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private pluginCommands(installPath: string): string[] {
    const dir = path.join(installPath, "commands");
    const files = this.io.listDirs(dir);
    // `commands/` holds `.md` files, not directories, so `listDirs` finds
    // nothing; the names come from the skills dir plus any nested command
    // folders. A plugin's slash commands are also reported live by
    // `system/init.slash_commands`, which is the authority the slash menu uses
    // (R14) — this list is only Settings' "what does this plugin contain".
    return files;
  }

  private readSkills(
    plugins: PluginEntry[],
    ctx: ClaudeReadContext = this.context(),
  ): SkillEntry[] {
    const overrides = this.skillOverrides(ctx);
    const out: SkillEntry[] = [];

    const collect = (dir: string | null, scope: SkillScope, pluginName?: string): void => {
      if (!dir) return;
      for (const name of this.io.listDirs(dir)) {
        const file = path.join(dir, name, "SKILL.md");
        const text = this.io.read(file);
        if (text === undefined) continue;
        const front = readSkillFrontMatter(text);
        const skillName = front.name?.trim() || name;
        out.push({
          backend: "claude",
          name: skillName,
          scope,
          path: file,
          ...(pluginName ? { pluginName } : {}),
          enabled: overrides.get(skillName) !== "off",
          ...(front.description ? { description: front.description } : {}),
        });
      }
    };

    collect(this.paths.userSkillsDir, "user");
    collect(this.paths.projectSkillsDir, "project");
    for (const plugin of plugins) {
      if (!plugin.path) continue;
      collect(path.join(plugin.path, "skills"), "plugin", plugin.name);
    }
    return out;
  }

  /** The merged `skillOverrides` map across the whole settings chain. */
  private skillOverrides(ctx: ClaudeReadContext): Map<string, string> {
    const merged = new Map<string, string>();
    for (const { values } of ctx.chain) {
      const map = asRecord(values.skillOverrides);
      if (!map) continue;
      for (const [name, value] of Object.entries(map)) {
        if (typeof value === "string") merged.set(name, value);
      }
    }
    return merged;
  }

  private readToolPolicies(ctx: ClaudeReadContext = this.context()): ToolPolicyEntry[] {
    const out: ToolPolicyEntry[] = [];
    const seen = new Set<string>();
    const add = (pattern: string, decision: ToolPolicyDecision, scope: ToolPolicyScope): void => {
      const key = `${scope}:${pattern}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ backend: "claude", pattern, decision, scope });
    };
    const scopeOf = (file: string): ToolPolicyScope =>
      file === this.paths.userSettings || file === this.paths.userLocalSettings
        ? "global"
        : "project";

    for (const { file, values } of ctx.chain) {
      const permissions = asRecord(values.permissions);
      if (!permissions) continue;
      for (const decision of ["allow", "deny", "ask"] as const) {
        for (const pattern of asStringArray(permissions[decision]) ?? []) {
          add(pattern, decision, scopeOf(file));
        }
      }
    }
    return out;
  }

  private readMarketplaces(): PluginMarketplaceEntry[] {
    const known = readJsonFile(this.io, this.paths.knownMarketplaces, (m) =>
      this.log.warn(`[claude] ${m}`),
    );
    if (!known) return [];
    const out: PluginMarketplaceEntry[] = [];
    for (const [name, raw] of Object.entries(known)) {
      const record = asRecord(raw);
      const source = asRecord(record?.source);
      const url = str(source?.repo) ?? str(source?.url) ?? str(source?.path);
      out.push({
        name,
        ...(url ? { url } : {}),
        source: this.paths.knownMarketplaces,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // live status (`claude mcp list`)
  // -------------------------------------------------------------------------

  /**
   * Per-server connection status, and the claude.ai cloud connectors that exist
   * in no file at all (`claude.ai Higgsfield`, …).
   *
   * `claude mcp list` has **no `--json`** on 2.1.261 (verified: `claude mcp
   * list --help` lists only `-h`), so this parses its text. That is fragile by
   * construction, which is why it can only ever *enrich*: a line this does not
   * recognise leaves the server's status `undefined`, and the settings page
   * still lists everything the files said.
   */
  async liveMcpStatus(): Promise<{ name: string; status: McpServerStatus; target: string }[]> {
    const result = await this.run(this.bin, ["mcp", "list"], this.cliOptions());
    if (result.code !== 0) {
      this.log.warn(`[claude] mcp list exited ${result.code}: ${result.stderr.trim()}`);
      return [];
    }
    return parseMcpListOutput(result.stdout);
  }

  // -------------------------------------------------------------------------
  // writes — MCP
  // -------------------------------------------------------------------------

  async addMcpServer(scope: McpServerScope, draft: McpServerEntryDraft): Promise<McpServerEntry> {
    this.assertWritableMcpScope(scope, draft.name);
    if (scope === "project") {
      this.writeProjectMcpJson((servers) => {
        servers[draft.name] = mcpServerJson(draft);
      });
    } else {
      await runCliOrThrow(this.run, this.bin, this.mcpAddArgs(scope, draft), this.cliOptions());
    }
    const written = this.currentMcpServers().find(
      (entry) => entry.scope === scope && entry.name === draft.name,
    );
    if (!written) {
      throw new Error(
        `capygen added the MCP server "${draft.name}" (${scope}) but could not read it back`,
      );
    }
    return written;
  }

  async updateMcpServer(
    scope: McpServerScope,
    name: string,
    patch: McpServerEntryPatch,
  ): Promise<McpServerEntry> {
    this.assertWritableMcpScope(scope, name);
    if (patch.name !== undefined) this.assertWritableMcpScope(scope, patch.name);
    const existing = this.currentMcpServers().find(
      (entry) => entry.scope === scope && entry.name === name,
    );
    if (!existing) throw new Error(`no ${scope}-scope MCP server named "${name}" for claude`);
    const command = patch.command ?? existing.command;
    const args = patch.args ?? existing.args;
    const url = patch.url ?? existing.url;
    const env = patch.env ?? existing.env;
    const merged: McpServerEntryDraft = {
      name: patch.name ?? existing.name,
      transport: patch.transport ?? existing.transport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(env !== undefined ? { env } : {}),
      source: patch.source ?? existing.source,
      enabled: patch.enabled ?? existing.enabled,
    };
    if (scope === "project") {
      this.writeProjectMcpJson((servers) => {
        delete servers[name];
        servers[merged.name] = mcpServerJson(merged);
      });
    } else {
      // The CLI has no `mcp update`: remove then add is what `claude mcp add`
      // itself does for an existing name, and doing it in this order means a
      // rename cannot leave two rows behind.
      await this.run(this.bin, ["mcp", "remove", name, "-s", scope], this.cliOptions());
      await runCliOrThrow(this.run, this.bin, this.mcpAddArgs(scope, merged), this.cliOptions());
    }
    const written = this.currentMcpServers().find(
      (entry) => entry.scope === scope && entry.name === merged.name,
    );
    if (!written) {
      throw new Error(`capygen updated "${name}" (${scope}) but could not read it back`);
    }
    return written;
  }

  async removeMcpServer(scope: McpServerScope, name: string): Promise<{ ok: boolean }> {
    this.assertWritableMcpScope(scope, name);
    if (scope === "project") {
      this.writeProjectMcpJson((servers) => {
        delete servers[name];
      });
    } else {
      await runCliOrThrow(
        this.run,
        this.bin,
        ["mcp", "remove", name, "-s", scope],
        this.cliOptions(),
      );
    }
    const still = this.currentMcpServers().some(
      (entry) => entry.scope === scope && entry.name === name,
    );
    return { ok: !still };
  }

  private assertWritableMcpScope(scope: McpServerScope, name?: string): void {
    // [review] `user` and `local` reach the `claude` CLI, where the name is a
    // bare positional *before* the `--` separator — so a name starting with
    // `-` is read by the CLI's own option parser rather than as the name, and
    // the command that runs is not the command capygen built. `project` scope
    // is a JSON key in `.mcp.json` and is left alone, so a server registered
    // outside capygen under an odd name is still removable from the UI.
    if (name !== undefined && scope !== "project" && scope !== "plugin") {
      assertCliPositional("MCP server", name);
    }
    if (scope === "plugin") {
      throw new Error(
        "plugin-scope MCP servers belong to the plugin that ships them — " +
          "disable the plugin instead of editing its files",
      );
    }
    if (scope !== "user" && !this.deps.projectPath) {
      throw new Error(`a ${scope}-scope MCP server needs a project directory`);
    }
  }

  private mcpAddArgs(scope: McpServerScope, draft: McpServerEntryDraft): string[] {
    assertCliPositional("MCP server", draft.name);
    const args = ["mcp", "add", "-s", scope];
    if (draft.transport !== "stdio") args.push("--transport", draft.transport);
    for (const [key, value] of Object.entries(draft.env ?? {})) args.push("-e", `${key}=${value}`);
    args.push(draft.name);
    if (draft.transport === "stdio") {
      if (!draft.command) throw new Error(`stdio MCP server "${draft.name}" needs a command`);
      // `--` first: everything after it is the child's argv, which is how the
      // CLI's own examples spell a stdio server with flags of its own.
      args.push("--", draft.command, ...(draft.args ?? []));
    } else {
      if (!draft.url) throw new Error(`${draft.transport} MCP server "${draft.name}" needs a url`);
      args.push(draft.url);
    }
    return args;
  }

  private writeProjectMcpJson(mutate: (servers: Record<string, unknown>) => void): void {
    const file = this.paths.projectMcpJson;
    if (!file) throw new Error("no project directory for .mcp.json");
    updateJsonFile(this.io, file, (root) => {
      const servers = asRecord(root.mcpServers) ?? {};
      mutate(servers);
      root.mcpServers = servers;
    });
  }

  // -------------------------------------------------------------------------
  // writes — tool policies
  // -------------------------------------------------------------------------

  /** Which settings file owns a policy scope; `session` has none (Phase 9). */
  policyFileFor(scope: ToolPolicyScope): string | null {
    if (scope === "global") return this.paths.userSettings;
    if (scope === "project") return this.paths.projectLocalSettings;
    return null;
  }

  setToolPolicy(
    scope: ToolPolicyScope,
    pattern: string,
    decision: ToolPolicyDecision,
  ): ToolPolicyEntry {
    const file = this.requirePolicyFile(scope);
    updateJsonFile(this.io, file, (root) => {
      const permissions = asRecord(root.permissions) ?? {};
      for (const bucket of ["allow", "deny", "ask"] as const) {
        const list = asStringArray(permissions[bucket]) ?? [];
        const without = list.filter((item) => item !== pattern);
        if (bucket === DECISION_BUCKET[decision]) without.push(pattern);
        // An empty bucket is deleted rather than written as `[]`: the CLI
        // treats absent and empty the same, and a file full of `[]` is noise
        // in a repo diff.
        if (without.length > 0) permissions[bucket] = without;
        else delete permissions[bucket];
      }
      root.permissions = permissions;
    });
    const written = this.readToolPolicies().find(
      (entry) => entry.scope === scope && entry.pattern === pattern,
    );
    if (!written) throw new Error(`capygen wrote the policy "${pattern}" but could not read it back`);
    return written;
  }

  removeToolPolicy(scope: ToolPolicyScope, pattern: string): { ok: boolean } {
    const file = this.requirePolicyFile(scope);
    updateJsonFile(this.io, file, (root) => {
      const permissions = asRecord(root.permissions);
      if (!permissions) return;
      for (const bucket of ["allow", "deny", "ask"] as const) {
        const list = asStringArray(permissions[bucket]);
        if (!list) continue;
        const without = list.filter((item) => item !== pattern);
        if (without.length > 0) permissions[bucket] = without;
        else delete permissions[bucket];
      }
    });
    const still = this.readToolPolicies().some(
      (entry) => entry.scope === scope && entry.pattern === pattern,
    );
    return { ok: !still };
  }

  private requirePolicyFile(scope: ToolPolicyScope): string {
    const file = this.policyFileFor(scope);
    if (file) return file;
    throw new Error(
      scope === "session"
        ? "session-scope tool policies are capygen's own (SPEC P17, Phase 9); " +
          "Claude Code has no per-session permissions file"
        : `no settings file for the ${scope} policy scope`,
    );
  }

  // -------------------------------------------------------------------------
  // writes — skills
  // -------------------------------------------------------------------------

  /**
   * `skillOverrides[<name>] = "off"` disables; deleting the key re-enables
   * (the SDK's own schema: "Absent = on"). No file is moved, so a skill capygen
   * disabled is still exactly where its author put it.
   */
  setSkillEnabled(name: string, enabled: boolean, scope?: SkillScope): SkillEntry {
    const file =
      scope === "project"
        ? (this.paths.projectLocalSettings ??
          (() => {
            throw new Error("a project-scope skill needs a project directory");
          })())
        : this.paths.userSettings;
    updateJsonFile(this.io, file, (root) => {
      const overrides = asRecord(root.skillOverrides) ?? {};
      if (enabled) delete overrides[name];
      else overrides[name] = "off";
      if (Object.keys(overrides).length > 0) root.skillOverrides = overrides;
      else delete root.skillOverrides;
    });
    const written = this.currentSkills().find(
      (entry) => entry.name === name && (scope === undefined || entry.scope === scope),
    );
    if (!written) throw new Error(`capygen has no skill named "${name}" for claude`);
    return written;
  }

  createSkill(scope: SkillScope, name: string, markdown: string): SkillEntry {
    if (scope === "plugin") {
      throw new Error("a plugin's skills belong to the plugin — install or fork it instead");
    }
    const dir = scope === "project" ? this.paths.projectSkillsDir : this.paths.userSkillsDir;
    if (!dir) throw new Error("a project-scope skill needs a project directory");
    // [review] `safeChildPath`, never a bare `path.join`: the name arrives from
    // the IPC boundary and `FileIo.write` creates every parent it is given.
    const file = safeChildPath(dir, name, "SKILL.md");
    if (this.io.exists(file)) throw new Error(`${file} already exists`);
    this.io.write(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    const written = this.currentSkills().find(
      (entry) => entry.scope === scope && entry.path === file,
    );
    if (!written) throw new Error(`capygen wrote ${file} but could not read it back`);
    return written;
  }

  // -------------------------------------------------------------------------
  // writes — plugins (CLI only; A9)
  // -------------------------------------------------------------------------

  async installPlugin(marketplace: string, name: string): Promise<PluginEntry> {
    const id = name.includes("@") ? name : `${name}@${marketplace}`;
    assertCliPositional("plugin", id);
    // `--yes` is required, not cosmetic: the CLI refuses a marketplace-declared
    // install command without it when stdout is not a TTY, which it never is
    // here.
    //
    // [review] R27's two halves are both satisfied by the caller and by
    // `showConsole`, not by `--yes`: `IntegrationsService.confirmPluginCommand`
    // shows a native dialog quoting this exact command and refuses to reach
    // here without a Yes (the gate lives in main, where a renderer cannot skip
    // it), and `showConsole: true` puts the child's console window on screen
    // while it runs. The previous comment here claimed a renderer dialog did
    // this; no such dialog existed.
    await runCliOrThrow(this.run, this.bin, ["plugin", "install", id, "--yes"], {
      ...this.cliOptions(),
      showConsole: true,
    });
    const written = this.readPlugins().find((plugin) => plugin.name === id);
    if (!written) throw new Error(`capygen installed ${id} but could not read it back`);
    return written;
  }

  async uninstallPlugin(name: string): Promise<{ ok: boolean }> {
    assertCliPositional("plugin", name);
    await runCliOrThrow(this.run, this.bin, ["plugin", "uninstall", name], {
      ...this.cliOptions(),
      showConsole: true,
    });
    return { ok: !this.readPlugins().some((plugin) => plugin.name === name) };
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<PluginEntry> {
    assertCliPositional("plugin", name);
    await runCliOrThrow(
      this.run,
      this.bin,
      ["plugin", enabled ? "enable" : "disable", name],
      this.cliOptions(),
    );
    const written = this.readPlugins().find((plugin) => plugin.name === name);
    if (!written) throw new Error(`capygen has no plugin named "${name}"`);
    return written;
  }

  /**
   * Marketplaces, live. `claude plugin marketplace list --json` is exact where
   * `known_marketplaces.json` is only capygen's read of the same thing, so this
   * is what `integrations.plugin.marketplaces` answers with — falling back to
   * the file when the CLI is missing, which is the whole point of keeping both.
   */
  async marketplaces(): Promise<PluginMarketplaceEntry[]> {
    const result = await this.run(
      this.bin,
      ["plugin", "marketplace", "list", "--json"],
      this.cliOptions(),
    );
    if (result.code !== 0) {
      this.log.warn(`[claude] marketplace list exited ${result.code}; using the cached file`);
      return this.readMarketplaces();
    }
    const rows = parseJsonOutput<unknown[]>(result.stdout);
    if (!Array.isArray(rows)) return this.readMarketplaces();
    const out: PluginMarketplaceEntry[] = [];
    for (const raw of rows) {
      const record = asRecord(raw);
      const name = str(record?.name);
      if (!name) continue;
      const url = str(record?.repo) ?? str(record?.url) ?? str(record?.installLocation);
      out.push({ name, ...(url ? { url } : {}), source: "claude plugin marketplace list" });
    }
    return out;
  }

  /** `claude plugin list --json` — the authority on what is installed. */
  async livePlugins(): Promise<{ id: string; version?: string; enabled: boolean }[]> {
    const result = await this.run(this.bin, ["plugin", "list", "--json"], this.cliOptions());
    if (result.code !== 0) return [];
    const rows = parseJsonOutput<unknown[]>(result.stdout);
    if (!Array.isArray(rows)) return [];
    const out: { id: string; version?: string; enabled: boolean }[] = [];
    for (const raw of rows) {
      const record = asRecord(raw);
      const id = str(record?.id);
      if (!id) continue;
      const version = str(record?.version);
      out.push({ id, ...(version ? { version } : {}), enabled: record?.enabled !== false });
    }
    return out;
  }

  private cliOptions(): RunCliOptions {
    return {
      ...(this.deps.projectPath ? { cwd: this.deps.projectPath } : {}),
      env: this.env,
      // Always explicit, never inherited: an isolated home must stay isolated
      // even if the parent process happened to have the variable unset.
      overrides: { CLAUDE_CONFIG_DIR: this.paths.configDir },
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * [review] A name that the `claude` CLI will see as a **bare positional**.
 *
 * `execFile` is already safe from the shell (array argv, no `shell: true`), so
 * this is not about shell injection — it is about the CLI's *own* argument
 * parser. `mcpAddArgs` puts the server name before the `--` separator, so a
 * name of `--transport` or `-s` is consumed as an option there and the command
 * that runs is not the command capygen composed: the scope, the transport, or
 * the marketplace can silently differ from what the read-back then checks.
 *
 * Refusing a leading `-` is the whole fix; no real MCP server or plugin id
 * starts with one, and the message says what to do instead.
 */
export function assertCliPositional(kind: string, name: string): void {
  if (name.startsWith("-")) {
    throw new Error(
      `a ${kind} name cannot start with "-" ("${name}") — the \`claude\` CLI would read it ` +
        "as one of its own options rather than as the name",
    );
  }
}

/** Claude's `mcpServers` map → `McpServerEntry[]`. */
function toEntries(value: unknown, scope: McpServerScope, source: string): McpServerEntry[] {
  const table = asRecord(value);
  if (!table) return [];
  const out: McpServerEntry[] = [];
  for (const [name, raw] of Object.entries(table)) {
    const record = asRecord(raw);
    if (!record) continue;
    const command = str(record.command);
    const url = str(record.url);
    const declared = str(record.type);
    const transport: McpTransport =
      declared === "sse"
        ? "sse"
        : declared === "http" || declared === "streamable-http" || (!command && url)
          ? "http"
          : "stdio";
    out.push({
      backend: "claude",
      name,
      transport,
      ...(command ? { command } : {}),
      ...(Array.isArray(record.args)
        ? { args: record.args.filter((a): a is string => typeof a === "string") }
        : {}),
      ...(url ? { url } : {}),
      ...(stringRecord(record.env) ? { env: stringRecord(record.env) as Record<string, string> } : {}),
      scope,
      source,
      enabled: record.disabled !== true,
    });
  }
  return out;
}

/** `McpServerEntryDraft` → the object Claude's `mcpServers` map holds. */
function mcpServerJson(draft: McpServerEntryDraft): Record<string, unknown> {
  if (draft.transport === "stdio") {
    return {
      type: "stdio",
      command: draft.command ?? "",
      ...(draft.args && draft.args.length > 0 ? { args: draft.args } : {}),
      ...(draft.env && Object.keys(draft.env).length > 0 ? { env: draft.env } : {}),
    };
  }
  return {
    type: draft.transport === "sse" ? "sse" : "http",
    url: draft.url ?? "",
    ...(draft.env && Object.keys(draft.env).length > 0 ? { env: draft.env } : {}),
  };
}

/**
 * One `claude mcp list` line. The shape on 2.1.261 is
 * `<name>: <command-or-url>[ (HTTP)] - <glyph> <status>`, and a claude.ai
 * connector's name has a space in it (`claude.ai Higgsfield`), so the split is
 * on the **first** `": "` and the **last** `" - "`.
 */
export function parseMcpListOutput(
  stdout: string,
): { name: string; status: McpServerStatus; target: string }[] {
  const out: { name: string; status: McpServerStatus; target: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.endsWith("…")) continue;
    const colon = trimmed.indexOf(": ");
    const dash = trimmed.lastIndexOf(" - ");
    if (colon < 0 || dash <= colon) continue;
    const name = trimmed.slice(0, colon).trim();
    const target = trimmed.slice(colon + 2, dash).trim();
    const status = trimmed.slice(dash + 3).trim();
    out.push({ name, target, status: mcpStatusFromText(status) });
  }
  return out;
}

function mcpStatusFromText(text: string): McpServerStatus {
  const lower = text.toLowerCase();
  if (lower.includes("connected")) return "connected";
  if (lower.includes("authentication") || lower.includes("auth")) return "needs-auth";
  if (lower.includes("failed") || lower.includes("error")) return "failed";
  // "Pending approval" and anything new: honestly unknown rather than guessed.
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
