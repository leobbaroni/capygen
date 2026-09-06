/**
 * `agentsDescribe.ts` — the composition of a backend's own describe function
 * with usage totals and the other-agents listing (SPEC R13).
 *
 * Every dep here is a plain fake; the point of this suite is the composition
 * (which snapshot field picks which describe function, the no-snapshot-yet
 * fallback), not the per-backend paragraph wording — that is
 * `packages/engine/test/describe.test.ts`'s job.
 */
import { describe, expect, it } from "vitest";
import type { Agent, AgentDescribeOther, AgentUsageSummary } from "@capygen/shared";
import {
  apiConfigDefaults,
  codexConfigDefaults,
  describeAgent,
  type AgentHarnessSnapshot,
  type AgentsDescribeDeps,
} from "../src/ipc/agentsDescribe.js";

const USAGE: AgentUsageSummary = { input: 500, output: 200, cached: 50, costUsd: 0.05 };
const OTHERS: AgentDescribeOther[] = [
  { agentId: "agt_2", mentionName: "codex", backend: "codex", model: "gpt-5.5" },
];

const FULL_CAPS: AgentHarnessSnapshot["capabilities"] = {
  streamingDeltas: true,
  permissions: true,
  questions: true,
  subagents: true,
  resume: true,
  interrupt: true,
  slashCommands: true,
};

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agt_1",
    sessionId: "ses_1",
    name: "lead",
    displayName: "Lead",
    mentionName: "lead",
    backend: "claude",
    model: "claude-sonnet-5",
    role: "lead",
    order: 0,
    config: null,
    createdAt: 0,
    ...over,
  };
}

function deps(over: Partial<AgentsDescribeDeps> = {}): AgentsDescribeDeps {
  return {
    getAgent: () => agent(),
    listOtherAgents: () => OTHERS,
    usageFor: () => USAGE,
    ...over,
  };
}

describe("describeAgent", () => {
  it("throws a clear error for an unknown agent id instead of returning a blank card", () => {
    expect(() => describeAgent(deps({ getAgent: () => undefined }), "nope")).toThrow(
      /unknown agent: nope/,
    );
  });

  it("composes usage and others onto every describe path", () => {
    const claudeSnapshot: AgentHarnessSnapshot = {
      capabilities: FULL_CAPS,
      claude: {
        model: "claude-sonnet-5",
        permissionMode: "default",
        tools: ["Read", "Bash"],
        mcpServers: [],
        skills: [],
        plugins: [],
      },
    };
    const result = describeAgent(
      deps({ snapshotFor: () => claudeSnapshot }),
      "agt_1",
    );
    expect(result.usage).toEqual(USAGE);
    expect(result.others).toEqual(OTHERS);
    expect(result.backend).toBe("claude");
    expect(result.description).toContain("Lead agent on Claude Code");
  });

  it("routes to the codex describe function when the snapshot carries codex facts", () => {
    const codexAgent = agent({ id: "agt_3", backend: "codex", model: "gpt-5.5", role: "member" });
    const snapshot: AgentHarnessSnapshot = {
      capabilities: FULL_CAPS,
      codex: {
        model: "gpt-5.5",
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        mcpServers: [],
        skills: [],
      },
    };
    const result = describeAgent(
      deps({ getAgent: () => codexAgent, snapshotFor: () => snapshot }),
      "agt_3",
    );
    expect(result.backend).toBe("codex");
    expect(result.description).toContain("Member agent on Codex (gpt-5.5)");
    expect(result.description).toContain("asks before every command");
  });

  it("routes to the api describe function when the snapshot carries api facts", () => {
    const apiAgent = agent({ id: "agt_4", backend: "api", model: "gpt-5.5" });
    const snapshot: AgentHarnessSnapshot = {
      capabilities: FULL_CAPS,
      api: { provider: "openai", model: "gpt-5.5", tools: ["read_file", "bash"], mcpServers: [] },
    };
    const result = describeAgent(
      deps({ getAgent: () => apiAgent, snapshotFor: () => snapshot }),
      "agt_4",
    );
    expect(result.backend).toBe("api");
    expect(result.description).toContain("OpenAI/gpt-5.5");
  });

  it("falls back to config-only info when no harness has reported yet — never a guess", () => {
    const fresh = agent({ description: "not yet run" });
    const result = describeAgent(
      deps({ getAgent: () => fresh, snapshotFor: () => undefined }),
      "agt_1",
    );
    expect(result).toEqual({
      description: "not yet run",
      capabilities: [],
      tools: [],
      model: "claude-sonnet-5",
      backend: "claude",
      usage: USAGE,
      others: OTHERS,
    });
  });
});

describe("codexConfigDefaults", () => {
  it("defaults to CodexHarness.startThread's own defaults when the agent has no codex config", () => {
    expect(codexConfigDefaults(agent({ backend: "codex", model: "gpt-5.5" }))).toEqual({
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("prefers the agent's own stored config over the defaults", () => {
    const withConfig = agent({
      backend: "codex",
      model: "gpt-5.5",
      config: { codex: { approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-6-astra" } },
    });
    expect(codexConfigDefaults(withConfig)).toEqual({
      model: "gpt-6-astra",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});

describe("apiConfigDefaults", () => {
  it("defaults to anthropic when the agent has no api config", () => {
    expect(apiConfigDefaults(agent({ backend: "api", model: "claude-opus-4-5" }))).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("prefers the agent's own stored provider/model", () => {
    const withConfig = agent({
      backend: "api",
      model: "claude-opus-4-5",
      config: { api: { provider: "openrouter", model: "gpt-5.5" } },
    });
    expect(apiConfigDefaults(withConfig)).toEqual({ provider: "openrouter", model: "gpt-5.5" });
  });
});
