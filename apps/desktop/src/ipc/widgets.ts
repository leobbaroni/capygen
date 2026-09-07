/**
 * The desktop half of the MCP Apps widget host (SPEC R31).
 *
 * Four jobs:
 *
 *  1. **serve the document.** A widget is third-party HTML with inline scripts.
 *     It cannot be delivered through `srcdoc`: an `about:srcdoc` frame inherits
 *     the *parent's* CSP, and the renderer ships `script-src 'self'`, so every
 *     widget's inline script — and every remote asset it declared — is blocked.
 *     Measured, not assumed: docs/spikes/mcp-apps.md §a4 has the console
 *     errors. A frame loaded from a **custom scheme** gets its own policy from
 *     the response headers instead, which is the only way to honour a
 *     resource's `_meta.ui.csp`. So each widget is served from
 *     `capygen-widget://<block>/index.html` with a per-widget
 *     `Content-Security-Policy`, and the renderer frames it with
 *     `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`, so the
 *     document's origin is opaque — `window.origin === "null"` and
 *     `localStorage` throws, verified in the same probe).
 *
 *  2. **hold one bridge per project.** MCP servers are per project as well as
 *     per user (`<project>/.mcp.json`), so a widget belongs to the project its
 *     session runs in; the registry keeps one {@link WidgetHostBridge} and one
 *     client pool per project directory and remembers which one owns a block.
 *
 *  3. **answer `widget.callTool`** by routing to that bridge, which refuses any
 *     server but the widget's own, and refuses model-only tools.
 *
 *  4. **answer `widget.event`** — the `ui/*` requests a widget makes of the
 *     host: opening a link in the real browser, saving a file, reporting its
 *     size. Every one of those is a host decision, never the widget's.
 *
 * Electron is injected, so all of this is unit-testable without a running app.
 */
import { createHash } from "node:crypto";
import type { InvokeArgs, InvokeResult } from "@capygen/shared";
import {
  WidgetHostBridge,
  createPoolWidgetAccess,
  McpClientPool,
  cleanEnv,
  type OpenWidgetInput,
  type WidgetMcpAccess,
  type WidgetTarget,
  type WidgetResolution,
  type WidgetState,
  type McpServerConfig,
} from "@capygen/engine";
import { serverListKey, type McpPoolRegistry } from "./mcpPools.js";

/** The privileged scheme widget documents are served from. */
export const WIDGET_SCHEME = "capygen-widget";

/** `protocol.registerSchemesAsPrivileged` entry — must run before `app.ready`. */
export const WIDGET_SCHEME_PRIVILEGES = {
  scheme: WIDGET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: false,
  },
} as const;

/**
 * `blk_1f2e…` → `capygen-widget://blk1f2e…/index.html`.
 *
 * The block id becomes the *host*, so two widgets in one transcript never share
 * an origin even before the sandbox attribute makes each origin opaque. A host
 * label may only hold letters, digits and hyphens, and block ids are
 * `blk_<32 hex>`, so stripping the separator is enough; anything unexpected is
 * hashed rather than rejected. Kept in step with
 * `apps/renderer/src/widgets/url.ts`, which builds the same URL on the other
 * side of the bridge.
 */
export function widgetHost(blockId: string): string {
  const stripped = blockId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (stripped.length > 0 && stripped.length <= 63) return stripped;
  return createHash("sha256").update(blockId).digest("hex").slice(0, 40);
}

export function widgetUrl(blockId: string): string {
  return `${WIDGET_SCHEME}://${widgetHost(blockId)}/index.html`;
}

export interface WidgetHostLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** What the host saves when a widget asks for a download (`ui/download-file`). */
export interface WidgetDownload {
  blockId: string;
  fileName: string;
  mimeType?: string;
  text?: string;
  base64?: string;
  uri?: string;
}

export interface WidgetHostDeps {
  log: WidgetHostLog;
  /** A session's project directory — where `.mcp.json` is looked for. */
  projectPathFor(sessionId: string): string | null;
  /** Builds MCP access from a captured server list. Test seam only. */
  createAccess?(projectPath: string, servers?: readonly McpServerConfig[]): Promise<WidgetMcpAccess>;
  /**
   * The shared, reference-counted MCP pool registry (R26). When present the
   * default access borrows from it instead of opening its own connections, so
   * an `api` agent and the widget host reach one project's servers through one
   * pool. Absent (tests, a profile with no MCP client) each falls back to its
   * own pool, which is what both did before.
   */
  pools?: McpPoolRegistry;
  /** `shell.openExternal`, or a stand-in in tests. */
  openExternal?: (url: string) => Promise<void> | void;
  /** Writes a file the widget asked the host to save; returns whether it did. */
  saveFile?: (file: WidgetDownload) => Promise<boolean> | boolean;
  /** Called when a widget reports a new size, so the block row can keep it. */
  onSize?: (blockId: string, size: { width?: number; height?: number }) => void;
  maxHtmlBytes?: number;
}

/** What the session runner knows about a finished MCP tool call. */
export interface WidgetToolCall {
  sessionId: string;
  agentId: string;
  toolCallId: string;
  /** The qualified name as the model saw it: `mcp__<server>__<tool>`. */
  toolName: string;
  toolInput: unknown;
  toolResult?: { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | null;
  /** `_meta` from the result, when the backend exposed it (Codex does). */
  resultMeta?: unknown;
}

export interface WidgetHostHandlers {
  /** Bind a session to the same immutable server list its harness captured. */
  captureSession?(sessionId: string, agentId: string, servers: readonly McpServerConfig[]): void;
  /** `capygen-widget://…` → the document plus its CSP, or `null`. */
  serve(url: string): { body: string; csp: string } | null;
  /**
   * Does this finished MCP tool call carry a widget? Resolves the target
   * without fetching the document, so the caller can decide whether a widget
   * block is warranted at all. `null` for a tool with no `ui://` resource, an
   * unreachable server, or a name that is not an MCP tool.
   */
  detect(call: WidgetToolCall): Promise<WidgetTarget | null>;
  /** Register a widget for a tool call and fetch its `ui://` document. */
  open(input: OpenWidgetInput & { sessionId: string }): Promise<WidgetResolution>;
  callTool(args: InvokeArgs<"widget.callTool">): Promise<InvokeResult<"widget.callTool">>;
  event(args: InvokeArgs<"widget.event">): Promise<InvokeResult<"widget.event">>;
  readResource(args: InvokeArgs<"mcp.readResource">): Promise<InvokeResult<"mcp.readResource">>;
  get(blockId: string): WidgetState | undefined;
  /** The bridge that owns a session's widgets, creating it on first use. */
  bridgeFor(sessionId: string, agentId: string): Promise<WidgetHostBridge>;
  dispose(): Promise<void>;
}

/** Only web and mail links ever leave the app (`ui/open-link`). */
export function isOpenableLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

interface ProjectHost {
  bridge: WidgetHostBridge;
  access: WidgetMcpAccess;
  close(): Promise<void>;
}

/**
 * Build capygen's MCP access from the exact list captured by the harness.
 * Nothing connects until a widget actually needs a server (SPEC R26).
 */
async function defaultAccess(
  log: WidgetHostLog,
  pools: McpPoolRegistry | undefined,
  captured: readonly McpServerConfig[],
): Promise<{ access: WidgetMcpAccess; close: () => Promise<void> }> {
  const servers = [...captured];
  // Shared with `ApiHarness` when both resolve the same server list, so a
  // project's stdio servers are spawned and listed once per session, not twice
  // (SPEC R26 — `apps/desktop/src/ipc/mcpPools.ts`).
  if (pools) {
    const lease = pools.acquire(servers);
    return { access: createPoolWidgetAccess({ pool: lease.pool }), close: lease.release };
  }
  const pool = new McpClientPool({
    servers,
    env: cleanEnv(),
    log: { info: log.info, warn: log.warn, error: log.warn },
    clientInfo: { name: "capygen-widget-host", version: "0.1.0" },
  });
  return { access: createPoolWidgetAccess({ pool }), close: () => pool.close() };
}

export function createWidgetHost(deps: WidgetHostDeps): WidgetHostHandlers {
  const { log } = deps;
  const hosts = new Map<string, Promise<ProjectHost>>();
  const snapshots = new Map<string, { key: string; servers: readonly McpServerConfig[] }>();
  /** blockId → the project whose bridge owns it. */
  const owner = new Map<string, string>();
  /** widget host label → blockId, so `serve` needs no scan. */
  const byHost = new Map<string, string>();

  function projectFor(sessionId: string): string {
    const path = deps.projectPathFor(sessionId);
    if (!path) throw new Error(`no project directory is known for session ${sessionId}`);
    return path;
  }

  function hostFor(sessionId: string, agentId: string): Promise<ProjectHost> {
    const projectPath = projectFor(sessionId);
    const snapshot = snapshots.get(`${sessionId}:${agentId}`);
    if (!snapshot && !deps.createAccess) {
      throw new Error(`no MCP server snapshot is known for agent ${agentId} in session ${sessionId}`);
    }
    const key = snapshot?.key ?? `test:${projectPath}:${agentId}`;
    const existing = hosts.get(key);
    if (existing) return existing;
    const pending = (async (): Promise<ProjectHost> => {
      if (deps.createAccess) {
        const access = await deps.createAccess(projectPath, snapshot?.servers);
        return {
          access,
          bridge: new WidgetHostBridge({
            access,
            log,
            ...(deps.maxHtmlBytes !== undefined ? { maxHtmlBytes: deps.maxHtmlBytes } : {}),
          }),
          close: async () => {},
        };
      }
      const { access, close } = await defaultAccess(log, deps.pools, snapshot!.servers);
      return {
        access,
        bridge: new WidgetHostBridge({
          access,
          log,
          ...(deps.maxHtmlBytes !== undefined ? { maxHtmlBytes: deps.maxHtmlBytes } : {}),
        }),
        close,
      };
    })().catch((err: unknown) => {
      hosts.delete(key);
      throw err;
    });
    hosts.set(key, pending);
    return pending;
  }

  /**
   * Already-constructed hosts, by project. `serve` runs inside Electron's
   * `protocol.handle` and has to answer synchronously-ish, so it reads this
   * rather than awaiting `hosts`; a widget can only be served after `open`
   * resolved, which is exactly when an entry lands here.
   */
  const settled = new Map<string, ProjectHost>();

  function settledFor(blockId: string): ProjectHost | undefined {
    const projectPath = owner.get(blockId);
    return projectPath ? settled.get(projectPath) : undefined;
  }

  async function hostOf(blockId: string): Promise<ProjectHost> {
    const key = owner.get(blockId);
    if (!key) throw new Error(`no widget is open for block ${blockId}`);
    const host = hosts.get(key);
    if (!host) throw new Error(`no widget host is open for block ${blockId}`);
    return host;
  }

  return {
    captureSession(sessionId, agentId, servers) {
      snapshots.set(`${sessionId}:${agentId}`, { key: serverListKey(servers), servers: servers.map((server) => ({
        ...server,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
        ...(server.headers ? { headers: { ...server.headers } } : {}),
      })) });
    },
    async bridgeFor(sessionId, agentId) {
      return (await hostFor(sessionId, agentId)).bridge;
    },

    async detect(call) {
      const projectPath = deps.projectPathFor(call.sessionId);
      if (!projectPath) return null;
      const key = snapshots.get(`${call.sessionId}:${call.agentId}`)?.key ?? `test:${projectPath}:${call.agentId}`;
      const host = await hostFor(call.sessionId, call.agentId).catch(() => null);
      if (!host) return null;
      settled.set(key, host);
      return host.bridge.resolveTarget(call.toolName, {
        ...(call.resultMeta !== undefined ? { resultMeta: call.resultMeta } : {}),
      });
    },

    serve(url) {
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        return null;
      }
      const blockId = byHost.get(host);
      if (!blockId) return null;
      const state = settledFor(blockId)?.bridge.get(blockId);
      if (!state || state.html === null) return null;
      return { body: state.html, csp: state.csp };
    },

    async open(input) {
      const projectPath = projectFor(input.sessionId);
      const existingKey = owner.get(input.blockId);
      const key = existingKey ??
        snapshots.get(`${input.sessionId}:${input.agentId}`)?.key ??
        `test:${projectPath}:${input.agentId}`;
      const host = existingKey
        ? await (hosts.get(existingKey) ?? Promise.reject(new Error(`no widget host is open for block ${input.blockId}`)))
        : await hostFor(input.sessionId, input.agentId);
      settled.set(key, host);
      owner.set(input.blockId, key);
      byHost.set(widgetHost(input.blockId), input.blockId);
      return host.bridge.open(input);
    },

    async callTool(args) {
      const host = await hostOf(args.blockId);
      const state = host.bridge.get(args.blockId);
      if (!state) throw new Error(`widget.callTool: no widget is open for ${args.blockId}`);
      // The renderer says which session it thinks it is; the host trusts its own
      // record instead, so a renderer bug — or a widget that got hold of the
      // bridge — cannot borrow another session's server connection.
      if (state.sessionId !== args.sessionId) {
        throw new Error(`widget.callTool: ${args.blockId} does not belong to ${args.sessionId}`);
      }
      return host.bridge.callTool(args.blockId, args.name, args.args) as Promise<unknown>;
    },

    async event(args) {
      const payload = isRecord(args.payload) ? args.payload : {};
      switch (args.type) {
        case "ui/open-link": {
          const url = typeof payload.url === "string" ? payload.url : "";
          if (!isOpenableLink(url)) {
            log.warn(`[widget] refused ui/open-link for ${JSON.stringify(url).slice(0, 120)}`);
            return { ok: false };
          }
          if (!deps.openExternal) return { ok: false };
          log.info(`[widget] opening ${url} for block ${args.blockId}`);
          await deps.openExternal(url);
          return { ok: true };
        }
        case "ui/download-file": {
          if (!deps.saveFile) return { ok: false };
          const saved = await deps.saveFile({
            blockId: args.blockId,
            fileName: typeof payload.fileName === "string" ? payload.fileName : "widget-file",
            ...(typeof payload.mimeType === "string" ? { mimeType: payload.mimeType } : {}),
            ...(typeof payload.text === "string" ? { text: payload.text } : {}),
            ...(typeof payload.base64 === "string" ? { base64: payload.base64 } : {}),
            ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}),
          });
          return { ok: saved };
        }
        case "ui/notifications/size-changed": {
          const size = {
            ...(typeof payload.width === "number" ? { width: payload.width } : {}),
            ...(typeof payload.height === "number" ? { height: payload.height } : {}),
          };
          const host = await hostOf(args.blockId).catch(() => null);
          host?.bridge.setSize(args.blockId, size);
          deps.onSize?.(args.blockId, size);
          return { ok: true };
        }
        default:
          log.info(`[widget] ${args.type} from block ${args.blockId} (no host action)`);
          return { ok: true };
      }
    },

    /**
     * A plain `resources/read` — the generic half of the widget path, also used
     * by a widget's own `resources/read` request. Returns the first content
     * item: MCP allows several, but every caller here means "the document
     * behind this URI", and a multi-part answer has no single meaning to hand
     * a renderer.
     */
    async readResource(args) {
      const host = await hostFor(args.sessionId, args.agentId);
      const unreachable = host.access.unreachable?.(args.serverName);
      if (unreachable) throw new Error(`mcp.readResource: ${unreachable}`);
      const contents = await host.access.readResource(args.serverName, args.uri);
      const item = contents.find((c) => typeof c.text === "string") ?? contents[0];
      if (!item) throw new Error(`mcp.readResource: ${args.uri} returned no contents`);
      return {
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.blob !== undefined ? { blob: item.blob } : {}),
      };
    },

    get: (blockId) => settledFor(blockId)?.bridge.get(blockId),

    async dispose() {
      const pending = [...hosts.values()];
      hosts.clear();
      settled.clear();
      owner.clear();
      snapshots.clear();
      byHost.clear();
      await Promise.all(
        pending.map(async (promise) => {
          try {
            const host = await promise;
            host.bridge.dispose();
            await host.close();
          } catch {
            /* a host that never opened has nothing to close */
          }
        }),
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
