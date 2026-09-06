/**
 * `agents.describe` (SPEC R13) for the `api` backend — the one with no CLI
 * behind it, so "capabilities" means capygen's own local tool runtime
 * (`../tools/registry.js` `builtinTools()`) plus whatever MCP servers
 * `../mcp/client/config.js` `loadMcpServers()` found for the project (R9,
 * R28). Unlike Claude's `init.tools`, this list needs no live harness at
 * all — `builtinTools()` is a pure function of the agent's permission mode,
 * so a caller can build this snapshot for an agent that has never run a turn.
 */
import type { AgentRole, ApiProvider, Backend } from "@capygen/shared";
import type { HarnessCapabilities } from "../harness.js";
import type { McpServerConfig } from "../mcp/client/types.js";
import { capabilityLabels, joinWords, type AgentDescribeCore } from "../describe/types.js";

export interface ApiDescribeSnapshot {
  provider: ApiProvider;
  model: string;
  /** Tool names, e.g. `builtinTools().map((t) => t.name)`. */
  tools: string[];
  /** From `loadMcpServers({ projectPath, agentConfig })`; `disabled` entries
   *  are excluded from both the count and the paragraph. */
  mcpServers: McpServerConfig[];
}

const PROVIDER_LABEL: Record<ApiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

function describeParagraph(
  role: AgentRole,
  provider: ApiProvider,
  model: string,
  toolCount: number,
  activeServers: McpServerConfig[],
): string {
  const roleLabel = role === "lead" ? "Lead agent" : "Member agent";
  const phrases = [`capygen's own tool runtime (${toolCount} tools: files, search, shell, web)`];
  if (activeServers.length > 0) {
    phrases.push(
      `${activeServers.length} connected MCP server${activeServers.length === 1 ? "" : "s"}`,
    );
  }
  return (
    `${roleLabel} on the API backend (${PROVIDER_LABEL[provider]}/${model}).` +
    ` Uses ${joinWords(phrases)}.`
  );
}

/** `AgentDescribe.tools` — the runtime's own tool names, plus one grouped
 *  entry per MCP server (the same "MCP: name (n tools)" shape
 *  `claude/describe.ts` and `describe/codex.ts` use; the `api` snapshot has no
 *  per-server tool count, only the server list, so the count is omitted). */
function toolList(tools: string[], mcpServers: McpServerConfig[]): string[] {
  const active = mcpServers.filter((s) => !s.disabled);
  return [...tools, ...active.map((s) => `MCP: ${s.name}`)];
}

export interface DescribeApiAgentInput {
  role: AgentRole;
  snapshot: ApiDescribeSnapshot;
  capabilities: HarnessCapabilities;
}

export function describeApiAgent(input: DescribeApiAgentInput): AgentDescribeCore {
  const { role, snapshot, capabilities } = input;
  const activeServers = snapshot.mcpServers.filter((s) => !s.disabled);
  return {
    description: describeParagraph(
      role,
      snapshot.provider,
      snapshot.model,
      snapshot.tools.length,
      activeServers,
    ),
    capabilities: capabilityLabels(capabilities),
    tools: toolList(snapshot.tools, snapshot.mcpServers),
    model: snapshot.model,
    backend: "api" satisfies Backend,
  };
}
