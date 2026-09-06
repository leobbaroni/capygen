/**
 * The generic MCP client's data shapes.
 *
 * capygen has to speak MCP itself for two reasons: an `api`-backend agent has no
 * CLI hosting servers on its behalf (SPEC R9), and the MCP Apps widget host
 * needs `resources/read` against the same server that produced a tool result
 * (R31). Both want the *same* server list the CLIs see, hence the multi-source
 * config loader next door.
 */

/** How to reach one server. `source` is kept so the UI can say where it came from. */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse";
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  /** Disabled servers are listed but never connected. */
  disabled?: boolean;
  /** Which file (or config object) this entry came from. */
  source: McpConfigSource;
}

export type McpConfigSource =
  | "agent"
  | "claude-settings"
  | "project-mcp-json"
  | "codex-config";

/** One tool as the server advertises it. `inputSchema` is JSON Schema. */
export interface McpToolInfo {
  /** The server's own name, e.g. `search`. */
  name: string;
  /** `mcp__<server>__<tool>` — the name the model is given (Claude's convention). */
  qualifiedName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The tool's `annotations`, verbatim. A **sibling** of `inputSchema` on the
   * `Tool` object, not a member of it (`@modelcontextprotocol/sdk` 1.30.0
   * `types.d.ts:2381-2419`) — `mcpPermissionClass` used to look for it inside
   * the schema, where it never is, so `readOnlyHint` never fired and every
   * read-only server tool raised a permission card.
   */
  annotations?: Record<string, unknown> | undefined;
  /** The tool's `_meta`, verbatim — the MCP Apps widget host reads `ui://` from it. */
  meta?: Record<string, unknown> | undefined;
}

/**
 * A `tools/call` result, passed through **whole**: `content`,
 * `structuredContent` and `_meta` all survive, because the widget host (R31)
 * finds a widget's `ui://` resource in `_meta` and would have nothing to render
 * if this layer normalised it away.
 */
export interface McpCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpResourceContents {
  uri?: string;
  mimeType?: string;
  text?: string;
  /** Base64, for a non-text resource. */
  blob?: string;
  /**
   * The content item's own `_meta`, verbatim. [win-B3] The MCP Apps host reads
   * a `ui://` document's CSP and sandbox permissions from
   * `_meta.ui` on *this* item — the spec says the tool's `_meta` must be
   * ignored for those — so dropping it here would leave every widget on the
   * deny-everything default policy.
   */
  meta?: unknown;
}

/** `mcp__server__tool` ⇄ its two halves. */
export const MCP_TOOL_PREFIX = "mcp__";

export function qualifyToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverName)}__${toolName}`;
}

/** A server name may contain characters a tool name may not (`.`, `-`, spaces). */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// MCP Apps (SPEC R31) — just enough to notice one
// ---------------------------------------------------------------------------

/**
 * The `_meta` key an MCP Apps tool declares its UI resource under, verbatim from
 * `@modelcontextprotocol/ext-apps` 1.7.5 (`RESOURCE_URI_META_KEY` in
 * `dist/src/server/index.js`). The same package's `registerAppTool` writes the
 * value under **both** this flat key and the nested `_meta.ui.resourceUri`, so
 * `widgetResourceUri` reads either.
 */
export const MCP_APPS_RESOURCE_URI_META_KEY = "ui/resourceUri";
/** `RESOURCE_MIME_TYPE` from the same file — what `resources/read` returns. */
export const MCP_APPS_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The `ui://` resource a tool (or a tool *result*) points at, or undefined.
 *
 * This is deliberately the whole of capygen's MCP Apps knowledge inside the
 * generic client: noticing that a result should become a widget block is the
 * harness's job, and fetching and hosting the HTML is the widget host's
 * (`mcp/apps/**`). Anything more here would put two owners on one contract.
 */
export function widgetResourceUri(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const record = meta as Record<string, unknown>;
  const flat = record[MCP_APPS_RESOURCE_URI_META_KEY];
  if (typeof flat === "string" && flat.startsWith("ui://")) return flat;
  const ui = record.ui;
  if (typeof ui === "object" && ui !== null) {
    const nested = (ui as Record<string, unknown>).resourceUri;
    if (typeof nested === "string" && nested.startsWith("ui://")) return nested;
  }
  return undefined;
}
