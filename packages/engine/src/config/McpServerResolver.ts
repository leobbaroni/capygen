import type { Backend } from "@capygen/shared";
import type { McpServerConfig } from "../mcp/client/types.js";

export interface ResolveMcpServerConfigsInput {
  backend: Backend;
  agent: readonly McpServerConfig[];
  api: readonly McpServerConfig[];
  claude: readonly McpServerConfig[];
  codex: readonly McpServerConfig[];
}

/**
 * Resolve the complete server list a backend session captures.
 *
 * Names are claimed before disabled entries are removed. This matters for a
 * deliberate disabled override: a disabled agent/API row shadows an inherited
 * server of the same name instead of making the lower-priority server spring
 * back to life.
 */
export function resolveMcpServerConfigs(input: ResolveMcpServerConfigsInput): McpServerConfig[] {
  const sources: readonly (readonly McpServerConfig[])[] =
    input.backend === "api"
      ? [input.agent, input.api, input.claude, input.codex]
      : input.backend === "claude"
        ? [input.agent, input.claude]
        : [input.agent, input.codex];
  const claimed = new Map<string, McpServerConfig>();
  for (const source of sources) {
    for (const server of source) {
      if (!claimed.has(server.name)) claimed.set(server.name, cloneServer(server));
    }
  }
  return [...claimed.values()].filter((server) => server.disabled !== true);
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}
