/**
 * {@link WidgetMcpAccess} over capygen's own MCP client pool — the resolution
 * path the spike proved for the **Claude** backend and for `api` agents
 * (docs/spikes/mcp-apps.md §b3).
 *
 * The Claude Agent SDK never puts a tool's `_meta` on the stream, so the
 * `ui://` URI cannot be read from the turn at all; what the SDK *does* give is
 * `Query.mcpServerStatus()`, whose `config` for a locally hosted server is the
 * exact stdio/http descriptor we can reconnect with. The pool takes that
 * descriptor list, so this adapter is the last mile: a second, read-only client
 * to the same server, used for `tools/list`, `resources/read` and the widget's
 * own `tools/call`.
 *
 * A `claudeai-proxy` connector has no such descriptor — only an upstream URL
 * and an Anthropic-side id (§c) — so {@link unreachable} names it and the host
 * falls back to the result card instead of opening a connection that could not
 * authenticate anyway.
 */
import type { McpClientPool, McpServerConfig } from "../client/index.js";
import type {
  WidgetCallResult,
  WidgetMcpAccess,
  WidgetResourceContents,
  WidgetToolInfo,
} from "./WidgetHostBridge.js";

export interface PoolWidgetAccessOptions {
  pool: McpClientPool;
  /**
   * Servers the backend hosts that capygen cannot open a client to, with the
   * reason (`claude.ai Higgsfield` → "a claude.ai connector is proxied by
   * Claude Code…"). Consulted before the pool, so an unreachable name never
   * turns into a connection attempt.
   */
  unreachable?: ReadonlyMap<string, string>;
}

const PROXY_REASON =
  "a claude.ai connector is proxied by Claude Code, so capygen cannot open its own " +
  "MCP client to it and cannot read its ui:// resources";

/** True for a server descriptor capygen itself can dial. */
export function isReachableServer(config: Pick<McpServerConfig, "transport" | "command" | "url">): boolean {
  if (config.transport === "stdio") return Boolean(config.command);
  if (config.transport === "http") return Boolean(config.url);
  return false;
}

/**
 * The reason a Claude-hosted server is out of reach, or `undefined` when it is
 * reachable. `type` here is the `config.type` the SDK reports
 * (`stdio` | `http` | `sse` | `claudeai-proxy`, spike §b1).
 */
export function unreachableReason(type: string | undefined): string | undefined {
  if (type === "claudeai-proxy") return PROXY_REASON;
  if (type === "sse") return "capygen speaks stdio and streamable HTTP, not the legacy sse transport";
  return undefined;
}

export function createPoolWidgetAccess(options: PoolWidgetAccessOptions): WidgetMcpAccess {
  const { pool } = options;
  const unreachable = options.unreachable;
  return {
    serverNames: () => pool.list().map((server) => server.name),
    unreachable: (serverName) => {
      const declared = unreachable?.get(serverName);
      if (declared) return declared;
      const server = pool.list().find((s) => s.name === serverName);
      if (!server) return `capygen has no configuration for the MCP server ${serverName}`;
      if (server.disabled === true) return `${serverName} is disabled`;
      if (!isReachableServer(server)) {
        return unreachableReason(server.transport) ?? `${serverName} has no command or url`;
      }
      return undefined;
    },
    listTools: async (serverName): Promise<readonly WidgetToolInfo[]> => {
      const tools = await pool.listTools(serverName);
      return tools.map((tool) => ({ name: tool.name, meta: tool.meta }));
    },
    readResource: async (serverName, uri): Promise<readonly WidgetResourceContents[]> => {
      const contents = await pool.readResource(serverName, uri);
      return contents.map((item) => ({
        ...(item.uri !== undefined ? { uri: item.uri } : {}),
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.blob !== undefined ? { blob: item.blob } : {}),
        ...(item.meta !== undefined ? { meta: item.meta } : {}),
      }));
    },
    callTool: (serverName, toolName, args): Promise<WidgetCallResult> =>
      pool.callTool(serverName, toolName, args) as Promise<WidgetCallResult>,
  };
}
