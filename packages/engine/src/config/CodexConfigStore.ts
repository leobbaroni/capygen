/**
 * Codex's configuration: `~/.codex/config.toml` (or `CODEX_HOME`), read as a
 * structured view and written back **by patching text ranges** so comments,
 * key order and quoting survive (SPEC R20, R28, R29).
 *
 * | What | Read from | Written by |
 * |---|---|---|
 * | MCP servers | `[mcp_servers.<name>]` (+ its `[…env]` child table) | the same table, patched in place |
 * | Plugins | `[plugins."<id>@<marketplace>"] enabled` | that table's `enabled` key |
 * | Marketplaces | `[marketplaces.<name>] source_type/source` | not written here (Phase 9's `marketplace/add`) |
 * | Model / effort | top-level `model`, `model_reasoning_effort` | those keys, patched in place |
 * | Approvals / sandbox | top-level `approval_policy`, `sandbox_mode` | those keys |
 * | Skills | `<CODEX_HOME>/skills/<name>/SKILL.md`, `<project>/.codex/skills`, plugin caches | a `SKILL.md` |
 *
 * Two limitations recorded rather than hidden:
 *
 *   * **Codex has no per-tool permission list.** Claude has
 *     `permissions.allow/deny/ask`; the closest Codex equivalents are the
 *     whole-session `approval_policy` and `sandbox_mode` plus execpolicy prefix
 *     rules that do not live in `config.toml` at all (verified against the
 *     0.153.4 app-server bindings: `Config` has neither, and
 *     `ExecPolicyAmendment` is a runtime proposal, not a config key). So
 *     `readToolPolicies()` is empty by construction, and a `codex` tool policy
 *     is capygen's own row in SQLite — enforced by capygen's permission cards,
 *     never written into Codex's file.
 *   * **Skill enable/disable is a file move, not a settings key.** Codex's
 *     app-server does expose `skills/config/write {name|path, enabled}`, but
 *     that needs a *running* server and writes wherever the server decides.
 *     Since capygen already owns the file layer here, a disabled skill is
 *     renamed `SKILL.md` → `SKILL.md.disabled` **inside the skill's own
 *     directory**, which is reversible, visible in a diff, and cannot lose the
 *     file. Nothing outside that one rename is touched.
 */
import path from "node:path";
import type {
  McpServerEntry,
  McpServerEntryDraft,
  McpServerEntryPatch,
  McpServerScope,
  McpTransport,
  PluginEntry,
  PluginMarketplaceEntry,
  SkillEntry,
  SkillScope,
  ToolPolicyEntry,
} from "@capygen/shared";
import {
  nodeFileIo,
  readSkillFrontMatter,
  updateTextFile,
  type FileIo,
} from "./files.js";
import { codexPaths, type CodexPaths } from "./paths.js";
import {
  findTable,
  isTomlRaw,
  parseTomlDocument,
  removeRootKey,
  removeTable,
  setRootKey,
  tomlToObject,
  upsertTable,
  type TomlValue,
} from "./toml.js";
import type { ConfigStoreLogger, IntegrationsSnapshot } from "./types.js";

/** The name capygen gives a disabled Codex skill's document. */
export const CODEX_DISABLED_SKILL_FILE = "SKILL.md.disabled";

export interface CodexConfigStoreDeps {
  /** `~/.codex`, or whatever `CODEX_HOME` says (`resolveBackendHomes`). */
  configDir: string;
  projectPath?: string | null;
  io?: FileIo;
  log?: ConfigStoreLogger;
}

const NO_LOG: ConfigStoreLogger = { info: () => {}, warn: () => {} };

/** The top-level keys Settings ▸ Harnesses ▸ Codex can set. */
export interface CodexDefaults {
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
}

export class CodexConfigStore {
  readonly paths: CodexPaths;
  private readonly io: FileIo;
  private readonly log: ConfigStoreLogger;

  constructor(private readonly deps: CodexConfigStoreDeps) {
    this.io = deps.io ?? nodeFileIo;
    this.log = deps.log ?? NO_LOG;
    this.paths = codexPaths({
      configDir: deps.configDir,
      projectPath: deps.projectPath ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  read(): IntegrationsSnapshot {
    const config = this.config();
    const plugins = this.readPlugins(config);
    return {
      mcpServers: this.readMcpServers(config),
      plugins,
      skills: this.readSkills(plugins),
      // See the header: Codex has no per-tool permission list.
      tools: [] as ToolPolicyEntry[],
      marketplaces: this.readMarketplaces(config),
    };
  }

  /** `config.toml` as a nested object; `{}` when the file is absent. */
  config(): Record<string, unknown> {
    const text = this.io.read(this.paths.configToml);
    if (text === undefined) return {};
    try {
      return tomlToObject(parseTomlDocument(text));
    } catch (err) {
      this.log.warn(`[codex] ${this.paths.configToml} could not be read: ${(err as Error).message}`);
      return {};
    }
  }

  defaults(): CodexDefaults {
    const config = this.config();
    return {
      ...(str(config.model) ? { model: str(config.model) as string } : {}),
      ...(str(config.model_reasoning_effort)
        ? { reasoningEffort: str(config.model_reasoning_effort) as string }
        : {}),
      ...(str(config.approval_policy)
        ? { approvalPolicy: str(config.approval_policy) as string }
        : {}),
      ...(str(config.sandbox_mode) ? { sandboxMode: str(config.sandbox_mode) as string } : {}),
    };
  }

  private readMcpServers(config: Record<string, unknown>): McpServerEntry[] {
    const table = asRecord(config.mcp_servers);
    if (!table) return [];
    const out: McpServerEntry[] = [];
    for (const [name, raw] of Object.entries(table)) {
      const record = asRecord(raw);
      if (!record) continue;
      const command = str(record.command);
      const url = str(record.url);
      const transport: McpTransport = command ? "stdio" : url ? "http" : "stdio";
      out.push({
        backend: "codex",
        name,
        transport,
        ...(command ? { command } : {}),
        ...(Array.isArray(record.args)
          ? { args: record.args.filter((a): a is string => typeof a === "string") }
          : {}),
        ...(url ? { url } : {}),
        ...(stringRecord(record.env) ? { env: stringRecord(record.env) as Record<string, string> } : {}),
        // Codex has exactly one MCP config file, so every server it declares is
        // user scope; a plugin-provided one is reported live instead
        // (`mcpServerStatus/list` carries `pluginId`), which is where the
        // `plugin` scope comes from for this backend.
        scope: "user",
        source: this.paths.configToml,
        enabled: record.enabled !== false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private readPlugins(config: Record<string, unknown>): PluginEntry[] {
    const table = asRecord(config.plugins);
    if (!table) return [];
    const out: PluginEntry[] = [];
    for (const [id, raw] of Object.entries(table)) {
      const record = asRecord(raw) ?? {};
      const marketplace = id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : undefined;
      const installPath = this.pluginInstallPath(id);
      out.push({
        backend: "codex",
        name: id,
        ...(marketplace ? { marketplace } : {}),
        enabled: record.enabled !== false,
        installed: installPath !== null,
        ...(installPath ? { path: installPath } : {}),
        commands: [],
        skills: installPath ? this.io.listDirs(path.join(installPath, "skills")) : [],
        source: this.paths.configToml,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>` — the layout
   * this machine's own cache uses. The newest version directory wins; a plugin
   * whose cache is absent is listed as `installed: false` rather than hidden,
   * because a config that enables a plugin Codex has not materialised yet is a
   * fact the settings page should show.
   */
  private pluginInstallPath(id: string): string | null {
    const at = id.lastIndexOf("@");
    if (at <= 0) return null;
    const name = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    const base = path.join(this.paths.pluginsCacheDir, marketplace, name);
    const versions = this.io.listDirs(base);
    const newest = versions[versions.length - 1];
    return newest ? path.join(base, newest) : null;
  }

  private readMarketplaces(config: Record<string, unknown>): PluginMarketplaceEntry[] {
    const table = asRecord(config.marketplaces);
    if (!table) return [];
    const out: PluginMarketplaceEntry[] = [];
    for (const [name, raw] of Object.entries(table)) {
      const record = asRecord(raw) ?? {};
      const url = str(record.source);
      out.push({ name, ...(url ? { url } : {}), source: this.paths.configToml });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private readSkills(plugins: PluginEntry[]): SkillEntry[] {
    const out: SkillEntry[] = [];
    const collect = (dir: string | null, scope: SkillScope, pluginName?: string): void => {
      if (!dir) return;
      for (const name of this.io.listDirs(dir)) {
        const enabledFile = path.join(dir, name, "SKILL.md");
        const disabledFile = path.join(dir, name, CODEX_DISABLED_SKILL_FILE);
        const enabled = this.io.exists(enabledFile);
        const file = enabled ? enabledFile : disabledFile;
        const text = this.io.read(file);
        if (text === undefined) continue;
        const front = readSkillFrontMatter(text);
        out.push({
          backend: "codex",
          name: front.name?.trim() || name,
          scope,
          path: file,
          ...(pluginName ? { pluginName } : {}),
          enabled,
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

  // -------------------------------------------------------------------------
  // writes — MCP
  // -------------------------------------------------------------------------

  addMcpServer(scope: McpServerScope, draft: McpServerEntryDraft): McpServerEntry {
    this.assertUserScope(scope, draft.name);
    this.patch((doc) => upsertTable(doc, ["mcp_servers", draft.name], mcpServerToml(draft)));
    const written = this.readMcpServers(this.config()).find((entry) => entry.name === draft.name);
    if (!written) {
      throw new Error(`capygen added "${draft.name}" to ${this.paths.configToml} but could not read it back`);
    }
    return written;
  }

  updateMcpServer(
    scope: McpServerScope,
    name: string,
    patch: McpServerEntryPatch,
  ): McpServerEntry {
    this.assertUserScope(scope, name);
    const existing = this.readMcpServers(this.config()).find((entry) => entry.name === name);
    if (!existing) throw new Error(`no MCP server named "${name}" in ${this.paths.configToml}`);
    const merged: McpServerEntryDraft = {
      name: patch.name ?? existing.name,
      transport: patch.transport ?? existing.transport,
      ...(patch.command ?? existing.command ? { command: patch.command ?? existing.command } : {}),
      ...(patch.args ?? existing.args ? { args: patch.args ?? existing.args } : {}),
      ...(patch.url ?? existing.url ? { url: patch.url ?? existing.url } : {}),
      ...(patch.env ?? existing.env ? { env: patch.env ?? existing.env } : {}),
      source: patch.source ?? existing.source,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.patch((doc) => {
      const renamed = merged.name !== name;
      const text = renamed ? removeTable(doc, ["mcp_servers", name]) : doc.text;
      const next = renamed ? parseTomlDocument(text) : doc;
      return upsertTable(next, ["mcp_servers", merged.name], mcpServerToml(merged));
    });
    const written = this.readMcpServers(this.config()).find((entry) => entry.name === merged.name);
    if (!written) throw new Error(`capygen updated "${name}" but could not read it back`);
    return written;
  }

  removeMcpServer(scope: McpServerScope, name: string): { ok: boolean } {
    this.assertUserScope(scope, name);
    this.patch((doc) => removeTable(doc, ["mcp_servers", name]));
    return { ok: !this.readMcpServers(this.config()).some((entry) => entry.name === name) };
  }

  private assertUserScope(scope: McpServerScope, name: string): void {
    if (scope === "user") return;
    throw new Error(
      `Codex keeps every MCP server in ${this.paths.configToml}; "${name}" cannot be ` +
        `${scope} scope (a plugin's servers belong to the plugin)`,
    );
  }

  // -------------------------------------------------------------------------
  // writes — plugins, defaults
  // -------------------------------------------------------------------------

  setPluginEnabled(id: string, enabled: boolean): PluginEntry {
    this.patch((doc) => {
      const existing = findTable(doc, ["plugins", id]);
      if (!existing && !enabled) {
        // Disabling something the file never mentioned still has to be
        // recorded, or the next read would report it enabled again.
        return upsertTable(doc, ["plugins", id], { enabled: false });
      }
      return upsertTable(doc, ["plugins", id], { enabled });
    });
    const written = this.readPlugins(this.config()).find((plugin) => plugin.name === id);
    if (!written) throw new Error(`capygen set "${id}" but could not read it back`);
    return written;
  }

  removePlugin(id: string): { ok: boolean } {
    this.patch((doc) => removeTable(doc, ["plugins", id]));
    return { ok: !this.readPlugins(this.config()).some((plugin) => plugin.name === id) };
  }

  /** Top-level defaults; `undefined` deletes the key rather than writing "". */
  setDefaults(defaults: CodexDefaults): CodexDefaults {
    const pairs: [string, string | undefined][] = [
      ["model", defaults.model],
      ["model_reasoning_effort", defaults.reasoningEffort],
      ["approval_policy", defaults.approvalPolicy],
      ["sandbox_mode", defaults.sandboxMode],
    ];
    this.patch((doc) => {
      let text = doc.text;
      for (const [key, value] of pairs) {
        if (value === undefined) continue;
        const current = parseTomlDocument(text);
        text = value.length === 0 ? removeRootKey(current, key) : setRootKey(current, key, value);
      }
      return text;
    });
    return this.defaults();
  }

  // -------------------------------------------------------------------------
  // writes — skills
  // -------------------------------------------------------------------------

  setSkillEnabled(name: string, enabled: boolean, scope?: SkillScope): SkillEntry {
    const existing = this.readSkills(this.readPlugins(this.config())).find(
      (entry) => entry.name === name && (scope === undefined || entry.scope === scope),
    );
    if (!existing) throw new Error(`capygen has no skill named "${name}" for codex`);
    if (existing.enabled === enabled) return existing;
    const dir = path.dirname(existing.path);
    const from = existing.path;
    const to = path.join(dir, enabled ? "SKILL.md" : CODEX_DISABLED_SKILL_FILE);
    // A rename, not a copy-and-truncate: `FileIo` has no delete on purpose
    // (see its doc comment), and a rename is the one operation that cannot end
    // with two half-written copies of the user's skill.
    this.io.rename(from, to);
    const written = this.readSkills(this.readPlugins(this.config())).find(
      (entry) => entry.path === to,
    );
    if (!written) throw new Error(`capygen wrote ${to} but could not read it back`);
    return written;
  }

  createSkill(scope: SkillScope, name: string, markdown: string): SkillEntry {
    if (scope === "plugin") {
      throw new Error("a plugin's skills belong to the plugin — install or fork it instead");
    }
    const dir = scope === "project" ? this.paths.projectSkillsDir : this.paths.userSkillsDir;
    if (!dir) throw new Error("a project-scope skill needs a project directory");
    const file = path.join(dir, name, "SKILL.md");
    if (this.io.exists(file)) throw new Error(`${file} already exists`);
    this.io.write(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    const written = this.readSkills(this.readPlugins(this.config())).find(
      (entry) => entry.path === file,
    );
    if (!written) throw new Error(`capygen wrote ${file} but could not read it back`);
    return written;
  }

  // -------------------------------------------------------------------------

  /** Read → patch → write → re-read, as one step (`updateTextFile`). */
  private patch(edit: (doc: ReturnType<typeof parseTomlDocument>) => string): void {
    updateTextFile(this.io, this.paths.configToml, (text) => edit(parseTomlDocument(text)));
  }
}

/** `McpServerEntryDraft` → the keys a `[mcp_servers.<name>]` table holds. */
export function mcpServerToml(
  draft: McpServerEntryDraft,
): Record<string, TomlValue | undefined> {
  const values: Record<string, TomlValue | undefined> = {};
  if (draft.transport === "stdio") {
    if (!draft.command) throw new Error(`stdio MCP server "${draft.name}" needs a command`);
    values.command = draft.command;
    values.args = draft.args ?? [];
  } else {
    if (!draft.url) throw new Error(`${draft.transport} MCP server "${draft.name}" needs a url`);
    values.url = draft.url;
  }
  if (draft.env && Object.keys(draft.env).length > 0) values.env = { ...draft.env };
  // Only written when the server is *off*: Codex's own default is enabled, and
  // an explicit `enabled = true` on every row would be noise in the user's file.
  if (draft.enabled === false) values.enabled = false;
  return values;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (isTomlRaw(value)) return undefined;
  return value as Record<string, unknown>;
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
