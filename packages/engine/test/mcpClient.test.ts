/**
 * The generic MCP client (SPEC R9, R26, R28, R31).
 *
 * Two halves, tested two ways:
 *
 *  - the **config loader** is pure, so it runs against injected file contents —
 *    the real `~/.claude/settings.json` and `~/.codex/config.toml` on this
 *    machine are the user's, not a fixture;
 *  - the **pool** runs twice: against a fake SDK (to prove laziness and the
 *    failure bookkeeping deterministically) and, in the last block, against the
 *    real `@modelcontextprotocol/sdk` client talking to a real child process
 *    (`mcpClientFixtureServer.mjs`) over stdio. The second is what proves the
 *    thing that matters — that capygen interoperates with a server it did not
 *    write — and it is also where the "listed once, lazily" claim is checked
 *    against the server's own log of the requests it received.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientPool, loadMcpSdk } from "../src/mcp/client/index.js";
import {
  fromMcpServersObject,
  loadMcpServers,
  parseCodexMcpServers,
} from "../src/mcp/client/config.js";
import {
  MCP_APPS_RESOURCE_URI_META_KEY,
  qualifyToolName,
  widgetResourceUri,
  type McpSdk,
  type McpServerConfig,
} from "../src/mcp/client/index.js";
import { flattenMcpContent, mcpToolDefinitions } from "../src/tools/mcpTools.js";
import type { ToolContext } from "../src/tools/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(HERE, "mcpClientFixtureServer.mjs");

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: HERE,
    log: SILENT,
    maxOutputChars: 64 * 1024,
    ask: async () => ({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// config sources (R28/R29: the backends' own files are the source of truth)
// ---------------------------------------------------------------------------

describe("loadMcpServers", () => {
  it("reads all four sources and lets the earlier one win by name", async () => {
    const home = "C:/Users/test";
    const project = "C:/repo";
    const files: Record<string, string> = {
      [path.join(project, ".mcp.json")]: JSON.stringify({
        mcpServers: {
          shared: { command: "project-wins" },
          repo: { command: "node", args: ["repo.js"] },
        },
      }),
      [path.join(home, ".claude", "settings.json")]: JSON.stringify({
        mcpServers: {
          shared: { command: "claude-loses" },
          remote: { type: "http", url: "https://example.com/mcp", headers: { A: "b" } },
        },
      }),
      [path.join(home, ".codex", "config.toml")]: [
        "model = 'gpt-5'",
        "",
        '[mcp_servers.codexonly]',
        'command = "npx"',
        'args = ["-y", "some-server"]',
        'env = { TOKEN = "t" }',
        "",
        "[mcp_servers.off]",
        'command = "x"',
        "enabled = false",
      ].join("\n"),
    };

    const servers = await loadMcpServers({
      home,
      projectPath: project,
      agentConfig: { mcpServers: { agentone: { command: "agent" } } },
      readFile: async (file) => files[file],
    });

    const byName = new Map(servers.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual([
      "agentone",
      "codexonly",
      "off",
      "remote",
      "repo",
      "shared",
    ]);
    // agent > project > claude settings > codex config.
    expect(byName.get("shared")?.command).toBe("project-wins");
    expect(byName.get("shared")?.source).toBe("project-mcp-json");
    expect(byName.get("agentone")?.source).toBe("agent");
    expect(byName.get("remote")).toMatchObject({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { A: "b" },
      source: "claude-settings",
    });
    expect(byName.get("codexonly")).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-server"],
      env: { TOKEN: "t" },
      source: "codex-config",
    });
    expect(byName.get("off")?.disabled).toBe(true);
  });

  it("ignores a settings file that is not valid JSON instead of failing the session", async () => {
    const warnings: unknown[][] = [];
    const servers = await loadMcpServers({
      home: "C:/h",
      readFile: async (file) => (file.endsWith("settings.json") ? "{ not json" : undefined),
      log: { warn: (...args) => warnings.push(args) },
    });
    expect(servers).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("infers the transport from what the entry actually has", () => {
    const servers = fromMcpServersObject(
      {
        stdioish: { command: "node", args: ["s.js"], cwd: "C:/x" },
        urlish: { url: "https://a/mcp" },
        declared: { type: "streamable-http", url: "https://b/mcp" },
        legacy: { type: "sse", url: "https://c/sse" },
      },
      "agent",
    );
    const byName = new Map(servers.map((s) => [s.name, s.transport]));
    expect(byName.get("stdioish")).toBe("stdio");
    expect(byName.get("urlish")).toBe("http");
    expect(byName.get("declared")).toBe("http");
    expect(byName.get("legacy")).toBe("sse");
  });

  it("reads the corners of ~/.codex/config.toml that actually occur", () => {
    const servers = parseCodexMcpServers(
      [
        "# a comment",
        '[mcp_servers."dotted.name"]',
        'command = "cmd" # trailing comment',
        "startup_timeout_sec = 30",
        "",
        "[mcp_servers.nested.env]",
        'IGNORED = "yes"',
        "",
        "[mcp_servers.http_one]",
        'url = "https://h/mcp"',
        'http_headers = { Authorization = "Bearer x" }',
      ].join("\n"),
    );
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.get("dotted.name")?.command).toBe("cmd");
    // A nested `[mcp_servers.a.b]` table is not a server.
    expect(byName.has("nested.env")).toBe(false);
    expect(byName.get("http_one")).toMatchObject({
      transport: "http",
      url: "https://h/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });
});

// ---------------------------------------------------------------------------
// the pool, against a fake SDK
// ---------------------------------------------------------------------------

interface FakeCalls {
  connects: string[];
  listTools: number;
}

function fakeSdk(calls: FakeCalls, options: { failFor?: string } = {}): McpSdk {
  class FakeClient {
    private label = "";
    async connect(transport: { label?: string }): Promise<void> {
      this.label = transport.label ?? "?";
      if (options.failFor === this.label) throw new Error(`cannot start ${this.label}`);
      calls.connects.push(this.label);
    }
    async listTools(): Promise<unknown> {
      calls.listTools += 1;
      return {
        tools: [
          {
            name: "search",
            description: "search things",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            _meta: { [MCP_APPS_RESOURCE_URI_META_KEY]: "ui://x/view.html" },
          },
          {
            name: "lookup",
            description: "read-only lookup",
            inputSchema: { type: "object", properties: {} },
            // Top-level sibling of inputSchema, as the MCP spec defines it.
            annotations: { readOnlyHint: true },
          },
          { name: "" },
        ],
      };
    }
    async callTool(): Promise<unknown> {
      return { content: [{ type: "text", text: "hi" }], _meta: { keep: 1 } };
    }
    async readResource(): Promise<unknown> {
      return { contents: [{ uri: "ui://x/view.html", mimeType: "text/html", text: "<p>x</p>" }] };
    }
    async close(): Promise<void> {}
  }
  return {
    Client: FakeClient as unknown as McpSdk["Client"],
    StdioClientTransport: function (params: { command: string }) {
      return { label: params.command, close: async () => {} };
    } as unknown as McpSdk["StdioClientTransport"],
    StreamableHTTPClientTransport: function (url: URL) {
      return { label: url.toString(), close: async () => {} };
    } as unknown as McpSdk["StreamableHTTPClientTransport"],
  };
}

const STDIO: McpServerConfig = { name: "alpha", transport: "stdio", command: "a", source: "agent" };

describe("McpClientPool", () => {
  it("connects nothing until a tool is actually needed (R26)", async () => {
    const calls: FakeCalls = { connects: [], listTools: 0 };
    const pool = new McpClientPool({
      servers: [STDIO, { name: "beta", transport: "stdio", command: "b", source: "agent" }],
      sdk: fakeSdk(calls),
      log: SILENT,
    });
    // Listing the *config* must not start a process.
    expect(pool.list().map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(calls.connects).toEqual([]);

    await pool.listTools("alpha");
    expect(calls.connects).toEqual(["a"]);
    expect(calls.listTools).toBe(1);
    await pool.close();
  });

  it("lists a server's tools once per session, not once per turn (R26)", async () => {
    const calls: FakeCalls = { connects: [], listTools: 0 };
    const pool = new McpClientPool({ servers: [STDIO], sdk: fakeSdk(calls), log: SILENT });
    await pool.listTools("alpha");
    await pool.listTools("alpha");
    await pool.listAllTools();
    expect(calls.listTools).toBe(1);
    expect(calls.connects).toEqual(["a"]);
    await pool.close();
  });

  it("qualifies tool names and keeps the tool's _meta", async () => {
    const pool = new McpClientPool({
      servers: [{ ...STDIO, name: "my server" }],
      sdk: fakeSdk({ connects: [], listTools: 0 }),
      log: SILENT,
    });
    const tools = await pool.listTools("my server");
    expect(tools).toHaveLength(2); // the nameless entry is dropped
    expect(tools[0]?.qualifiedName).toBe("mcp__my_server__search");
    expect(qualifyToolName("my server", "search")).toBe("mcp__my_server__search");
    expect(widgetResourceUri(tools[0]?.meta)).toBe("ui://x/view.html");
    await pool.close();
  });

  it("never connects a disabled server, and says why", async () => {
    const calls: FakeCalls = { connects: [], listTools: 0 };
    const pool = new McpClientPool({
      servers: [{ ...STDIO, disabled: true }],
      sdk: fakeSdk(calls),
      log: SILENT,
    });
    expect(pool.enabled()).toEqual([]);
    await expect(pool.listTools("alpha")).rejects.toThrow(/disabled/);
    expect(calls.connects).toEqual([]);
    await pool.close();
  });

  it("lets one broken server cost only its own tools, and remembers the reason", async () => {
    const calls: FakeCalls = { connects: [], listTools: 0 };
    const pool = new McpClientPool({
      servers: [STDIO, { name: "beta", transport: "stdio", command: "b", source: "agent" }],
      sdk: fakeSdk(calls, { failFor: "a" }),
      log: SILENT,
    });
    const tools = await pool.listAllTools();
    expect([...new Set(tools.map((t) => t.serverName))]).toEqual(["beta"]);
    expect(pool.failureReason("alpha")).toContain("cannot start a");
    expect(pool.failureReason("beta")).toBeUndefined();
    await pool.close();
  });

  it("refuses the sse transport with a sentence instead of a timeout", async () => {
    const pool = new McpClientPool({
      servers: [{ name: "legacy", transport: "sse", url: "https://x/sse", source: "agent" }],
      sdk: fakeSdk({ connects: [], listTools: 0 }),
      log: SILENT,
    });
    await expect(pool.listTools("legacy")).rejects.toThrow(/does not speak/);
    await pool.close();
  });

  it("refuses to work after close()", async () => {
    const pool = new McpClientPool({
      servers: [STDIO],
      sdk: fakeSdk({ connects: [], listTools: 0 }),
      log: SILENT,
    });
    await pool.close();
    await expect(pool.callTool("alpha", "search", {})).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// tool bridge
// ---------------------------------------------------------------------------

describe("MCP tools as local tools", () => {
  it("flattens content for the model but never for the record", () => {
    expect(
      flattenMcpContent({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "…", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///a", text: "inline" } },
          { type: "resource_link", uri: "https://x" },
        ],
        structuredContent: { n: 1 },
      }),
    ).toBe("one\n[image]\ninline\n[resource_link https://x]\nstructuredContent: {\"n\":1}");
  });

  it("gates an MCP tool as execute unless the server promises read-only", async () => {
    const pool = new McpClientPool({
      servers: [STDIO],
      sdk: fakeSdk({ connects: [], listTools: 0 }),
      log: SILENT,
    });
    const [tool] = await mcpToolDefinitions(pool);
    expect(tool?.name).toBe("mcp__alpha__search");
    expect(tool?.permissionClass).toBe("execute");
    expect(tool?.family).toBe("mcp");
    expect(tool?.mcp).toEqual({
      serverName: "alpha",
      toolName: "search",
      resourceUri: "ui://x/view.html",
    });
    const result = await tool?.run({ q: "x" }, ctx());
    expect(result?.content).toBe("hi");
    // `_meta` survives on `raw` for the widget host (R31).
    expect((result?.raw as { _meta?: unknown })._meta).toEqual({ keep: 1 });
    await pool.close();
  });

  it("honours a server's top-level annotations.readOnlyHint (R26: no needless card)", async () => {
    const pool = new McpClientPool({
      servers: [STDIO],
      sdk: fakeSdk({ connects: [], listTools: 0 }),
      log: SILENT,
    });
    const tools = await mcpToolDefinitions(pool);
    const lookup = tools.find((t) => t.name === "mcp__alpha__lookup");
    // `annotations` is a sibling of `inputSchema`, not a member of it; reading
    // it from inside the schema meant this was always "execute", so every
    // read-only server tool blocked the turn on a permission card.
    expect(lookup?.permissionClass).toBe("read");
    await pool.close();
  });

  it("reports a call against a dead server as a tool error, not a throw", async () => {
    // The tool definition is built while the server still answers…
    const calls: FakeCalls = { connects: [], listTools: 0 };
    const pool = new McpClientPool({ servers: [STDIO], sdk: fakeSdk(calls), log: SILENT });
    const [tool] = await mcpToolDefinitions(pool);
    // …and the server is gone by the time the model calls it.
    await pool.close();
    const result = await tool?.run({ q: "x" }, ctx());
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("mcp__alpha__search failed");
  });
});

// ---------------------------------------------------------------------------
// the real SDK against a real stdio server
// ---------------------------------------------------------------------------

let logFile = "";

afterEach(async () => {
  if (logFile) {
    await fs.rm(logFile, { force: true });
    logFile = "";
  }
});

describe("a real stdio MCP server", () => {
  it("lists lazily, calls a tool and reads a ui:// resource, all through the real SDK", async () => {
    logFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "capygen-mcp-")),
      "requests.log",
    );
    const sdk = await loadMcpSdk();
    const pool = new McpClientPool({
      servers: [
        {
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE_SERVER],
          env: { CAPYGEN_FIXTURE_LOG: logFile },
          source: "agent",
        },
      ],
      sdk,
      env: process.env,
      log: SILENT,
    });

    try {
      // Nothing has been asked for yet: no process, no requests.
      expect(pool.list()).toHaveLength(1);
      await expect(fs.readFile(logFile, "utf8")).rejects.toThrow();

      const tools = await mcpToolDefinitions(pool);
      expect(tools.map((t) => t.name)).toEqual([
        "mcp__fixture__echo",
        "mcp__fixture__widget_card",
        "mcp__fixture__boom",
      ]);

      const echo = tools.find((t) => t.name === "mcp__fixture__echo");
      const echoed = await echo?.run({ text: "round trip" }, ctx());
      expect(echoed?.content).toBe("round trip");
      expect(echoed?.isError).toBeUndefined();

      // R31: the tool declares a ui:// resource; the result keeps _meta whole.
      const widget = tools.find((t) => t.name === "mcp__fixture__widget_card");
      expect(widget?.mcp?.resourceUri).toBe("ui://capygen-fixture/card.html");
      const carded = await widget?.run({ title: "Sales" }, ctx());
      const raw = carded?.raw as { structuredContent?: unknown; _meta?: unknown };
      expect(raw.structuredContent).toEqual({ title: "Sales", count: 2 });
      expect(raw._meta).toEqual({
        "ui/resourceUri": "ui://capygen-fixture/card.html",
        extra: "kept",
      });
      expect(carded?.content).toContain("card: Sales");
      expect(carded?.content).toContain('structuredContent: {"title":"Sales","count":2}');

      // A server-reported error is a tool error, not a throw.
      const boom = tools.find((t) => t.name === "mcp__fixture__boom");
      const failed = await boom?.run({}, ctx());
      expect(failed?.isError).toBe(true);
      expect(failed?.content).toContain("it exploded");

      // The widget host's fetch path (R31).
      const contents = await pool.readResource("fixture", "ui://capygen-fixture/card.html");
      expect(contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(contents[0]?.text).toContain("hello widget");

      // Asking again must not re-list: the schemas are cached for the session.
      await pool.listTools("fixture");
      const log = (await fs.readFile(logFile, "utf8")).trim().split("\n");
      expect(log.filter((line) => line === "tools/list")).toHaveLength(1);
      expect(log.filter((line) => line === "tools/call")).toHaveLength(3);
      expect(log[0]).toBe("initialize");
    } finally {
      await pool.close();
    }
  }, 30_000);
});
