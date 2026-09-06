/**
 * MCP server tools presented as local `ToolDefinition`s (SPEC R9, R26, R31).
 *
 * The API harness has exactly one tool-dispatch path, and this is what puts a
 * server's tools on it: `mcp__<server>__<tool>` — Claude Code's naming, so a
 * prompt or an allowlist written for one backend means the same thing here.
 *
 * Three decisions worth stating:
 *
 *  - **Permission class `execute`.** A server tool's side effects are unknown to
 *    capygen: it may post to an API, spend money, or write files. Treating it
 *    as read-only because it "looks like a search" is the failure mode R27
 *    exists to prevent, so every MCP tool is gated in `default` mode.
 *    `annotations.readOnlyHint` is honoured when a server sets it — that is the
 *    server's own promise, in the MCP spec's own field.
 *  - **The result is passed through whole.** `ToolResult.content` is the text
 *    flattening the model reads; `ToolResult.raw` keeps `content`,
 *    `structuredContent` and `_meta` untouched, because the widget host (R31)
 *    reads `ui://` out of `_meta` and would have nothing left otherwise.
 *  - **Listing is lazy** (R26): nothing here connects. `mcpToolDefinitions`
 *    is called once per session by the harness, on the first turn that needs a
 *    tool list, and `McpClientPool` caches the `tools/list` per server.
 */
import type { McpClientPool } from "../mcp/client/McpClientPool.js";
import { widgetResourceUri, type McpToolInfo } from "../mcp/client/types.js";
import {
  clampText,
  describeError,
  type JsonSchemaObject,
  type PermissionClass,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

/**
 * A server may promise a tool has no side effects; otherwise assume it does.
 *
 * `annotations` is a **top-level field of the `Tool` object**, a sibling of
 * `inputSchema` (`@modelcontextprotocol/sdk` 1.30.0 `types.d.ts:2381-2419`).
 * Reading it from inside `inputSchema` — as this did — meant `readOnlyHint`
 * was never seen and every MCP tool, search and lookup included, raised a
 * permission card in `default` mode.
 */
export function mcpPermissionClass(tool: McpToolInfo): PermissionClass {
  const annotations = isRecord(tool.annotations)
    ? tool.annotations
    : // Tolerated fallback: a server that nested its annotations in the schema.
      isRecord((tool.inputSchema as { annotations?: unknown }).annotations)
      ? ((tool.inputSchema as { annotations: Record<string, unknown> }).annotations)
      : undefined;
  if (annotations?.readOnlyHint === true) return "read";
  return "execute";
}

/**
 * MCP's `inputSchema` is JSON Schema already; only its shape needs asserting.
 * A server that advertises something other than an object schema (or omits
 * `properties`) still gets a valid tool: both providers reject a tool whose
 * parameters are not an object schema, and refusing to list the tool at all
 * would be a worse answer than listing it with no arguments.
 */
function asObjectSchema(schema: Record<string, unknown>): JsonSchemaObject {
  if (schema.type === "object" && isRecord(schema.properties)) {
    return schema as unknown as JsonSchemaObject;
  }
  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  } as JsonSchemaObject;
}

/**
 * `tools/call` content blocks → the one string the model gets.
 *
 * Text blocks are concatenated; anything else (image, audio, resource,
 * resource_link) is named rather than inlined, because a base64 image in the
 * transcript costs thousands of tokens the model cannot see anyway. The whole
 * value survives on `ToolResult.raw`.
 */
export function flattenMcpContent(result: {
  content?: unknown[];
  structuredContent?: unknown;
}): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (type === "resource" && isRecord(item.resource)) {
      const resource = item.resource;
      if (typeof resource.text === "string") {
        parts.push(resource.text);
        continue;
      }
      parts.push(`[resource ${String(resource.uri ?? "")} ${String(resource.mimeType ?? "")}]`);
      continue;
    }
    if (type === "resource_link") {
      parts.push(`[resource_link ${String(item.uri ?? "")}]`);
      continue;
    }
    parts.push(`[${type || "content"}]`);
  }
  if (result.structuredContent !== undefined) {
    try {
      parts.push(`structuredContent: ${JSON.stringify(result.structuredContent)}`);
    } catch {
      /* a structure with a cycle is not worth failing a tool call over */
    }
  }
  return parts.join("\n").trim();
}

/** One MCP tool as a local tool. `pool` is only touched inside `run`. */
export function mcpToolDefinition(pool: McpClientPool, tool: McpToolInfo): ToolDefinition {
  const resourceUri = widgetResourceUri(tool.meta);
  return {
    name: tool.qualifiedName,
    description:
      tool.description.length > 0
        ? tool.description
        : `The ${tool.name} tool from the ${tool.serverName} MCP server.`,
    permissionClass: mcpPermissionClass(tool),
    family: "mcp",
    parameters: asObjectSchema(tool.inputSchema),
    mcp: {
      serverName: tool.serverName,
      toolName: tool.name,
      ...(resourceUri ? { resourceUri } : {}),
    },
    async run(input, ctx): Promise<ToolResult> {
      try {
        const result = await pool.callTool(tool.serverName, tool.name, input);
        const text = flattenMcpContent(result);
        const clamped = clampText(
          text.length > 0 ? text : "(the tool returned no content)",
          ctx.maxOutputChars,
        );
        return {
          ...clamped,
          raw: result,
          ...(result.isError === true ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: `${tool.qualifiedName} failed: ${describeError(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Every enabled server's tools, as local tools. A server that cannot be reached
 * contributes nothing — `McpClientPool.listAllTools` already logs the reason
 * once — so one broken server never costs the turn its other tools.
 */
export async function mcpToolDefinitions(pool: McpClientPool): Promise<ToolDefinition[]> {
  const tools = await pool.listAllTools();
  return tools.map((tool) => mcpToolDefinition(pool, tool));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
