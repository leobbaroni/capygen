#!/usr/bin/env node
/**
 * A minimal, dependency-free MCP server over stdio — the fixture
 * `mcpClient.test.ts` connects the **real** `@modelcontextprotocol/sdk` client
 * to (SPEC R9, R26, R31).
 *
 * Hand-written JSON-RPC rather than `McpServer` on purpose: the point of the
 * test is that capygen's pool interoperates with a server it did not build, so
 * a fixture that shares the SDK's own serialisation would prove less. It is
 * also what lets the test assert *laziness* — the process writes a line to
 * `CAPYGEN_FIXTURE_LOG` for every request it receives, so the test can show
 * that `tools/list` happened once and only after the first use.
 *
 * Tools:
 *   echo        — returns its `text` argument.
 *   widget_card — declares a `ui://` App resource in `_meta` (R31) and returns
 *                 `structuredContent` plus `_meta`, so the pass-through can be
 *                 checked end to end.
 *   boom        — returns `isError: true`.
 */
import fs from "node:fs";
import process from "node:process";

const LOG = process.env.CAPYGEN_FIXTURE_LOG;
const RESOURCE_URI = "ui://capygen-fixture/card.html";
const RESOURCE_MIME = "text/html;profile=mcp-app";

function note(line) {
  if (LOG) {
    try {
      fs.appendFileSync(LOG, `${line}\n`);
    } catch {
      /* the test may have removed the file; the server must not die for it */
    }
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "widget_card",
    description: "Return a result that carries an MCP App UI.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
    },
    _meta: { "ui/resourceUri": RESOURCE_URI },
  },
  {
    name: "boom",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  if (method !== undefined) note(method);
  if (id === undefined) return; // a notification: nothing to answer

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "capygen-fixture", version: "1.0.0" },
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "resources/list":
      reply(id, {
        resources: [
          { uri: RESOURCE_URI, name: "card", mimeType: RESOURCE_MIME },
        ],
      });
      return;
    case "resources/read":
      if (params?.uri !== RESOURCE_URI) {
        fail(id, -32602, `no resource at ${params?.uri}`);
        return;
      }
      reply(id, {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME,
            text: "<!doctype html><title>fixture card</title><p>hello widget</p>",
          },
        ],
      });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") {
        reply(id, { content: [{ type: "text", text: String(args.text ?? "") }] });
        return;
      }
      if (name === "widget_card") {
        reply(id, {
          content: [{ type: "text", text: `card: ${String(args.title ?? "untitled")}` }],
          structuredContent: { title: args.title ?? "untitled", count: 2 },
          _meta: { "ui/resourceUri": RESOURCE_URI, extra: "kept" },
        });
        return;
      }
      if (name === "boom") {
        reply(id, { content: [{ type: "text", text: "it exploded" }], isError: true });
        return;
      }
      fail(id, -32602, `unknown tool ${name}`);
      return;
    }
    default:
      fail(id, -32601, `unknown method ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* a malformed line is not worth killing the fixture over */
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
