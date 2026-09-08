/**
 * Turning capygen's resolved MCP server list into what each native backend
 * actually accepts — and being honest about the two backends differing.
 *
 * **Claude can be made authoritative.** `Options.strictMcpConfig` is documented
 * as "only use MCP servers passed via the `mcpServers` option … ignoring all
 * other MCP configurations: project `.mcp.json`, user settings, plugins"
 * (`sdk.d.ts:2128-2134`). So handing Claude the whole resolved list *with* that
 * flag is correct and complete: every native server is started exactly once,
 * and a session can also switch one **off**, because omission means absence.
 *
 * **Codex cannot.** A per-thread `config` **merges** with the home's
 * `config.toml`; it does not replace it. Probed against the pinned binary:
 * `hardened-excludes-inherited-mcp` is **refuted** — the thread that passed its
 * own config still saw `probe_inherited_server[connected,tools=3]`, exactly as
 * the unhardened control did (`e2e-out/9c-isolation.json`). So for Codex an
 * override is *additive only*: omitting a server does not suppress it, and
 * nothing here may claim otherwise.
 *
 * Explicit named `enabled=false` does suppress an inherited server through
 * thread/start config: native loopback probe codex-mcp-disable.json reports
 * disabled, zero tools and zero process starts, against an enabled control.
 */
import type { McpServerConfig } from "../mcp/client/types.js";

/**
 * A name safe to use as an object key and as part of a qualified tool name.
 *
 * Both backends derive the model-visible tool name from the server name
 * (`mcp__<server>__<tool>`), so the charset is already constrained in practice.
 * Enforcing it here also removes the prototype hazard at the source: a server
 * called `__proto__`, `constructor` or `toString` never reaches a record.
 */
const SAFE_SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function isSafeServerName(name: string): boolean {
  return SAFE_SERVER_NAME.test(name) && !FORBIDDEN_KEYS.has(name);
}

/** Belt and braces: these match the charset but must never key a record. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "toString"]);

/**
 * A record that cannot be poisoned.
 *
 * Built with a null prototype and assigned through `Object.defineProperty`, so
 * even a name that slipped past validation would create an own data property
 * rather than walking into `Object.prototype`.
 */
export function emptyServerRecord(): Record<string, Record<string, unknown>> {
  return Object.create(null) as Record<string, Record<string, unknown>>;
}

function put(
  into: Record<string, Record<string, unknown>>,
  name: string,
  value: Record<string, unknown>,
): void {
  Object.defineProperty(into, name, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

const owns = (record: object, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, name);

/** A server the session configured itself, rather than one read from a file. */
export const isSessionScopedServer = (server: McpServerConfig): boolean =>
  server.source === "agent";

/**
 * Does this agent's configuration change the runtime set at all?
 *
 * `resolved` has already had disabled entries removed, so a disable is only
 * visible in the agent's own object — hence both halves of this test.
 */
export function sessionOverridesMcp(
  resolved: readonly McpServerConfig[],
  agentServers: readonly McpServerConfig[],
): boolean {
  return resolved.some(isSessionScopedServer) || agentServers.length > 0;
}

/** What a conversion could not carry, so a caller can say so out loud. */
export interface McpConversionNotes {
  /**
   * Configured servers that are **not** in the runtime set that was produced.
   * A caller must report these; presenting them as running would be a lie.
   */
  notApplied: Array<{ name: string; reason: string }>;

}

export interface ClaudeMcpOverride extends McpConversionNotes {
  servers: Record<string, Record<string, unknown>>;
}

export type ClaudeMcpServerRecord = Record<string, Record<string, unknown>>;

/**
 * The resolved list as Claude's own option object.
 *
 * Disabled entries are simply absent, which for Claude genuinely means "off":
 * `strictMcpConfig` makes this set the whole truth, so omission suppresses.
 */
export function toClaudeMcpServers(servers: readonly McpServerConfig[]): ClaudeMcpOverride {
  const out = emptyServerRecord();
  const notApplied: Array<{ name: string; reason: string }> = [];
  for (const server of servers) {
    if (!isSafeServerName(server.name)) {
      notApplied.push({ name: server.name, reason: "its name is not a usable MCP server name" });
      continue;
    }
    if (server.disabled === true) continue;
    if (server.transport === "stdio") {
      if (!server.command) {
        notApplied.push({ name: server.name, reason: "it has no command to run" });
        continue;
      }
      put(out, server.name, {
        type: "stdio",
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      });
      continue;
    }
    if (!server.url) {
      notApplied.push({ name: server.name, reason: `it has no url for its ${server.transport} transport` });
      continue;
    }
    put(out, server.name, {
      type: server.transport,
      url: server.url,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
    });
  }
  return { servers: out, notApplied };
}

export interface CodexMcpOverride extends McpConversionNotes {
  servers: Record<string, Record<string, unknown>>;
}

/**
 * The resolved list as Codex's `[mcp_servers.*]` table.
 *
 * Not stdio-only: `CodexConfigStore.mcpServerToml` writes `command`/`args` for
 * stdio and `url`/`http_headers` for http and sse, plus `env`, `cwd` and
 * `enabled` — this mirrors that exact shape, because `thread/start`'s `config`
 * takes the same table the user's file uses.
 *
 * A disabled server is emitted as `{ enabled: false }` rather than omitted:
 * omission cannot suppress anything here (see the header), so the key is the
 * explicit override mechanism. Its effect is natively verified for both
 * process-start config and per-thread config, including zero launcher starts.
 */
export function toCodexMcpServers(servers: readonly McpServerConfig[]): CodexMcpOverride {
  const out = emptyServerRecord();
  const notApplied: Array<{ name: string; reason: string }> = [];
  for (const server of servers) {
    if (!isSafeServerName(server.name)) {
      notApplied.push({ name: server.name, reason: "its name is not a usable MCP server name" });
      continue;
    }
    if (server.disabled === true) {
      put(out, server.name, { enabled: false });
      continue;
    }
    if (server.transport === "stdio") {
      if (!server.command) {
        notApplied.push({ name: server.name, reason: "it has no command to run" });
        continue;
      }
      put(out, server.name, {
        command: server.command,
        args: server.args ? [...server.args] : [],
        ...(server.env ? { env: { ...server.env } } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      });
      continue;
    }
    if (!server.url) {
      notApplied.push({ name: server.name, reason: `it has no url for its ${server.transport} transport` });
      continue;
    }
    put(out, server.name, {
      url: server.url,
      ...(server.headers ? { http_headers: { ...server.headers } } : {}),
    });
  }
  return { servers: out, notApplied };
}

/**
 * Merge capygen's own in-process servers into a configured set.
 *
 * capygen's server keeps **its own name**, always. The model calls its tool by
 * the qualified name the server name produces — `mcp__capygen__delegate_task`
 * (COMPAT §Claude) — so renaming capygen's side would silently change the tool
 * the routing policy tells the model to call. The user's colliding entry is the
 * one that cannot be applied, and it is *reported* rather than quietly renamed
 * into a tool name they never configured.
 */
export function mergeReservedServers(
  configured: Record<string, Record<string, unknown>>,
  reserved: Record<string, Record<string, unknown>>,
): { merged: Record<string, Record<string, unknown>>; displaced: string[] } {
  const merged = emptyServerRecord();
  const displaced: string[] = [];
  for (const name of Object.keys(configured)) {
    if (!owns(configured, name)) continue;
    put(merged, name, configured[name]!);
  }
  for (const name of Object.keys(reserved)) {
    if (!owns(reserved, name)) continue;
    if (owns(merged, name)) displaced.push(name);
    // capygen's own definition wins the name it reserves.
    put(merged, name, reserved[name]!);
  }
  return { merged, displaced };
}
