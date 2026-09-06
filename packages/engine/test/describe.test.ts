/**
 * `agents.describe` (SPEC R13) — one pure describe function per backend, and
 * the composition helper that turns its output plus usage/others into the
 * full `AgentDescribe` IPC payload.
 *
 * Snapshots below are grounded in real captures, not invented shapes:
 *   - Claude's `tools`/`mcp_servers`/`skills`/`plugins` are a representative
 *     subset of the real `system/init` message
 *     (`docs/spikes/claude.raw.json`, lines 63-152);
 *   - Codex's `CodexMcpServerStatus`/`CodexSkill` are `packages/engine/src/
 *     codex/protocol.ts`'s own restatement of `v2/McpServerStatus.ts` /
 *     `v2/SkillMetadata.ts`.
 */
import { describe, expect, it } from "vitest";
import type { AgentUsageSummary } from "@capygen/shared";
import type { HarnessCapabilities } from "../src/harness.js";
import { composeAgentDescribe } from "../src/describe/types.js";
import { describeCodexAgent, type CodexDescribeSnapshot } from "../src/describe/codex.js";
import { describeClaudeAgent, groupClaudeTools, type ClaudeInitSnapshot } from "../src/claude/describe.js";
import { describeApiAgent, type ApiDescribeSnapshot } from "../src/api/describe.js";

const FULL_CAPS: HarnessCapabilities = {
  streamingDeltas: true,
  permissions: true,
  questions: true,
  subagents: true,
  resume: true,
  interrupt: true,
  slashCommands: true,
};

const NO_CAPS: HarnessCapabilities = {
  streamingDeltas: false,
  permissions: false,
  questions: false,
  subagents: false,
  resume: false,
  interrupt: false,
  slashCommands: false,
};

describe("composeAgentDescribe", () => {
  it("layers usage and others onto a backend's core describe output", () => {
    const usage: AgentUsageSummary = { input: 100, output: 40, cached: 10, costUsd: 0.02 };
    const full = composeAgentDescribe(
      { description: "x", capabilities: [], tools: [], model: "m", backend: "claude" },
      usage,
      [{ agentId: "a2", mentionName: "codex", backend: "codex", model: "gpt-5.5" }],
    );
    expect(full.usage).toEqual(usage);
    expect(full.others).toHaveLength(1);
    expect(full.model).toBe("m");
  });
});

describe("groupClaudeTools", () => {
  const tools = [
    "Task",
    "Bash",
    "Edit",
    "Read",
    "Write",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Skill",
    "SomeFutureTool",
    "mcp__claude_ai_Higgsfield__balance",
    "mcp__claude_ai_Higgsfield__generate_image",
    "mcp__claude_ai_Gmail__send_message",
  ];
  const mcpServers = [
    { name: "claude.ai Higgsfield" },
    { name: "claude.ai Gmail" },
  ];

  it("buckets builtins by category and MCP tools by server", () => {
    const groups = groupClaudeTools(tools, mcpServers);
    expect(groups.builtins.get("Files")).toEqual(["Edit", "Read", "Write", "Glob", "Grep"]);
    expect(groups.builtins.get("Execution")).toEqual(["Bash"]);
    expect(groups.builtins.get("Web")).toEqual(["WebFetch", "WebSearch"]);
    expect(groups.builtins.get("Sub-agents & tasks")).toEqual(["Task"]);
    expect(groups.builtins.get("Skills")).toEqual(["Skill"]);
    // An unrecognised name lands in "Other" rather than vanishing.
    expect(groups.builtins.get("Other")).toEqual(["SomeFutureTool"]);
    expect(groups.mcpServers.get("claude.ai Higgsfield")).toBe(2);
    expect(groups.mcpServers.get("claude.ai Gmail")).toBe(1);
  });

  it("falls back to the raw slug when no mcp_servers entry matches", () => {
    const groups = groupClaudeTools(["mcp__unknown_thing__do_stuff"], []);
    expect(groups.mcpServers.get("unknown_thing")).toBe(1);
  });
});

describe("describeClaudeAgent", () => {
  const snapshot: ClaudeInitSnapshot = {
    model: "claude-sonnet-5",
    permissionMode: "bypassPermissions",
    tools: [
      "Task",
      "Bash",
      "Edit",
      "Read",
      "Write",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "mcp__claude_ai_Higgsfield__balance",
    ],
    mcpServers: [{ name: "claude.ai Higgsfield", status: "connected" }],
    skills: ["graphify", "cockpit:pilot", "hyperframes:hyperframes"],
    plugins: [{ name: "cockpit", version: "3.0.0" }],
  };

  it("names the role, backend and model, and groups tools with counts", () => {
    const core = describeClaudeAgent({ role: "lead", snapshot, capabilities: FULL_CAPS });
    expect(core.backend).toBe("claude");
    expect(core.model).toBe("claude-sonnet-5");
    expect(core.description).toContain("Lead agent on Claude Code (claude-sonnet-5)");
    expect(core.description).toContain("read and edit files");
    expect(core.description).toContain("run shell commands");
    expect(core.description).toContain("browse the web");
    expect(core.description).toContain("delegate to sub-agents");
    expect(core.description).toContain("use 3 skills across 1 plugin");
    expect(core.description).toContain("Permission mode: bypassPermissions");
    expect(core.tools).toContain("MCP: claude.ai Higgsfield (1 tool)");
    expect(core.tools.some((t) => t.startsWith("Files ("))).toBe(true);
    expect(core.capabilities).toContain("Can spawn sub-agents");
  });

  it("says 'Member agent' for a non-lead agent", () => {
    const core = describeClaudeAgent({ role: "member", snapshot, capabilities: FULL_CAPS });
    expect(core.description).toContain("Member agent on Claude Code");
  });

  it("drops the capabilities/skills phrases entirely when there is nothing to report", () => {
    const bare: ClaudeInitSnapshot = {
      model: "claude-haiku-5",
      permissionMode: "default",
      tools: [],
      mcpServers: [],
      skills: [],
      plugins: [],
    };
    const core = describeClaudeAgent({ role: "lead", snapshot: bare, capabilities: NO_CAPS });
    expect(core.description).toBe(
      "Lead agent on Claude Code (claude-haiku-5). Permission mode: default.",
    );
    expect(core.capabilities).toEqual([]);
    expect(core.tools).toEqual([]);
  });
});

describe("describeCodexAgent", () => {
  const snapshot: CodexDescribeSnapshot = {
    model: "gpt-5.5",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    mcpServers: [
      { name: "capyfixture", tools: { show_card: {}, list_things: {} } },
    ],
    skills: [{ name: "review", path: "/skills/review" }],
  };

  it("describes sandbox, approval policy, MCP servers and skills", () => {
    const core = describeCodexAgent({ role: "lead", snapshot, capabilities: FULL_CAPS });
    expect(core.backend).toBe("codex");
    expect(core.model).toBe("gpt-5.5");
    expect(core.description).toContain("Lead agent on Codex (gpt-5.5)");
    expect(core.description).toContain("can edit files in the project");
    expect(core.description).toContain("asks before commands it flags as risky");
    expect(core.description).toContain("Connected to 1 MCP server");
    expect(core.description).toContain("has 1 skill available");
    expect(core.tools).toEqual([
      "Shell commands",
      "File edits (apply_patch)",
      "Web search",
      "MCP: capyfixture (2 tools)",
    ]);
  });

  it("names an unrecognised sandbox/approval value instead of guessing a phrase", () => {
    const core = describeCodexAgent({
      role: "member",
      snapshot: { ...snapshot, sandbox: "future-mode", approvalPolicy: "future-policy", mcpServers: [], skills: [] },
      capabilities: NO_CAPS,
    });
    expect(core.description).toContain('the "future-mode" sandbox');
    expect(core.description).toContain('uses the "future-policy" approval policy');
  });
});

describe("describeApiAgent", () => {
  const snapshot: ApiDescribeSnapshot = {
    provider: "anthropic",
    model: "claude-opus-4-5",
    tools: ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "web_fetch"],
    mcpServers: [
      { name: "capyfixture", transport: "stdio", source: "project-mcp-json" },
      { name: "disabled-one", transport: "stdio", source: "agent", disabled: true },
    ],
  };

  it("names the provider/model and capygen's own tool runtime", () => {
    const core = describeApiAgent({ role: "lead", snapshot, capabilities: FULL_CAPS });
    expect(core.backend).toBe("api");
    expect(core.model).toBe("claude-opus-4-5");
    expect(core.description).toContain("Lead agent on the API backend (Anthropic/claude-opus-4-5)");
    expect(core.description).toContain("7 tools");
    expect(core.description).toContain("1 connected MCP server");
    expect(core.tools).toContain("read_file");
    expect(core.tools).toContain("MCP: capyfixture");
    // The disabled server is excluded from both the count and the tool list.
    expect(core.tools).not.toContain("MCP: disabled-one");
  });
});
