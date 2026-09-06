/**
 * One MCP connection pool per session: connect lazily, list once, pass results
 * through untouched.
 *
 * **Lazy is the point** (SPEC R26). A server is a child process (or an HTTP
 * session); connecting to five of them at harness start would cost seconds and
 * memory for tools the turn may never use. So:
 *
 *   - nothing connects until `listTools`, `callTool` or `readResource` names
 *     that server;
 *   - `listTools` is cached per server for the life of the pool, so the schemas
 *     are fetched once per session rather than once per turn;
 *   - a server that fails to connect is remembered as failed, reported once,
 *     and never retried in a tight loop — one broken server must not make every
 *     turn slow.
 *
 * **Pass-through is the other point** (SPEC R31). `callTool` returns the raw
 * result object: `content`, `structuredContent` and `_meta` all intact, because
 * the MCP Apps widget host reads a widget's `ui://` resource out of `_meta` and
 * a normalised result would have nothing left to read.
 */
import { loadMcpSdk, type McpClient, type McpSdk } from "./sdk.js";
import {
  qualifyToolName,
  type McpCallResult,
  type McpResourceContents,
  type McpServerConfig,
  type McpToolInfo,
} from "./types.js";

export interface McpPoolLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NO_LOG: McpPoolLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface McpClientPoolDeps {
  servers: readonly McpServerConfig[];
  /** Injected in tests; the real SDK is loaded lazily when absent. */
  sdk?: McpSdk;
  loadSdk?: () => Promise<McpSdk>;
  log?: McpPoolLogger;
  /** Base env for stdio children (`cleanEnv` is applied by the caller). */
  env?: Record<string, string | undefined>;
  clientInfo?: { name: string; version: string };
}

interface Connection {
  client: McpClient;
  close: () => Promise<void>;
}

export class McpClientPool {
  private readonly deps: McpClientPoolDeps;
  private readonly log: McpPoolLogger;
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly toolCache = new Map<string, Promise<McpToolInfo[]>>();
  private readonly failed = new Map<string, string>();
  private closed = false;

  constructor(deps: McpClientPoolDeps) {
    this.deps = deps;
    this.log = deps.log ?? NO_LOG;
    for (const server of deps.servers) this.servers.set(server.name, server);
  }

  /** Every configured server, enabled or not — Settings ▸ MCP lists these. */
  list(): McpServerConfig[] {
    return [...this.servers.values()];
  }

  /** Servers we will actually connect to. */
  enabled(): McpServerConfig[] {
    return this.list().filter((server) => server.disabled !== true);
  }

  /** Why a server is unusable, once we have found out. */
  failureReason(name: string): string | undefined {
    return this.failed.get(name);
  }

  /**
   * Tools from every enabled server, connecting on first use. A server that
   * cannot be reached contributes nothing and is logged once — the turn still
   * runs with the tools that did answer.
   */
  async listAllTools(): Promise<McpToolInfo[]> {
    const results = await Promise.all(
      this.enabled().map(async (server) => {
        try {
          return await this.listTools(server.name);
        } catch (err) {
          this.rememberFailure(server.name, err);
          return [];
        }
      }),
    );
    return results.flat();
  }

  async listTools(serverName: string): Promise<McpToolInfo[]> {
    const cached = this.toolCache.get(serverName);
    if (cached) return cached;
    const pending = this.fetchTools(serverName).catch((err: unknown) => {
      this.toolCache.delete(serverName);
      throw err;
    });
    this.toolCache.set(serverName, pending);
    return pending;
  }

  private async fetchTools(serverName: string): Promise<McpToolInfo[]> {
    const connection = await this.connect(serverName);
    const response = (await connection.client.listTools()) as {
      tools?: {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
        annotations?: unknown;
        _meta?: unknown;
      }[];
    };
    const tools: McpToolInfo[] = [];
    for (const tool of response.tools ?? []) {
      const name = typeof tool.name === "string" ? tool.name : "";
      if (name.length === 0) continue;
      tools.push({
        name,
        qualifiedName: qualifyToolName(serverName, name),
        serverName,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: isRecord(tool.inputSchema)
          ? tool.inputSchema
          : { type: "object", properties: {} },
        // `annotations` is where `readOnlyHint` actually lives (MCP spec); the
        // permission class is decided from it, so dropping it here meant every
        // server tool was gated as `execute`.
        annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
        meta: isRecord(tool._meta) ? tool._meta : undefined,
      });
    }
    this.log.info(`[mcp] ${serverName}: ${tools.length} tool(s)`);
    return tools;
  }

  /** `tools/call`, result passed through whole (`_meta` included). */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
  ): Promise<McpCallResult> {
    const connection = await this.connect(serverName);
    const result = (await connection.client.callTool({
      name: toolName,
      arguments: isRecord(args) ? args : {},
    })) as unknown as McpCallResult;
    return {
      ...result,
      content: Array.isArray(result.content) ? result.content : [],
    };
  }

  /** `resources/read` — how the widget host fetches a `ui://` document (R31). */
  async readResource(serverName: string, uri: string): Promise<McpResourceContents[]> {
    const connection = await this.connect(serverName);
    const result = (await connection.client.readResource({ uri })) as {
      contents?: unknown[];
    };
    const contents: McpResourceContents[] = [];
    for (const item of result.contents ?? []) {
      if (!isRecord(item)) continue;
      const entry: McpResourceContents = {};
      if (typeof item.uri === "string") entry.uri = item.uri;
      if (typeof item.mimeType === "string") entry.mimeType = item.mimeType;
      if (typeof item.text === "string") entry.text = item.text;
      if (typeof item.blob === "string") entry.blob = item.blob;
      // [B3] `_meta` carries the MCP Apps resource policy (csp, permissions).
      if (item._meta !== undefined) entry.meta = item._meta;
      contents.push(entry);
    }
    return contents;
  }

  // -------------------------------------------------------------------------

  private connect(serverName: string): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error("the MCP pool is closed"));
    const existing = this.connections.get(serverName);
    if (existing) return existing;

    const server = this.servers.get(serverName);
    if (!server) {
      return Promise.reject(new Error(`no MCP server named ${JSON.stringify(serverName)}`));
    }
    if (server.disabled === true) {
      return Promise.reject(new Error(`MCP server ${serverName} is disabled`));
    }

    const pending = this.open(server).catch((err: unknown) => {
      // Drop the rejected promise so a later turn can retry after the user
      // fixes the config, but remember the reason so the UI can show it.
      this.connections.delete(serverName);
      this.rememberFailure(serverName, err);
      throw err;
    });
    this.connections.set(serverName, pending);
    return pending;
  }

  private async open(server: McpServerConfig): Promise<Connection> {
    const sdk = this.deps.sdk ?? (await (this.deps.loadSdk ?? loadMcpSdk)());
    const info = this.deps.clientInfo ?? { name: "capygen", version: "0.1.0" };
    const client = new sdk.Client(info, { capabilities: {} });

    let transport: { close?: () => Promise<void> };
    if (server.transport === "stdio") {
      if (!server.command) throw new Error(`MCP server ${server.name} has no command`);
      transport = new sdk.StdioClientTransport({
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        env: stdioEnv(this.deps.env, server.env),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stderr: "pipe",
      });
    } else if (server.transport === "http") {
      if (!server.url) throw new Error(`MCP server ${server.name} has no url`);
      transport = new sdk.StreamableHTTPClientTransport(new URL(server.url), {
        ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
      });
    } else {
      // SSE is a legacy MCP transport; capygen speaks stdio and streamable HTTP
      // (the two the current CLIs use). Saying so beats a confusing timeout.
      throw new Error(
        `MCP server ${server.name} uses the sse transport, which capygen does not speak; ` +
          "use a streamable-http url instead",
      );
    }

    this.log.info(`[mcp] connecting ${server.name} (${server.transport}, ${server.source})`);
    await client.connect(transport as never);
    this.failed.delete(server.name);
    return {
      client,
      close: async () => {
        try {
          await client.close();
        } catch {
          /* a server that already died cannot be closed politely */
        }
        try {
          await transport.close?.();
        } catch {
          /* same */
        }
      },
    };
  }

  private rememberFailure(serverName: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.failed.get(serverName) !== message) {
      this.log.warn(`[mcp] ${serverName} is unavailable: ${message}`);
    }
    this.failed.set(serverName, message);
    this.toolCache.delete(serverName);
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.connections.values()];
    this.connections.clear();
    this.toolCache.clear();
    await Promise.all(
      pending.map(async (promise) => {
        try {
          const connection = await promise;
          await connection.close();
        } catch {
          /* a connection that never opened has nothing to close */
        }
      }),
    );
  }
}

/**
 * A stdio server's environment. `StdioClientTransport` defaults to a *minimal*
 * inherited env, which breaks servers that need `PATH`, `APPDATA` or a token
 * the user exported — so capygen passes the cleaned parent env plus the
 * server's own overrides, the same contract the CLIs give their servers.
 */
export function stdioEnv(
  base: Record<string, string | undefined> | undefined,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) out[key] = value;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
