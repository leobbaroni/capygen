#!/usr/bin/env node
/**
 * capygen test fixture — an MCP Apps server (stdio).
 *
 * Two tools, both declaring the same `ui://` resource in `_meta.ui`
 * (@modelcontextprotocol/ext-apps 1.7.5 `registerAppTool`):
 *
 *   show_card(title, note?)  the widget-bearing tool the model calls
 *   echo(text)               visibility ["app"] — the widget calls it back
 *                            through the host bridge, so a round-trip through
 *                            `widget.callTool` is observable end to end
 *
 * Plain `.mjs` on purpose: it is spawned with bare `node` by the Claude SDK's
 * MCP client, by capygen's own MCP client and by the widget e2e, so it must
 * have no build step. Dependencies resolve from the repo root node_modules.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CARD_URI = "ui://capygen-fixture/card.html";

const server = new McpServer({ name: "capygen-fixture", version: "1.0.0" });

registerAppResource(
  server,
  "Capygen fixture card",
  CARD_URI,
  { description: "The fixture widget capygen's MCP Apps host renders." },
  async () => ({
    contents: [
      {
        uri: CARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readFileSync(join(HERE, "widget.html"), "utf8"),
        // Declared even though it is empty: the host reads CSP off the
        // resources/read content item first, the resources/list entry second.
        _meta: { ui: { csp: {}, prefersBorder: true } },
      },
    ],
  }),
);

registerAppTool(
  server,
  "show_card",
  {
    title: "Show a card",
    description: "Display a titled card widget in the transcript.",
    inputSchema: { title: z.string(), note: z.string().optional() },
    _meta: { ui: { resourceUri: CARD_URI, visibility: ["model", "app"] } },
  },
  async ({ title, note }) => ({
    content: [{ type: "text", text: `Showing card "${title}".` }],
    structuredContent: { title, note: note ?? null },
  }),
);

registerAppTool(
  server,
  "echo",
  {
    title: "Echo",
    description: "Echo text back — called by the card widget through the host.",
    inputSchema: { text: z.string() },
    _meta: { ui: { resourceUri: CARD_URI, visibility: ["app"] } },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
