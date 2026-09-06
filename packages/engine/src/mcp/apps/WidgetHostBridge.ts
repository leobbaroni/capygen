/**
 * The main-process half of the MCP Apps host (SPEC R31).
 *
 * ## Why this exists at all
 *
 * A widget is HTML that lives *inside an MCP server*, behind a `ui://` URI that
 * only an MCP client can read. The spike (docs/spikes/mcp-apps.md) established
 * that the backend running the tool will not hand that HTML over:
 *
 *   - the **Claude Agent SDK** stream carries the tool call, its input and its
 *     `structuredContent`, but strips the tool definition's `_meta` — so the
 *     `ui://` URI is not on the wire at all (§b2). `q.mcpServerStatus()` gives
 *     the server's *config*, which is the way back in: capygen opens its own
 *     MCP client to the same server and asks it directly (§b3).
 *   - the **Codex app-server** does better: `mcpToolCall` items carry both
 *     `_meta` and an explicit `appContext.resourceUri`, and `mcpServer/
 *     resource/read` reads the document for us (§d).
 *   - a **claude.ai connector** (`type: "claudeai-proxy"`) can be reached by
 *     neither: the config is a bare upstream URL plus an Anthropic-side id, and
 *     no local credential exists for it (§c). Those fall back to the rich
 *     result card.
 *
 * So the bridge is deliberately *not* tied to one backend: it takes a
 * {@link WidgetMcpAccess} — "something that can list tools, read a resource and
 * call a tool on a named server" — and every backend supplies its own.
 *
 * ## What it holds
 *
 * One {@link WidgetState} per widget block: the server it belongs to, its
 * resolved HTML and the resource's security metadata. That state is what makes
 * `widget.callTool` safe to expose to renderer code — see {@link callTool}.
 */
import type { BlockPatch } from "../../harness.js";
import type { WidgetToolResult } from "@capygen/shared";
import {
  buildAllowAttribute,
  buildWidgetCsp,
  isModelOnlyTool,
  parseQualifiedToolName,
  readResourceMeta,
  readUiResourceUri,
  type WidgetResourceMeta,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// the seam every backend implements
// ---------------------------------------------------------------------------

export interface WidgetToolInfo {
  name: string;
  /** The tool's `_meta`, verbatim — `ui.resourceUri` lives here. */
  meta?: unknown;
}

export interface WidgetResourceContents {
  uri?: string;
  mimeType?: string;
  text?: string;
  /** Base64, for a non-text resource. */
  blob?: string;
  meta?: unknown;
}

export interface WidgetCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
  [key: string]: unknown;
}

/**
 * Everything the host needs from *one* backend's MCP layer. Implemented over
 * `McpClientPool` for Claude and API agents (our own client, from the config
 * `mcpServerStatus()` reports) and over `mcpServer/{resource/read,tool/call}`
 * for Codex.
 */
export interface WidgetMcpAccess {
  /** Configured server names, used to un-sanitise `mcp__<server>__<tool>`. */
  serverNames?(): readonly string[];
  /** Why this server cannot be reached, if it cannot (a proxy connector). */
  unreachable?(serverName: string): string | undefined;
  listTools(serverName: string): Promise<readonly WidgetToolInfo[]>;
  readResource(serverName: string, uri: string): Promise<readonly WidgetResourceContents[]>;
  callTool(serverName: string, toolName: string, args: unknown): Promise<WidgetCallResult>;
}

export interface WidgetHostLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const NO_LOG: WidgetHostLogger = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** Identifies which tool call a widget renders for. */
export interface WidgetTarget {
  serverName: string;
  toolName: string;
  /** Present when the backend already told us the URI (Codex, or a result `_meta`). */
  resourceUri?: string | undefined;
}

export interface OpenWidgetInput extends WidgetTarget {
  sessionId: string;
  agentId: string;
  blockId: string;
  /** The `tool_use` id, so the card can sit next to its tool_call block. */
  toolCallId: string;
  toolInput: unknown;
  /** `_meta` from the tool definition, when the backend exposes it. */
  toolMeta?: unknown;
  /** `_meta` from the tool *result*, when the backend exposes it. */
  resultMeta?: unknown;
  toolResult?: WidgetToolResult | null;
}

export interface WidgetState {
  sessionId: string;
  agentId: string;
  blockId: string;
  serverName: string;
  toolName: string;
  resourceUri: string | null;
  html: string | null;
  status: "pending" | "ready" | "unavailable";
  /** Why the widget is unavailable — shown on the fallback card. */
  reason?: string;
  /** The `ui://` resource's own `_meta.ui` (CSP, permissions, border). */
  resourceMeta: WidgetResourceMeta;
  /** The exact `Content-Security-Policy` the document must be served with. */
  csp: string;
  /** The iframe `allow` attribute the resource asked for (usually empty). */
  allow: string;
  toolInput: unknown;
  toolResult: WidgetToolResult | null;
  meta: unknown;
  /** Last size the widget negotiated over the bridge (`size-changed`). */
  size?: { width?: number; height?: number };
}

export interface WidgetResolution {
  state: WidgetState;
  /** The block upsert the transcript should show for this widget. */
  patch: BlockPatch;
}

export interface WidgetHostBridgeDeps {
  access: WidgetMcpAccess;
  log?: WidgetHostLogger;
  /** Cap on a widget document, so a hostile server cannot exhaust the heap. */
  maxHtmlBytes?: number;
}

/** 4 MB of HTML is already an order of magnitude past any real widget. */
export const DEFAULT_MAX_WIDGET_HTML_BYTES = 4 * 1024 * 1024;

/** Thrown when a widget asked for something the host refuses on policy. */
export class WidgetPolicyError extends Error {}

export class WidgetHostBridge {
  private readonly access: WidgetMcpAccess;
  private readonly log: WidgetHostLogger;
  private readonly maxHtmlBytes: number;
  private readonly widgets = new Map<string, WidgetState>();
  /** `serverName` → its tools, listed once per host (SPEC R26). */
  private readonly toolCache = new Map<string, Promise<readonly WidgetToolInfo[]>>();

  constructor(deps: WidgetHostBridgeDeps) {
    this.access = deps.access;
    this.log = deps.log ?? NO_LOG;
    this.maxHtmlBytes = deps.maxHtmlBytes ?? DEFAULT_MAX_WIDGET_HTML_BYTES;
  }

  /**
   * Does this tool call carry a widget? Answers from the `_meta` the backend
   * *did* expose, without connecting to anything.
   *
   * `null` means "no widget here as far as the stream can tell" — which is the
   * Claude case for every MCP App, since the SDK strips the tool `_meta`
   * (spike §b2). Use {@link resolveTarget} when a connection is affordable.
   */
  detect(qualifiedToolName: string, metas: { toolMeta?: unknown; resultMeta?: unknown } = {}):
    | WidgetTarget
    | null {
    const parsed = parseQualifiedToolName(qualifiedToolName, this.serverNames());
    if (!parsed) return null;
    const uri = readUiResourceUri(metas.resultMeta) ?? readUiResourceUri(metas.toolMeta);
    if (!uri) return null;
    return { ...parsed, resourceUri: uri };
  }

  /**
   * The full lookup: `_meta` first, then the server's own `tools/list`.
   *
   * This is the step that costs a connection, so it only runs for tool calls
   * that reached a *result* — a widget with no result has nothing to render
   * anyway — and the listing is cached per server for the life of the host.
   * A server we cannot reach never gets asked.
   */
  async resolveTarget(
    qualifiedToolName: string,
    metas: { toolMeta?: unknown; resultMeta?: unknown } = {},
  ): Promise<WidgetTarget | null> {
    const parsed = parseQualifiedToolName(qualifiedToolName, this.serverNames());
    if (!parsed) return null;
    const fromMeta = readUiResourceUri(metas.resultMeta) ?? readUiResourceUri(metas.toolMeta);
    if (fromMeta) return { ...parsed, resourceUri: fromMeta };
    if (this.access.unreachable?.(parsed.serverName)) return null;
    try {
      const tools = await this.listTools(parsed.serverName);
      const tool = tools.find((t) => t.name === parsed.toolName);
      const uri = readUiResourceUri(tool?.meta);
      if (!uri) return null;
      return { ...parsed, resourceUri: uri };
    } catch (err) {
      this.log.warn(`[widget] could not list ${parsed.serverName}: ${describe(err)}`);
      return null;
    }
  }

  /**
   * Register a widget and fetch its document.
   *
   * Always resolves — a widget that cannot be loaded becomes an `unavailable`
   * state with a reason, never a rejected promise, because the transcript still
   * has to show *something* where the tool result was.
   */
  async open(input: OpenWidgetInput): Promise<WidgetResolution> {
    const base: WidgetState = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      blockId: input.blockId,
      serverName: input.serverName,
      toolName: input.toolName,
      resourceUri: input.resourceUri ?? null,
      html: null,
      status: "pending",
      resourceMeta: {},
      csp: buildWidgetCsp(undefined),
      allow: "",
      toolInput: input.toolInput,
      toolResult: input.toolResult ?? null,
      meta: input.resultMeta ?? input.toolMeta ?? null,
    };
    this.widgets.set(input.blockId, base);

    const state = await this.load(base, input);
    this.widgets.set(input.blockId, state);
    return { state, patch: toBlockPatch(input, state) };
  }

  private async load(base: WidgetState, input: OpenWidgetInput): Promise<WidgetState> {
    const unreachable = this.access.unreachable?.(input.serverName);
    if (unreachable) return { ...base, status: "unavailable", reason: unreachable };

    let uri = input.resourceUri ?? null;
    if (!uri) {
      const target = await this.resolveTarget(
        `mcp__${input.serverName}__${input.toolName}`,
        input,
      ).catch(() => null);
      uri = target?.resourceUri ?? null;
    }
    if (!uri) {
      return {
        ...base,
        status: "unavailable",
        reason: `${input.serverName} does not declare a ui:// resource for ${input.toolName}`,
      };
    }

    try {
      const contents = await this.access.readResource(input.serverName, uri);
      const item = contents.find((c) => typeof c.text === "string") ?? contents[0];
      const html = typeof item?.text === "string" ? item.text : null;
      if (html === null) {
        return {
          ...base,
          resourceUri: uri,
          status: "unavailable",
          reason: `${uri} has no text content (mimeType ${String(item?.mimeType)})`,
        };
      }
      if (html.length > this.maxHtmlBytes) {
        return {
          ...base,
          resourceUri: uri,
          status: "unavailable",
          reason: `${uri} is ${html.length} bytes, over capygen's ${this.maxHtmlBytes}-byte widget limit`,
        };
      }
      const resourceMeta = readResourceMeta(item?.meta, input.toolMeta);
      this.log.info(
        `[widget] ${input.serverName}/${input.toolName} → ${uri} (${html.length} bytes)`,
      );
      return {
        ...base,
        resourceUri: uri,
        html,
        status: "ready",
        resourceMeta,
        csp: buildWidgetCsp(resourceMeta.csp),
        allow: buildAllowAttribute(resourceMeta.permissions),
      };
    } catch (err) {
      const reason = describe(err);
      this.log.warn(`[widget] ${input.serverName} ${uri} failed: ${reason}`);
      return { ...base, resourceUri: uri, status: "unavailable", reason };
    }
  }

  /**
   * A widget asking the host to call a tool (`tools/call` over the ext-apps
   * bridge).
   *
   * Two rules, both enforced here rather than in the renderer, because the
   * renderer is the side a compromised widget talks to:
   *
   *   1. **only the widget's own server.** ext-apps says an App tool is
   *      "callable by the app from this server only"; a widget must not be able
   *      to reach a *different* server's tools just because the host can.
   *   2. **not a model-only tool.** A tool the server marked
   *      `visibility: ["model"]` is off-limits to the app.
   *
   * Rule 2 needs the tool listing, which is cached; if the listing is
   * unavailable the call still goes through (the server is the final authority
   * and will refuse what it does not want) — failing the call closed would
   * break every widget on a server whose listing momentarily failed.
   */
  async callTool(blockId: string, toolName: string, args: unknown): Promise<WidgetCallResult> {
    const state = this.widgets.get(blockId);
    if (!state) throw new Error(`no widget is open for block ${blockId}`);
    if (typeof toolName !== "string" || toolName.length === 0) {
      throw new Error("a widget tool call needs a tool name");
    }

    try {
      const tools = await this.listTools(state.serverName);
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        throw new WidgetPolicyError(
          `${state.serverName} has no tool named ${JSON.stringify(toolName)}`,
        );
      }
      if (isModelOnlyTool(tool.meta)) {
        throw new WidgetPolicyError(
          `${toolName} is marked visibility:["model"] — a widget may not call it`,
        );
      }
    } catch (err) {
      // A *policy* refusal must propagate; a listing failure must not.
      if (err instanceof WidgetPolicyError) throw err;
      this.log.warn(`[widget] ${state.serverName} tool listing unavailable: ${describe(err)}`);
    }

    this.log.info(`[widget] ${state.blockId} calls ${state.serverName}/${toolName}`);
    return this.access.callTool(state.serverName, toolName, args);
  }

  /** The state behind a block id — the desktop serves its HTML from this. */
  get(blockId: string): WidgetState | undefined {
    return this.widgets.get(blockId);
  }

  /** Remember a size the widget negotiated, so a reopened session keeps it. */
  setSize(blockId: string, size: { width?: number; height?: number }): WidgetState | undefined {
    const state = this.widgets.get(blockId);
    if (!state) return undefined;
    const next: WidgetState = { ...state, size };
    this.widgets.set(blockId, next);
    return next;
  }

  close(blockId: string): void {
    this.widgets.delete(blockId);
  }

  /** Drop every widget of one session (the session was closed or archived). */
  closeSession(sessionId: string): void {
    for (const [id, state] of this.widgets) {
      if (state.sessionId === sessionId) this.widgets.delete(id);
    }
  }

  dispose(): void {
    this.widgets.clear();
    this.toolCache.clear();
  }

  private serverNames(): readonly string[] {
    return this.access.serverNames?.() ?? [];
  }

  private listTools(serverName: string): Promise<readonly WidgetToolInfo[]> {
    const cached = this.toolCache.get(serverName);
    if (cached) return cached;
    const pending = this.access.listTools(serverName).catch((err: unknown) => {
      this.toolCache.delete(serverName);
      throw err;
    });
    this.toolCache.set(serverName, pending);
    return pending;
  }
}

/**
 * The `widget` block a resolved widget renders as. `html` rides the block so a
 * relaunched app can show the widget from the database without reconnecting to
 * the server that produced it — which for a stdio server means without
 * re-spawning it.
 */
export function toBlockPatch(input: OpenWidgetInput, state: WidgetState): BlockPatch {
  return {
    kind: "widget",
    toolCallId: input.toolCallId,
    serverName: state.serverName,
    toolName: state.toolName,
    // The schema requires a `ui://` URI; an unresolved widget still has to be
    // renderable, so it carries the URI we *looked for* under a stable
    // placeholder rather than failing validation and losing the card entirely.
    resourceUri: state.resourceUri ?? `ui://unresolved/${state.serverName}/${state.toolName}`,
    html: state.html,
    htmlStatus: state.status === "pending" ? "pending" : state.status,
    toolInput: input.toolInput,
    toolResult: state.toolResult,
    meta: state.meta ?? null,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
