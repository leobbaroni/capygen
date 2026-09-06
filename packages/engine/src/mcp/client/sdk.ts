/**
 * The `@modelcontextprotocol/sdk` surface capygen uses, loaded the same way the
 * Claude SDK is: **types statically, runtime lazily**.
 *
 * The lazy `import()` is what makes R26 possible at the module level — a session
 * with no MCP servers never loads the MCP SDK at all — and it is what lets the
 * tests drive `McpClientPool` against an in-process fake without the real
 * transport ever being constructed.
 *
 * Unlike the Claude SDK this package is a dual build (`dist/esm` + `dist/cjs`,
 * verified in its `exports` map), so bundling it into `main.cjs` would also
 * work; the lazy load is for the reasons above, not out of necessity.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpClient = Client;
export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

/** The three constructors the pool needs — the seam a test replaces. */
export interface McpSdk {
  Client: new (
    info: { name: string; version: string },
    options?: { capabilities?: Record<string, unknown> },
  ) => Client;
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: "pipe" | "ignore" | "inherit";
  }) => StdioClientTransport;
  StreamableHTTPClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers?: Record<string, string> } },
  ) => StreamableHTTPClientTransport;
}

export const MCP_SDK_PACKAGE = "@modelcontextprotocol/sdk";

let cached: Promise<McpSdk> | null = null;

export function loadMcpSdk(): Promise<McpSdk> {
  cached ??= (async (): Promise<McpSdk> => {
    const [client, stdio, http] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    return {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    } as McpSdk;
  })().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
