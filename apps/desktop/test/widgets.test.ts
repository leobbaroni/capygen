/**
 * The desktop widget host (SPEC R31) — the part that decides what a widget is
 * allowed to reach: which document is served under which policy, which session
 * owns a block, and which `ui/*` requests the host will act on.
 */
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "vitest";
import type { McpServerConfig, WidgetMcpAccess } from "@capygen/engine";
import {
  WIDGET_SCHEME_PRIVILEGES,
  createWidgetHost,
  isOpenableLink,
  widgetHost,
  widgetUrl,
} from "../src/ipc/widgets.js";

const CARD_URI = "ui://fixture/card.html";
const PROJECT = "C:/projects/demo";

const silent = { info: () => {}, warn: () => {} };

function access(overrides: Partial<WidgetMcpAccess> = {}): {
  access: WidgetMcpAccess;
  calls: Array<{ server: string; tool: string; args: unknown }>;
} {
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  return {
    calls,
    access: {
      serverNames: () => ["fixture"],
      listTools: async () => [{ name: "show_card", meta: { ui: { resourceUri: CARD_URI } } }],
      readResource: async () => [
        {
          uri: CARD_URI,
          text: "<!doctype html><p>widget",
          meta: { ui: { csp: { connectDomains: ["https://api.example"] } } },
        },
      ],
      callTool: async (server, tool, args) => {
        calls.push({ server, tool, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
      ...overrides,
    },
  };
}

function host(overrides: Partial<Parameters<typeof createWidgetHost>[0]> = {}) {
  const fake = access();
  return {
    ...fake,
    handlers: createWidgetHost({
      log: silent,
      projectPathFor: (sessionId) => (sessionId === "ses_1" ? PROJECT : null),
      createAccess: async () => fake.access,
      ...overrides,
    }),
  };
}

const OPEN = {
  sessionId: "ses_1",
  agentId: "agt_1",
  blockId: "blk_abc123",
  toolCallId: "toolu_1",
  serverName: "fixture",
  toolName: "show_card",
  toolInput: { title: "Hi" },
};

describe("the widget scheme", () => {
  it("is registered as a standard, secure scheme", () => {
    // `standard` is what gives the document a real origin (so the response CSP
    // applies instead of the renderer's), `secure` is what lets it use the
    // platform APIs a widget expects. Neither may quietly change.
    strictEqual(WIDGET_SCHEME_PRIVILEGES.scheme, "capygen-widget");
    strictEqual(WIDGET_SCHEME_PRIVILEGES.privileges.standard, true);
    strictEqual(WIDGET_SCHEME_PRIVILEGES.privileges.secure, true);
    strictEqual(WIDGET_SCHEME_PRIVILEGES.privileges.corsEnabled, false);
  });

  it("gives every block its own host label", () => {
    strictEqual(widgetHost("blk_abc123"), "blkabc123");
    strictEqual(widgetUrl("blk_abc123"), "capygen-widget://blkabc123/index.html");
    // The renderer builds the same URL (apps/renderer/src/widgets/url.ts).
    ok(widgetHost("blk_a") !== widgetHost("blk_b"));
    // An id no host label could hold is hashed, never rejected.
    strictEqual(widgetHost("x".repeat(200)).length, 40);
  });
});

describe("serve", () => {
  it("returns the document with the resource's own CSP", async () => {
    const { handlers } = host();
    await handlers.open(OPEN);
    const served = handlers.serve(widgetUrl(OPEN.blockId));
    ok(served);
    strictEqual(served.body, "<!doctype html><p>widget");
    match(served.csp, /default-src 'none'/);
    match(served.csp, /connect-src https:\/\/api\.example/);
  });

  it("returns null for a block nobody opened", () => {
    const { handlers } = host();
    strictEqual(handlers.serve("capygen-widget://blkunknown/index.html"), null);
    strictEqual(handlers.serve("not a url"), null);
  });
});

describe("captured server lists", () => {
  it("refuses the shipping path when no harness snapshot was captured", async () => {
    const handlers = createWidgetHost({
      log: silent,
      projectPathFor: () => PROJECT,
    });
    await rejects(() => handlers.bridgeFor("ses_1", "agt_1"), /no MCP server snapshot/);
  });

  it("keeps two agents in one session on their own same-name server configuration", async () => {
    const received: (readonly McpServerConfig[])[] = [];
    const fake = access();
    const handlers = createWidgetHost({
      log: silent,
      projectPathFor: (sessionId) => (sessionId === "ses_1" ? PROJECT : null),
      createAccess: async (_project, servers) => {
        received.push(servers ?? []);
        return fake.access;
      },
    });
    const one: McpServerConfig[] = [{ name: "shared", transport: "stdio", command: "one", source: "agent" }];
    const two: McpServerConfig[] = [{ name: "shared", transport: "stdio", command: "two", source: "agent" }];
    handlers.captureSession?.("ses_1", "agt_1", one);
    handlers.captureSession?.("ses_1", "agt_2", two);
    await handlers.detect({ ...OPEN, agentId: "agt_1", toolName: "mcp__fixture__show_card" });
    await handlers.detect({ ...OPEN, agentId: "agt_2", toolName: "mcp__fixture__show_card" });
    deepStrictEqual(received.map((servers) => servers[0]?.command), ["one", "two"]);
    await handlers.dispose();
  });

  it("does not rebind an existing block after its agent captures a replacement list", async () => {
    const received: (readonly McpServerConfig[])[] = [];
    const fake = access();
    const handlers = createWidgetHost({
      log: silent,
      projectPathFor: () => PROJECT,
      createAccess: async (_project, servers) => { received.push(servers ?? []); return fake.access; },
    });
    handlers.captureSession?.("ses_1", "agt_1", [
      { name: "fixture", transport: "stdio", command: "old", source: "agent" },
    ]);
    await handlers.open(OPEN);
    handlers.captureSession?.("ses_1", "agt_1", [
      { name: "fixture", transport: "stdio", command: "new", source: "agent" },
    ]);
    await handlers.open(OPEN);
    deepStrictEqual(received.map((servers) => servers[0]?.command), ["old"]);
    await handlers.dispose();
  });
});

describe("widget.callTool", () => {
  it("routes to the widget's own server", async () => {
    const { handlers, calls } = host();
    await handlers.open(OPEN);
    await handlers.callTool({
      sessionId: "ses_1",
      agentId: "agt_1",
      blockId: OPEN.blockId,
      name: "show_card",
      args: { title: "x" },
    });
    deepStrictEqual(calls, [{ server: "fixture", tool: "show_card", args: { title: "x" } }]);
  });

  it("refuses when the renderer claims the wrong session", async () => {
    const { handlers, calls } = host();
    await handlers.open(OPEN);
    await rejects(
      () =>
        handlers.callTool({
          sessionId: "ses_other",
          agentId: "agt_1",
          blockId: OPEN.blockId,
          name: "show_card",
          args: {},
        }),
      /does not belong to ses_other/,
    );
    deepStrictEqual(calls, []);
  });

  it("refuses a block with no widget open", async () => {
    const { handlers } = host();
    await rejects(
      () =>
        handlers.callTool({
          sessionId: "ses_1",
          agentId: "agt_1",
          blockId: "blk_nope",
          name: "show_card",
          args: {},
        }),
      /no widget is open/,
    );
  });
});

describe("widget.event", () => {
  it("opens only web and mail links", async () => {
    const opened: string[] = [];
    const { handlers } = host({ openExternal: (url) => void opened.push(url) });
    strictEqual(
      (await handlers.event({ blockId: "blk_1", type: "ui/open-link", payload: { url: "https://ok.example" } })).ok,
      true,
    );
    for (const url of ["file:///C:/Windows/System32", "javascript:alert(1)", "capygen-widget://x/", ""]) {
      strictEqual(
        (await handlers.event({ blockId: "blk_1", type: "ui/open-link", payload: { url } })).ok,
        false,
        url,
      );
    }
    deepStrictEqual(opened, ["https://ok.example"]);
  });

  it("only saves a file when the shell offered a save dialog", async () => {
    const saved: string[] = [];
    const { handlers } = host({
      saveFile: (file) => {
        saved.push(file.fileName);
        return true;
      },
    });
    const result = await handlers.event({
      blockId: "blk_1",
      type: "ui/download-file",
      payload: { fileName: "chart.png", base64: "AAA=" },
    });
    strictEqual(result.ok, true);
    deepStrictEqual(saved, ["chart.png"]);

    const { handlers: noSave } = host();
    strictEqual(
      (await noSave.event({ blockId: "blk_1", type: "ui/download-file", payload: {} })).ok,
      false,
    );
  });

  it("records a negotiated size on the widget", async () => {
    const sizes: Array<[string, { height?: number }]> = [];
    const { handlers } = host({ onSize: (id, size) => void sizes.push([id, size]) });
    await handlers.open(OPEN);
    await handlers.event({
      blockId: OPEN.blockId,
      type: "ui/notifications/size-changed",
      payload: { height: 412 },
    });
    deepStrictEqual(sizes, [[OPEN.blockId, { height: 412 }]]);
    strictEqual(handlers.get(OPEN.blockId)?.size?.height, 412);
  });

  it("accepts an unknown ui/* message without acting on it", async () => {
    const { handlers } = host();
    strictEqual((await handlers.event({ blockId: "blk_1", type: "ui/whatever", payload: {} })).ok, true);
  });
});

describe("mcp.readResource", () => {
  it("reads through the project's own client", async () => {
    const { handlers } = host();
    const result = await handlers.readResource({
      sessionId: "ses_1",
      agentId: "agt_1",
      serverName: "fixture",
      uri: CARD_URI,
    });
    strictEqual(result.text, "<!doctype html><p>widget");
  });

  it("refuses a session with no project directory", async () => {
    const { handlers } = host();
    await rejects(
      () =>
        handlers.readResource({
          sessionId: "ses_gone",
          agentId: "agt_1",
          serverName: "fixture",
          uri: CARD_URI,
        }),
      /no project directory is known/,
    );
  });

  it("names why an unreachable server was not dialled", async () => {
    const fake = access({ unreachable: () => "proxied by Claude Code" });
    const handlers = createWidgetHost({
      log: silent,
      projectPathFor: () => PROJECT,
      createAccess: async () => fake.access,
    });
    await rejects(
      () =>
        handlers.readResource({
          sessionId: "ses_1",
          agentId: "agt_1",
          serverName: "claude.ai Higgsfield",
          uri: CARD_URI,
        }),
      /proxied by Claude Code/,
    );
  });
});

describe("isOpenableLink", () => {
  it("allows http(s) and mailto only", () => {
    strictEqual(isOpenableLink("https://example.com"), true);
    strictEqual(isOpenableLink("http://example.com"), true);
    strictEqual(isOpenableLink("mailto:a@b.c"), true);
    strictEqual(isOpenableLink("file:///etc/passwd"), false);
    strictEqual(isOpenableLink("data:text/html,<script>"), false);
    strictEqual(isOpenableLink("/relative"), false);
  });
});
