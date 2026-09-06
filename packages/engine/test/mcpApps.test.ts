/**
 * The MCP Apps widget host, main-process side (SPEC R31).
 *
 * Three layers, tested at three depths:
 *   1. the protocol constants and `_meta` readers, checked against the real
 *      `@modelcontextprotocol/ext-apps` package so the copied literals in
 *      `protocol.ts` cannot drift;
 *   2. `WidgetHostBridge` against a fake `WidgetMcpAccess` — resolution order,
 *      the unavailable paths, and the two rules `callTool` enforces;
 *   3. one integration pass over the *real* fixture server
 *      (`tests/fixtures/mcp-apps-server`) through the real client pool, which
 *      is the exact path a Claude session takes.
 */
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "@modelcontextprotocol/ext-apps/server";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps/app-bridge";
import { McpClientPool } from "../src/mcp/client/index.js";
import { cleanEnv } from "../src/env.js";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_PROTOCOL_VERSION,
  RESOURCE_MIME_TYPE as OUR_MIME,
  RESOURCE_URI_META_KEY as OUR_URI_KEY,
  WidgetHostBridge,
  buildAllowAttribute,
  buildWidgetCsp,
  createPoolWidgetAccess,
  isModelOnlyTool,
  parseQualifiedToolName,
  readResourceMeta,
  readUiResourceUri,
  type WidgetMcpAccess,
  type WidgetResourceContents,
  type WidgetToolInfo,
} from "../src/mcp/apps/index.js";

const FIXTURE = new URL(
  "../../../tests/fixtures/mcp-apps-server/server.mjs",
  import.meta.url,
).pathname.replace(/^\//, "");

const CARD_URI = "ui://capygen-fixture/card.html";

// ---------------------------------------------------------------------------
// 1. the constants and the readers
// ---------------------------------------------------------------------------

describe("MCP Apps protocol constants", () => {
  it("match @modelcontextprotocol/ext-apps 1.7.5 exactly", () => {
    strictEqual(OUR_MIME, RESOURCE_MIME_TYPE);
    strictEqual(OUR_URI_KEY, RESOURCE_URI_META_KEY);
    strictEqual(MCP_APPS_EXTENSION_ID, EXTENSION_ID);
    strictEqual(MCP_APPS_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION);
  });
});

describe("readUiResourceUri", () => {
  it("reads the nested form", () => {
    strictEqual(readUiResourceUri({ ui: { resourceUri: CARD_URI } }), CARD_URI);
  });
  it("reads the deprecated flat form", () => {
    strictEqual(readUiResourceUri({ [RESOURCE_URI_META_KEY]: CARD_URI }), CARD_URI);
  });
  it("ignores a non-ui:// value instead of throwing", () => {
    // ext-apps' own getToolUiResourceUri throws here; a third-party server must
    // not be able to end a turn with a malformed _meta.
    strictEqual(readUiResourceUri({ ui: { resourceUri: "https://evil.example" } }), undefined);
    strictEqual(readUiResourceUri(null), undefined);
    strictEqual(readUiResourceUri("nope"), undefined);
  });
});

describe("tool visibility", () => {
  it("treats visibility ['model'] as off-limits to the app", () => {
    strictEqual(isModelOnlyTool({ ui: { visibility: ["model"] } }), true);
    strictEqual(isModelOnlyTool({ ui: { visibility: ["model", "app"] } }), false);
    strictEqual(isModelOnlyTool({ ui: { visibility: ["app"] } }), false);
    // Absent visibility means the spec default (both), not "deny".
    strictEqual(isModelOnlyTool({ ui: {} }), false);
  });
});

describe("buildWidgetCsp", () => {
  it("denies everything a resource did not ask for", () => {
    const csp = buildWidgetCsp(undefined);
    match(csp, /^default-src 'none'/);
    match(csp, /connect-src 'none'/);
    match(csp, /frame-src 'none'/);
    match(csp, /base-uri 'none'/);
    match(csp, /form-action 'none'/);
  });
  it("adds exactly the declared origins", () => {
    const csp = buildWidgetCsp({
      connectDomains: ["https://api.example"],
      resourceDomains: ["https://cdn.example"],
    });
    match(csp, /connect-src https:\/\/api\.example/);
    match(csp, /script-src 'unsafe-inline' https:\/\/cdn\.example/);
    match(csp, /img-src data: blob: https:\/\/cdn\.example/);
    // A resource domain must not silently become a connect domain.
    ok(!/connect-src[^;]*cdn\.example/.test(csp));
  });
});

describe("buildAllowAttribute", () => {
  it("maps permissions to the Permission Policy names", () => {
    strictEqual(buildAllowAttribute({ microphone: {}, clipboardWrite: {} }), "microphone; clipboard-write");
    strictEqual(buildAllowAttribute(undefined), "");
  });
});

describe("readResourceMeta", () => {
  it("prefers the resource's own _meta over the tool's", () => {
    const meta = readResourceMeta(
      { ui: { csp: { connectDomains: ["https://a.example"] }, prefersBorder: true } },
      { ui: { csp: { connectDomains: ["https://b.example"] } } },
    );
    deepStrictEqual(meta.csp?.connectDomains, ["https://a.example"]);
    strictEqual(meta.prefersBorder, true);
  });
});

describe("parseQualifiedToolName", () => {
  it("un-sanitises a known server name", () => {
    deepStrictEqual(parseQualifiedToolName("mcp__claude_ai_Higgsfield__balance", ["claude.ai Higgsfield"]), {
      serverName: "claude.ai Higgsfield",
      toolName: "balance",
    });
  });
  it("falls back to the sanitised segment when the server is unknown", () => {
    deepStrictEqual(parseQualifiedToolName("mcp__capyfixture__show_card"), {
      serverName: "capyfixture",
      toolName: "show_card",
    });
  });
  it("rejects a name that is not an MCP tool", () => {
    strictEqual(parseQualifiedToolName("Bash"), null);
  });
});

// ---------------------------------------------------------------------------
// 2. the bridge, against a fake access
// ---------------------------------------------------------------------------

interface FakeAccessOptions {
  tools?: WidgetToolInfo[];
  contents?: WidgetResourceContents[];
  unreachable?: Record<string, string>;
  onCall?: (server: string, tool: string, args: unknown) => unknown;
  failListTools?: boolean;
}

function fakeAccess(options: FakeAccessOptions = {}): {
  access: WidgetMcpAccess;
  calls: Array<{ server: string; tool: string; args: unknown }>;
  reads: string[];
} {
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  const reads: string[] = [];
  const access: WidgetMcpAccess = {
    serverNames: () => ["capyfixture"],
    unreachable: (name) => options.unreachable?.[name],
    listTools: async () => {
      if (options.failListTools) throw new Error("server is down");
      return options.tools ?? [];
    },
    readResource: async (_server, uri) => {
      reads.push(uri);
      return options.contents ?? [];
    },
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { content: [{ type: "text", text: String(options.onCall?.(server, tool, args) ?? "ok") }] };
    },
  };
  return { access, calls, reads };
}

const OPEN = {
  sessionId: "ses_1",
  agentId: "agt_1",
  blockId: "blk_1",
  toolCallId: "toolu_1",
  serverName: "capyfixture",
  toolName: "show_card",
  toolInput: { title: "Hi" },
};

describe("WidgetHostBridge.open", () => {
  it("resolves the ui:// document through tools/list when the stream carried no _meta", async () => {
    // This is the Claude case: the SDK strips the tool's _meta (spike §b2), so
    // the URI has to come from our own listing.
    const { access, reads } = fakeAccess({
      tools: [{ name: "show_card", meta: { ui: { resourceUri: CARD_URI } } }],
      contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: "<!doctype html><p>hi" }],
    });
    const bridge = new WidgetHostBridge({ access });
    const { state, patch } = await bridge.open(OPEN);
    strictEqual(state.status, "ready");
    strictEqual(state.resourceUri, CARD_URI);
    deepStrictEqual(reads, [CARD_URI]);
    strictEqual(patch.kind, "widget");
    if (patch.kind !== "widget") throw new Error("unreachable");
    strictEqual(patch.htmlStatus, "ready");
    strictEqual(patch.resourceUri, CARD_URI);
    strictEqual(patch.html, "<!doctype html><p>hi");
  });

  it("uses the resource's own _meta.ui.csp for the served policy", async () => {
    const { access } = fakeAccess({
      tools: [{ name: "show_card", meta: { ui: { resourceUri: CARD_URI } } }],
      contents: [
        {
          uri: CARD_URI,
          text: "<p>hi",
          meta: { ui: { csp: { connectDomains: ["https://api.example"] }, permissions: { microphone: {} } } },
        },
      ],
    });
    const bridge = new WidgetHostBridge({ access });
    const { state } = await bridge.open(OPEN);
    match(state.csp, /connect-src https:\/\/api\.example/);
    strictEqual(state.allow, "microphone");
  });

  it("marks a proxied connector unavailable without connecting", async () => {
    const { access, reads } = fakeAccess({ unreachable: { "claude.ai Higgsfield": "proxied" } });
    const bridge = new WidgetHostBridge({ access });
    const { state, patch } = await bridge.open({
      ...OPEN,
      serverName: "claude.ai Higgsfield",
      toolName: "balance",
    });
    strictEqual(state.status, "unavailable");
    strictEqual(state.reason, "proxied");
    deepStrictEqual(reads, []);
    if (patch.kind !== "widget") throw new Error("unreachable");
    strictEqual(patch.htmlStatus, "unavailable");
    // The block schema demands a ui:// uri even when there is none to show.
    ok(patch.resourceUri.startsWith("ui://"));
  });

  it("is unavailable, not rejected, when the resource read fails", async () => {
    const access: WidgetMcpAccess = {
      listTools: async () => [{ name: "show_card", meta: { ui: { resourceUri: CARD_URI } } }],
      readResource: async () => {
        throw new Error("connection closed");
      },
      callTool: async () => ({ content: [] }),
    };
    const bridge = new WidgetHostBridge({ access });
    const { state } = await bridge.open(OPEN);
    strictEqual(state.status, "unavailable");
    strictEqual(state.reason, "connection closed");
  });

  it("refuses a document larger than the cap", async () => {
    const { access } = fakeAccess({
      tools: [{ name: "show_card", meta: { ui: { resourceUri: CARD_URI } } }],
      contents: [{ uri: CARD_URI, text: "x".repeat(50) }],
    });
    const bridge = new WidgetHostBridge({ access, maxHtmlBytes: 10 });
    const { state } = await bridge.open(OPEN);
    strictEqual(state.status, "unavailable");
    match(state.reason ?? "", /over capygen's 10-byte widget limit/);
  });

  it("says so when the tool declares no ui:// resource at all", async () => {
    const { access } = fakeAccess({ tools: [{ name: "show_card" }] });
    const bridge = new WidgetHostBridge({ access });
    const { state } = await bridge.open(OPEN);
    strictEqual(state.status, "unavailable");
    match(state.reason ?? "", /does not declare a ui:\/\/ resource/);
  });
});

describe("WidgetHostBridge.callTool", () => {
  const ready = async (tools: WidgetToolInfo[]) => {
    const fake = fakeAccess({
      tools,
      contents: [{ uri: CARD_URI, text: "<p>hi" }],
    });
    const bridge = new WidgetHostBridge({ access: fake.access });
    await bridge.open({ ...OPEN, resourceUri: CARD_URI });
    return { bridge, ...fake };
  };

  it("routes an app-visible tool to the widget's own server", async () => {
    const { bridge, calls } = await ready([
      { name: "show_card", meta: { ui: { resourceUri: CARD_URI } } },
      { name: "echo", meta: { ui: { resourceUri: CARD_URI, visibility: ["app"] } } },
    ]);
    const result = await bridge.callTool("blk_1", "echo", { text: "ping" });
    deepStrictEqual(calls, [{ server: "capyfixture", tool: "echo", args: { text: "ping" } }]);
    deepStrictEqual(result.content, [{ type: "text", text: "ok" }]);
  });

  it("refuses a tool the server marked visibility:['model']", async () => {
    const { bridge, calls } = await ready([
      { name: "show_card", meta: { ui: { resourceUri: CARD_URI } } },
      { name: "delete_everything", meta: { ui: { visibility: ["model"] } } },
    ]);
    await rejects(
      () => bridge.callTool("blk_1", "delete_everything", {}),
      /may not call it/,
    );
    deepStrictEqual(calls, []);
  });

  it("refuses a tool the server does not advertise", async () => {
    const { bridge, calls } = await ready([{ name: "show_card" }]);
    await rejects(() => bridge.callTool("blk_1", "nope", {}), /has no tool named/);
    deepStrictEqual(calls, []);
  });

  it("refuses a block that has no widget open", async () => {
    const { bridge } = await ready([{ name: "show_card" }]);
    await rejects(() => bridge.callTool("blk_other", "echo", {}), /no widget is open/);
  });

  it("still calls when the listing itself is unavailable", async () => {
    // Failing closed here would break every widget on a server whose listing
    // blipped; the server is the final authority on what it will run.
    const fake = fakeAccess({
      failListTools: true,
      contents: [{ uri: CARD_URI, text: "<p>hi" }],
    });
    const bridge = new WidgetHostBridge({ access: fake.access });
    await bridge.open({ ...OPEN, resourceUri: CARD_URI });
    await bridge.callTool("blk_1", "echo", {});
    deepStrictEqual(fake.calls, [{ server: "capyfixture", tool: "echo", args: {} }]);
  });
});

// ---------------------------------------------------------------------------
// 3. the real fixture server, through the real client pool
// ---------------------------------------------------------------------------

describe("the fixture MCP Apps server", () => {
  it("serves its widget and its app tool over capygen's own client", async () => {
    const pool = new McpClientPool({
      servers: [
        {
          name: "capyfixture",
          transport: "stdio",
          source: "agent",
          command: process.execPath,
          args: [FIXTURE],
        },
      ],
      env: cleanEnv(),
    });
    try {
      const bridge = new WidgetHostBridge({ access: createPoolWidgetAccess({ pool }) });
      const { state } = await bridge.open(OPEN);
      strictEqual(state.status, "ready");
      strictEqual(state.resourceUri, CARD_URI);
      ok((state.html ?? "").includes("ui/initialize"), "the widget speaks the MCP Apps handshake");
      // prefersBorder rides the resource's own _meta, not the tool's.
      strictEqual(state.resourceMeta.prefersBorder, true);

      const echoed = await bridge.callTool("blk_1", "echo", { text: "ping" });
      expect(echoed.content).toEqual([{ type: "text", text: "echo: ping" }]);
    } finally {
      await pool.close();
    }
  }, 30_000);
});
