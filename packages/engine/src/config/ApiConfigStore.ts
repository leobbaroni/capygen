/**
 * The `api` backend's integrations view (SPEC R9, R28).
 *
 * The `api` backend has no CLI and no config file of its own — capygen runs the
 * agent loop itself — so its MCP servers are capygen's own state, kept under
 * one `settings` key (`api_mcp_servers`) rather than in a file a third-party
 * tool would also read. Everything else it *sees* is inherited: Phase 3's
 * `loadMcpServers` already gives an `api` agent the Claude and Codex servers
 * (agent config → `.mcp.json` → `~/.claude/settings.json` → `~/.codex/
 * config.toml`), and this store shows exactly that list so Settings ▸
 * Integrations is not lying about what an `api` agent can call.
 *
 * Inherited rows carry `scope: "plugin"` — the enum's "owned by something
 * else" value — and an `inherited: true` passthrough flag, and every write
 * refuses them by name: an inherited server is edited on the backend that owns
 * it, which is the only place a change would also reach that backend's CLI
 * (R29).
 *
 * Plugins, skills and tool policies are empty for `api` by construction: there
 * is no plugin host, no skill loader and no permission file — capygen's own
 * permission cards are the whole policy surface, and those rows live in SQLite.
 */
import type {
  McpServerEntry,
  McpServerEntryDraft,
  McpServerEntryPatch,
  McpServerScope,
  McpTransport,
} from "@capygen/shared";
import type { IntegrationsSnapshot } from "./types.js";

/** Where capygen keeps the `api` backend's own servers. */
export const API_MCP_SETTINGS_KEY = "api_mcp_servers";

/** The two calls the desktop backs with `store.settings.getRaw/setRaw`. */
export interface ApiMcpStore {
  read(): Record<string, unknown>;
  write(value: Record<string, unknown>): void;
}

export interface ApiConfigStoreDeps {
  own: ApiMcpStore;
  /**
   * What the other backends contribute, already read by their own stores. The
   * desktop passes `[...claude.read().mcpServers, ...codex.read().mcpServers]`;
   * a test passes whatever it wants to see inherited.
   */
  inherited: () => McpServerEntry[];
}

export class ApiConfigStore {
  constructor(private readonly deps: ApiConfigStoreDeps) {}

  read(): IntegrationsSnapshot {
    return {
      mcpServers: [...this.ownServers(), ...this.inheritedServers()],
      plugins: [],
      skills: [],
      tools: [],
      marketplaces: [],
    };
  }

  private ownServers(): McpServerEntry[] {
    const table = this.deps.own.read();
    const out: McpServerEntry[] = [];
    for (const [name, raw] of Object.entries(table)) {
      const record = asRecord(raw);
      if (!record) continue;
      const command = str(record.command);
      const url = str(record.url);
      const declared = str(record.transport) ?? str(record.type);
      const transport: McpTransport =
        declared === "sse" ? "sse" : declared === "http" || (!command && url) ? "http" : "stdio";
      out.push({
        backend: "api",
        name,
        transport,
        ...(command ? { command } : {}),
        ...(Array.isArray(record.args)
          ? { args: record.args.filter((a): a is string => typeof a === "string") }
          : {}),
        ...(url ? { url } : {}),
        ...(stringRecord(record.env) ? { env: stringRecord(record.env) as Record<string, string> } : {}),
        scope: "user",
        source: `capygen settings (${API_MCP_SETTINGS_KEY})`,
        enabled: record.enabled !== false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private inheritedServers(): McpServerEntry[] {
    const own = new Set(this.ownServers().map((entry) => entry.name));
    const seen = new Set<string>();
    const out: McpServerEntry[] = [];
    for (const entry of this.deps.inherited()) {
      // An `api` agent resolves servers by name, first source wins
      // (`loadMcpServers`), so a duplicate name is genuinely one server.
      if (own.has(entry.name) || seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({
        ...entry,
        backend: "api",
        scope: "plugin",
        source: `inherited from ${entry.backend}: ${entry.source}`,
        inherited: true,
      } as McpServerEntry);
    }
    return out;
  }

  addMcpServer(scope: McpServerScope, draft: McpServerEntryDraft): McpServerEntry {
    this.assertOwnScope(scope, draft.name);
    const table = this.deps.own.read();
    if (table[draft.name] !== undefined) {
      throw new Error(`the api backend already has an MCP server named "${draft.name}"`);
    }
    table[draft.name] = toJson(draft);
    this.deps.own.write(table);
    return this.requireOwn(draft.name);
  }

  updateMcpServer(
    scope: McpServerScope,
    name: string,
    patch: McpServerEntryPatch,
  ): McpServerEntry {
    this.assertOwnScope(scope, name);
    const table = this.deps.own.read();
    const existing = asRecord(table[name]);
    if (!existing) throw new Error(`the api backend has no MCP server named "${name}"`);
    const current = this.requireOwn(name);
    const merged: McpServerEntryDraft = {
      name: patch.name ?? current.name,
      transport: patch.transport ?? current.transport,
      ...(patch.command ?? current.command ? { command: patch.command ?? current.command } : {}),
      ...(patch.args ?? current.args ? { args: patch.args ?? current.args } : {}),
      ...(patch.url ?? current.url ? { url: patch.url ?? current.url } : {}),
      ...(patch.env ?? current.env ? { env: patch.env ?? current.env } : {}),
      source: patch.source ?? current.source,
      enabled: patch.enabled ?? current.enabled,
    };
    delete table[name];
    table[merged.name] = toJson(merged);
    this.deps.own.write(table);
    return this.requireOwn(merged.name);
  }

  removeMcpServer(scope: McpServerScope, name: string): { ok: boolean } {
    this.assertOwnScope(scope, name);
    const table = this.deps.own.read();
    if (table[name] === undefined) return { ok: false };
    delete table[name];
    this.deps.own.write(table);
    return { ok: this.deps.own.read()[name] === undefined };
  }

  private assertOwnScope(scope: McpServerScope, name: string): void {
    if (scope === "user") return;
    throw new Error(
      `"${name}" is inherited by the api backend, not owned by it — ` +
        "edit it on the backend whose config file declares it (SPEC R29)",
    );
  }

  private requireOwn(name: string): McpServerEntry {
    const written = this.ownServers().find((entry) => entry.name === name);
    if (!written) throw new Error(`capygen wrote the api server "${name}" but could not read it back`);
    return written;
  }
}

function toJson(draft: McpServerEntryDraft): Record<string, unknown> {
  return {
    transport: draft.transport,
    ...(draft.command ? { command: draft.command } : {}),
    ...(draft.args && draft.args.length > 0 ? { args: draft.args } : {}),
    ...(draft.url ? { url: draft.url } : {}),
    ...(draft.env && Object.keys(draft.env).length > 0 ? { env: draft.env } : {}),
    ...(draft.enabled === false ? { enabled: false } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
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
