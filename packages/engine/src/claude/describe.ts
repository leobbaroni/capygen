/**
 * `agents.describe` (SPEC R13) for the Claude backend — a pure mapping from a
 * snapshot of the Claude Agent SDK's own `system/init` message to the
 * backend-specific two-thirds of an `AgentDescribe` (`AgentDescribeCore`; the
 * usage/others thirds are `../describe/types.ts`'s job).
 *
 * `ClaudeInitSnapshot` restates only the `init` fields this file reads, the
 * same discipline `codex/protocol.ts` applies to the app-server wire — each
 * field names the raw JSON key it comes from, verified against a real capture
 * (`docs/spikes/claude.raw.json`, the `system`/`init` message, lines 63-152):
 * `tools` (`string[]`, capygen builtins mixed with `mcp__<server>__<tool>`),
 * `mcp_servers` (`{name, status}[]`), `model`, `permissionMode`, `skills`
 * (`string[]`), `plugins` (`{name, version}[]`).
 *
 * `ClaudeHarness` does not cache or expose this snapshot yet — today it only
 * keeps `model`/`session_id`/the slash-command fields off `init`
 * (`ClaudeHarness.routeSystem`). Wiring a getter that also remembers `tools`,
 * `mcp_servers` and `permissionMode` is the integration task that calls this
 * function from `apps/desktop/src/engine/SessionRunner.ts`; it is explicitly
 * out of this file's scope (`packages/engine/src/claude/describe.ts` only —
 * see the B3 task brief). Until that lands, a caller with no live `init` yet
 * (an agent that has not run its first turn) has nothing to pass here and
 * `agentsDescribe.ts` falls back to config-only info instead of guessing.
 */
import type { AgentRole, Backend } from "@capygen/shared";
import type { HarnessCapabilities } from "../harness.js";
import { capabilityLabels, clampText, joinWords, type AgentDescribeCore } from "../describe/types.js";

export interface ClaudeInitSnapshot {
  /** `init.model`. */
  model: string;
  /** `init.permissionMode` — a raw string because a future SDK value should
   *  still show up on the card rather than fail a schema check. */
  permissionMode: string;
  /** `init.tools` — every tool name the SDK told this session about, builtins
   *  and `mcp__<server>__<tool>` entries mixed together exactly as the wire
   *  sends them. */
  tools: string[];
  /** `init.mcp_servers`. */
  mcpServers: { name: string; status: string }[];
  /** `init.skills`. */
  skills: string[];
  /** `init.plugins`, path dropped — a filesystem path has no business on an
   *  info card. */
  plugins: { name: string; version?: string }[];
}

/**
 * Every capygen-recognised builtin, grouped the way an info card should read
 * them rather than the order `init.tools` happens to list them in. A name not
 * in this table (a future SDK tool, or `AskUserQuestion`, which streams as a
 * `tool_use` but is not itself listed in `init.tools`) lands in "Other" rather
 * than being silently dropped — the same "no third option" rule
 * `blockParity.ts` applies to block kinds.
 */
const CLAUDE_TOOL_GROUPS: Record<string, string> = {
  Read: "Files",
  Write: "Files",
  Edit: "Files",
  NotebookEdit: "Files",
  Glob: "Files",
  Grep: "Files",
  Bash: "Execution",
  PowerShell: "Execution",
  WebFetch: "Web",
  WebSearch: "Web",
  Task: "Sub-agents & tasks",
  TaskOutput: "Sub-agents & tasks",
  TaskStop: "Sub-agents & tasks",
  Agent: "Sub-agents & tasks",
  ListAgents: "Sub-agents & tasks",
  SendMessage: "Sub-agents & tasks",
  Workflow: "Sub-agents & tasks",
  ReportFindings: "Sub-agents & tasks",
  ToolSearch: "Sub-agents & tasks",
  CronCreate: "Scheduling",
  CronDelete: "Scheduling",
  CronList: "Scheduling",
  ScheduleWakeup: "Scheduling",
  RemoteTrigger: "Scheduling",
  PushNotification: "Scheduling",
  EnterWorktree: "Worktrees",
  ExitWorktree: "Worktrees",
  DesignSync: "Worktrees",
  Skill: "Skills",
  ListMcpResourcesTool: "MCP resources",
  ReadMcpResourceDirTool: "MCP resources",
  ReadMcpResourceTool: "MCP resources",
  Monitor: "Monitoring",
};

/**
 * A `mcp_servers[].name` normalised the same way `init.tools` spells it inside
 * an `mcp__<slug>__<tool>` name — verified against the real capture:
 * `"claude.ai Higgsfield"` (a `mcp_servers[].name`) becomes the slug
 * `claude_ai_Higgsfield` inside `mcp__claude_ai_Higgsfield__balance`. Case is
 * preserved (Claude does not lower-case the server name), only punctuation
 * and whitespace collapse to underscores.
 */
function normalizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * `mcp__<server>__<tool>` → the server slug, or `null` for a builtin name.
 * Not a plain regex split: both the server slug *and* the tool name may
 * contain underscores (`claude_ai_Higgsfield`, `generate_image`), so `"the
 * part before the last `__`"` is only a guess. Matching against the known
 * server slugs first (longest prefix, in case one slug is itself a prefix of
 * another) resolves the ambiguity whenever `mcp_servers` named the server;
 * only an entry `init.mcp_servers` never listed falls back to the guess.
 */
function mcpServerSlug(toolName: string, knownSlugs: readonly string[]): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  let best: string | null = null;
  for (const slug of knownSlugs) {
    if (rest.startsWith(`${slug}__`) && (!best || slug.length > best.length)) best = slug;
  }
  if (best) return best;
  const cut = rest.lastIndexOf("__");
  return cut > 0 ? rest.slice(0, cut) : rest;
}

export interface ClaudeToolGroups {
  /** Group label → the builtin tool names in it, in `init.tools` order. */
  builtins: Map<string, string[]>;
  /** MCP server label (the friendly `mcp_servers[].name` when it matches,
   *  otherwise the raw slug) → its tool count. */
  mcpServers: Map<string, number>;
}

/** Splits `init.tools` into builtin groups and per-MCP-server counts. Exported
 *  so a test can assert the grouping directly, independent of the paragraph
 *  wording built on top of it. */
export function groupClaudeTools(
  tools: string[],
  mcpServers: { name: string }[] = [],
): ClaudeToolGroups {
  const bySlug = new Map(mcpServers.map((s) => [normalizeServerName(s.name), s.name]));
  const knownSlugs = [...bySlug.keys()];
  const builtins = new Map<string, string[]>();
  const mcp = new Map<string, number>();
  for (const tool of tools) {
    const slug = mcpServerSlug(tool, knownSlugs);
    if (slug !== null) {
      const label = bySlug.get(slug) ?? slug;
      mcp.set(label, (mcp.get(label) ?? 0) + 1);
      continue;
    }
    const group = CLAUDE_TOOL_GROUPS[tool] ?? "Other";
    const list = builtins.get(group) ?? [];
    list.push(tool);
    builtins.set(group, list);
  }
  return { builtins, mcpServers: mcp };
}

/** `AgentDescribe.tools` — a flat, human-readable list: one entry per builtin
 *  group naming its tools, one per MCP server naming its tool count. Grouped
 *  because 140+ raw internal ids (Higgsfield's connector alone is well over
 *  100) is not what SPEC R13's info card wants to render, and "grouped" is
 *  literally what the task brief asks for. */
function flattenToolGroups(groups: ClaudeToolGroups): string[] {
  const lines: string[] = [];
  for (const [group, names] of groups.builtins) {
    lines.push(`${group} (${names.join(", ")})`);
  }
  for (const [server, count] of groups.mcpServers) {
    lines.push(`MCP: ${server} (${count} tool${count === 1 ? "" : "s"})`);
  }
  return lines;
}

const GROUP_PHRASES: Record<string, string> = {
  Files: "read and edit files",
  Execution: "run shell commands",
  Web: "browse the web",
  "Sub-agents & tasks": "delegate to sub-agents",
  Scheduling: "schedule reminders and automations",
  Worktrees: "manage git worktrees",
  Skills: "run skills",
  "MCP resources": "read MCP resources",
  Monitoring: "watch background tasks",
};

function describeParagraph(
  role: AgentRole,
  model: string,
  groups: ClaudeToolGroups,
  skillsCount: number,
  pluginsCount: number,
  connectedServers: number,
  permissionMode: string,
): string {
  const roleLabel = role === "lead" ? "Lead agent" : "Member agent";
  const phrases = [...groups.builtins.keys()]
    .map((group) => GROUP_PHRASES[group])
    .filter((p): p is string => Boolean(p));
  if (groups.mcpServers.size > 0) {
    phrases.push(
      `use ${connectedServers || groups.mcpServers.size} connected MCP server${
        groups.mcpServers.size === 1 ? "" : "s"
      }`,
    );
  }
  if (skillsCount > 0) {
    phrases.push(
      pluginsCount > 0
        ? `use ${skillsCount} skills across ${pluginsCount} plugin${pluginsCount === 1 ? "" : "s"}`
        : `use ${skillsCount} skill${skillsCount === 1 ? "" : "s"}`,
    );
  }
  const capabilitySentence = phrases.length > 0 ? ` Can ${joinWords(phrases)}.` : "";
  return (
    `${roleLabel} on Claude Code (${model}).${capabilitySentence}` +
    ` Permission mode: ${permissionMode}.`
  );
}

export interface DescribeClaudeAgentInput {
  role: AgentRole;
  snapshot: ClaudeInitSnapshot;
  capabilities: HarnessCapabilities;
}

export function describeClaudeAgent(input: DescribeClaudeAgentInput): AgentDescribeCore {
  const { role, snapshot, capabilities } = input;
  const groups = groupClaudeTools(snapshot.tools, snapshot.mcpServers);
  const connectedServers = snapshot.mcpServers.filter((s) => s.status === "connected").length;
  const description = describeParagraph(
    role,
    snapshot.model,
    groups,
    snapshot.skills.length,
    snapshot.plugins.length,
    connectedServers,
    snapshot.permissionMode,
  );
  return {
    description: clampText(description, 600),
    capabilities: capabilityLabels(capabilities),
    tools: flattenToolGroups(groups),
    model: snapshot.model,
    backend: "claude" satisfies Backend,
  };
}
