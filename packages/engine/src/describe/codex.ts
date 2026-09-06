/**
 * `agents.describe` (SPEC R13) for the Codex backend.
 *
 * Codex did not get a `codex/describe.ts` next to `CodexHarness.ts` the way
 * Claude and the API loop did — this task's brief scopes `packages/engine/src/
 * codex/**` to "sub-agent parts only" (the `collabAgentToolCall`/
 * `subAgentActivity` block mapping in `CodexHarness.ts`), so a fully separate
 * describe concern lives here instead, in the one folder the brief grants
 * outright. The unmapped facts it needs — sandbox, approval policy, MCP
 * servers, skills — are already public on `CodexHarness` without any change:
 * `listSkills()` (sync, cached from `skills/list`), `listMcpServers()` (an
 * on-demand `mcpServerStatus/list` call), and `model()`. Sandbox and approval
 * policy have no getter today, but do not need one: both are exactly
 * `agent.config.codex.sandbox` / `.approvalPolicy` (defaulted the same way
 * `CodexHarness.startThread` defaults them — `on-request` / `workspace-write`
 * — see `packages/shared/src/domain.ts` `CodexAgentConfigSchema` and
 * `CodexHarness.ts`'s own `config.approvalPolicy ?? "on-request"`), so the
 * caller (`agentsDescribe.ts`) can build this snapshot from the stored
 * `Agent` row alone, live harness or not.
 */
import type { AgentRole, Backend } from "@capygen/shared";
import type { HarnessCapabilities } from "../harness.js";
import type { CodexMcpServerStatus, CodexSkill } from "../codex/protocol.js";
import { capabilityLabels, joinWords, type AgentDescribeCore } from "./types.js";

export interface CodexDescribeSnapshot {
  model: string;
  /** `agent.config.codex.approvalPolicy ?? "on-request"`. */
  approvalPolicy: string;
  /** `agent.config.codex.sandbox ?? "workspace-write"`. */
  sandbox: string;
  /** `CodexHarness.listMcpServers()`, or `[]` before a harness has run. */
  mcpServers: CodexMcpServerStatus[];
  /** `CodexHarness.listSkills()`. */
  skills: CodexSkill[];
}

const SANDBOX_PHRASE: Record<string, string> = {
  "read-only": "a read-only sandbox",
  "workspace-write": "a sandbox that can edit files in the project",
  "danger-full-access": "full filesystem access (no sandbox)",
};

const APPROVAL_PHRASE: Record<string, string> = {
  never: "never asks before running a command",
  "on-failure": "only asks if a command fails",
  "on-request": "asks before commands it flags as risky",
  untrusted: "asks before every command",
};

/** `AgentDescribe.tools` for Codex — the fixed set every Codex agent has
 *  (there is no per-agent tool list the way Claude's `init.tools` is one),
 *  plus one "MCP: <server> (n tools)" entry per connected server, matching
 *  the grouped style `claude/describe.ts` uses. */
function codexTools(mcpServers: CodexMcpServerStatus[]): string[] {
  const tools = ["Shell commands", "File edits (apply_patch)", "Web search"];
  for (const server of mcpServers) {
    const count = Object.keys(server.tools ?? {}).length;
    tools.push(`MCP: ${server.name} (${count} tool${count === 1 ? "" : "s"})`);
  }
  return tools;
}

function describeParagraph(
  role: AgentRole,
  model: string,
  approvalPolicy: string,
  sandbox: string,
  mcpServers: CodexMcpServerStatus[],
  skills: CodexSkill[],
): string {
  const roleLabel = role === "lead" ? "Lead agent" : "Member agent";
  const sandboxPhrase = SANDBOX_PHRASE[sandbox] ?? `the "${sandbox}" sandbox`;
  const approvalPhrase = APPROVAL_PHRASE[approvalPolicy] ?? `uses the "${approvalPolicy}" approval policy`;
  const extras: string[] = [];
  if (mcpServers.length > 0) {
    extras.push(`connected to ${mcpServers.length} MCP server${mcpServers.length === 1 ? "" : "s"}`);
  }
  if (skills.length > 0) {
    extras.push(`has ${skills.length} skill${skills.length === 1 ? "" : "s"} available`);
  }
  const extraSentence = extras.length > 0 ? ` ${capitalize(joinWords(extras))}.` : "";
  return (
    `${roleLabel} on Codex (${model}). Runs in ${sandboxPhrase} and ${approvalPhrase}.` +
    extraSentence
  );
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

export interface DescribeCodexAgentInput {
  role: AgentRole;
  snapshot: CodexDescribeSnapshot;
  capabilities: HarnessCapabilities;
}

export function describeCodexAgent(input: DescribeCodexAgentInput): AgentDescribeCore {
  const { role, snapshot, capabilities } = input;
  return {
    description: describeParagraph(
      role,
      snapshot.model,
      snapshot.approvalPolicy,
      snapshot.sandbox,
      snapshot.mcpServers,
      snapshot.skills,
    ),
    capabilities: capabilityLabels(capabilities),
    tools: codexTools(snapshot.mcpServers),
    model: snapshot.model,
    backend: "codex" satisfies Backend,
  };
}
