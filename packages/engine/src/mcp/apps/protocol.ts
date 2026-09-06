/**
 * The MCP Apps constants and `_meta` readers the widget host needs
 * (`@modelcontextprotocol/ext-apps` 1.7.5, SPEC R31).
 *
 * These four strings are copied out of the package rather than imported from
 * it: the engine only needs the constants, and the two entry points that export
 * them (`@modelcontextprotocol/ext-apps` → the browser `App` class,
 * `.../server` → the whole MCP *server* SDK) would each drag a large, wrong-side
 * dependency into the main process for four string literals.
 * `packages/engine/test/mcpApps.test.ts` imports the real package and asserts
 * every one of them still matches, so the copy cannot drift silently.
 *
 * Sources (node_modules/@modelcontextprotocol/ext-apps/dist/src):
 *   app.d.ts:70   `RESOURCE_URI_META_KEY = "ui/resourceUri"`
 *   app.d.ts:78   `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"`
 *   spec.types.d.ts:16  `LATEST_PROTOCOL_VERSION = "2026-01-26"`
 *   server/index.d.ts:315 `EXTENSION_ID = "io.modelcontextprotocol/ui"`
 */
import { MCP_TOOL_PREFIX, sanitizeSegment } from "../client/types.js";

/** Deprecated flat form of the tool's UI pointer: `_meta["ui/resourceUri"]`. */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";

/** The MIME type a `ui://` resource is served with. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** The MCP Apps protocol version this host implements. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** Capability key a client advertises in `capabilities.extensions` (SEP-1724). */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * What a client must advertise for a server to register its App tools. Servers
 * that gate on `getUiCapability()` hide their widget tools from a client that
 * does not send this.
 */
export const MCP_APPS_CLIENT_CAPABILITY = {
  [MCP_APPS_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
} as const;

/** `McpUiResourceCsp` — the origins a widget's document is allowed to reach. */
export interface WidgetCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** `McpUiResourcePermissions` — browser capabilities the widget asks for. */
export interface WidgetPermissions {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
}

/** The `_meta.ui` block of a `ui://` resource (`McpUiResourceMeta`). */
export interface WidgetResourceMeta {
  csp?: WidgetCsp;
  permissions?: WidgetPermissions;
  domain?: string;
  prefersBorder?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `ui://` URI out of a `_meta` object, in either form the SDK accepts:
 * nested `{ ui: { resourceUri } }` (current) or flat `{"ui/resourceUri"}`
 * (deprecated). Unlike ext-apps' `getToolUiResourceUri`, a value that is
 * present but not a `ui://` URI is *ignored* rather than thrown on: this runs
 * over data a third-party server sent, and one malformed tool must not take
 * down the turn that called it.
 */
export function readUiResourceUri(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const nested = meta.ui;
  if (isRecord(nested) && typeof nested.resourceUri === "string") {
    if (nested.resourceUri.startsWith("ui://")) return nested.resourceUri;
  }
  const flat = meta[RESOURCE_URI_META_KEY];
  if (typeof flat === "string" && flat.startsWith("ui://")) return flat;
  return undefined;
}

/** `_meta.ui.visibility` — `["model"]`, `["app"]`, or both (default both). */
export function readUiVisibility(meta: unknown): string[] | undefined {
  if (!isRecord(meta)) return undefined;
  const nested = meta.ui;
  if (!isRecord(nested)) return undefined;
  const visibility = nested.visibility;
  if (!Array.isArray(visibility)) return undefined;
  const out = visibility.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

/** True when the server says only the model may call this tool, not the app. */
export function isModelOnlyTool(meta: unknown): boolean {
  const visibility = readUiVisibility(meta);
  return visibility !== undefined && visibility.includes("model") && !visibility.includes("app");
}

/**
 * The resource's own `_meta.ui` (CSP, permissions, border preference). Read off
 * the `resources/read` content item first and the tool's `_meta` second — the
 * order the spec gives (`McpUiToolMeta.csp` is declared `never`: hosts must
 * ignore a CSP that arrives on the tool).
 */
export function readResourceMeta(...metas: unknown[]): WidgetResourceMeta {
  const out: WidgetResourceMeta = {};
  for (const meta of metas) {
    if (!isRecord(meta)) continue;
    const ui = isRecord(meta.ui) ? meta.ui : undefined;
    if (!ui) continue;
    if (out.csp === undefined && isRecord(ui.csp)) out.csp = pickCsp(ui.csp);
    if (out.permissions === undefined && isRecord(ui.permissions)) {
      out.permissions = ui.permissions as WidgetPermissions;
    }
    if (out.domain === undefined && typeof ui.domain === "string") out.domain = ui.domain;
    if (out.prefersBorder === undefined && typeof ui.prefersBorder === "boolean") {
      out.prefersBorder = ui.prefersBorder;
    }
  }
  return out;
}

function pickCsp(raw: Record<string, unknown>): WidgetCsp {
  const out: WidgetCsp = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    const domains = value.filter((v): v is string => typeof v === "string");
    if (domains.length > 0) out[key] = domains;
  }
  return out;
}

/**
 * The `Content-Security-Policy` a widget document is served with.
 *
 * Deny-by-default, exactly as the spec asks: a widget with no declared CSP gets
 * `default-src 'none'` and can reach nothing but itself. `'unsafe-inline'` is
 * unavoidable — the whole resource *is* one inline document — but it is scoped
 * to a document that has no same-origin privileges (the iframe is sandboxed
 * without `allow-same-origin`, so its origin is opaque: verified in
 * docs/spikes/mcp-apps.md §a4).
 */
export function buildWidgetCsp(csp: WidgetCsp | undefined): string {
  const resource = csp?.resourceDomains ?? [];
  const connect = csp?.connectDomains ?? [];
  const frame = csp?.frameDomains ?? [];
  const base = csp?.baseUriDomains ?? [];
  /** A directive is never emitted empty — an empty source list means "none". */
  const directive = (name: string, sources: string[]): string =>
    `${name} ${sources.length > 0 ? sources.join(" ") : "'none'"}`;
  return [
    "default-src 'none'",
    directive("script-src", ["'unsafe-inline'", ...resource]),
    directive("style-src", ["'unsafe-inline'", ...resource]),
    directive("img-src", ["data:", "blob:", ...resource]),
    directive("font-src", ["data:", ...resource]),
    directive("media-src", ["data:", "blob:", ...resource]),
    directive("connect-src", connect),
    directive("frame-src", frame),
    directive("base-uri", base),
    "form-action 'none'",
  ].join("; ");
}

/**
 * The iframe `allow` attribute for the permissions a resource asked for
 * (ext-apps `buildAllowAttribute`, reimplemented so the main process does not
 * import the browser-side bundle). Anything not declared stays denied.
 */
export function buildAllowAttribute(permissions: WidgetPermissions | undefined): string {
  if (!permissions) return "";
  const out: string[] = [];
  if (permissions.camera) out.push("camera");
  if (permissions.microphone) out.push("microphone");
  if (permissions.geolocation) out.push("geolocation");
  if (permissions.clipboardWrite) out.push("clipboard-write");
  return out.join("; ");
}

export interface QualifiedToolName {
  serverName: string;
  toolName: string;
}

/**
 * `mcp__claude_ai_Higgsfield__balance` → `{server: "claude.ai Higgsfield",
 * tool: "balance"}`.
 *
 * The server segment is *sanitised* on the wire, so the original name can only
 * be recovered by matching against the servers we know about — which is why
 * `knownServers` exists. Without a match the sanitised segment is returned as
 * the name; that is still enough to label the card, and the caller finds out it
 * cannot reach the server when the resolution fails.
 */
export function parseQualifiedToolName(
  qualified: string,
  knownServers: readonly string[] = [],
): QualifiedToolName | null {
  if (!qualified.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = qualified.slice(MCP_TOOL_PREFIX.length);
  for (const server of knownServers) {
    const prefix = `${sanitizeSegment(server)}__`;
    if (rest.startsWith(prefix)) {
      const toolName = rest.slice(prefix.length);
      if (toolName.length > 0) return { serverName: server, toolName };
    }
  }
  const split = rest.indexOf("__");
  if (split <= 0 || split + 2 >= rest.length) return null;
  return { serverName: rest.slice(0, split), toolName: rest.slice(split + 2) };
}
