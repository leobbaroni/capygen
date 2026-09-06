/**
 * `agents.describe` (SPEC R13): composes one backend's own describe function
 * (`@capygen/engine`'s `describeClaudeAgent` / `describeCodexAgent` /
 * `describeApiAgent`) with the two things only the database can answer — an
 * agent's usage totals and the other agents in its session — into the full
 * `AgentDescribe` the IPC channel returns.
 *
 * Electron-free, like the rest of `apps/desktop/src/ipc/*`: everything it
 * needs arrives through `AgentsDescribeDeps`, so it is unit-testable against
 * plain fakes (`apps/desktop/test/agentsDescribe.test.ts`) rather than a real
 * store and a real harness.
 *
 * **Not yet wired into `handlers.ts`.** The existing `agents.describe` handler
 * there is a straightforward placeholder (`capabilities: [], tools: []`,
 * noted in its own comment as best-effort) — this file is the richer engine
 * behind it, built to the shape the task brief specifies
 * (`packages/engine/src/{claude/describe.ts,api/describe.ts,describe/**}` +
 * this file only). Wiring `handlers.ts`'s handler to call `describeAgent`
 * here means passing it a `snapshotFor` that reads the *running* harness for
 * an agent — `Engine`/`SessionRunner.ts` state this file's scope does not
 * include — so that plumbing is left to whoever owns those files, same as
 * `chat.continue`'s mention-parsing was left to the round-table dispatcher
 * task in the Phase 4 contracts report. Until then, `snapshotFor` absent is a
 * legitimate input (an agent that has not run a turn yet) and produces
 * exactly the placeholder's answer, not a crash.
 */
import type {
  Agent,
  AgentDescribe,
  AgentDescribeOther,
  AgentUsageSummary,
} from "@capygen/shared";
import {
  composeAgentDescribe,
  describeApiAgent,
  describeClaudeAgent,
  describeCodexAgent,
  type AgentDescribeCore,
  type ApiDescribeSnapshot,
  type ClaudeInitSnapshot,
  type CodexDescribeSnapshot,
  type HarnessCapabilities,
} from "@capygen/engine";

/** What a running harness can offer this file, per backend. Exactly one of
 *  `claude`/`codex`/`api` is set — whichever matches `agent.backend` — since a
 *  harness only ever knows its own backend's shape. */
export interface AgentHarnessSnapshot {
  capabilities: HarnessCapabilities;
  claude?: ClaudeInitSnapshot;
  codex?: CodexDescribeSnapshot;
  api?: ApiDescribeSnapshot;
}

export interface AgentsDescribeDeps {
  /** `store.sessions.agent(agentId)`. */
  getAgent(agentId: string): Agent | undefined;
  /** `store.sessions.agents(sessionId)` filtered to everyone but `agentId`,
   *  already shaped as `AgentDescribeOther` — the same mapping the placeholder
   *  handler in `handlers.ts` does inline today. */
  listOtherAgents(sessionId: string, agentId: string): AgentDescribeOther[];
  /** `store.usage.totalsByAgent(agentId)` — SPEC R13's "cost so far". */
  usageFor(agentId: string): AgentUsageSummary;
  /**
   * The live harness's own facts for this agent, when one is running.
   * Undefined for an agent that has never sent a turn — `describeAgent` then
   * falls back to config-only info (below) instead of guessing at tools or
   * capabilities no harness has reported yet.
   */
  snapshotFor?(agentId: string): AgentHarnessSnapshot | undefined;
}

const NO_CAPABILITIES: HarnessCapabilities = {
  streamingDeltas: false,
  permissions: false,
  questions: false,
  subagents: false,
  resume: false,
  interrupt: false,
  slashCommands: false,
};

export function describeAgent(deps: AgentsDescribeDeps, agentId: string): AgentDescribe {
  const agent = deps.getAgent(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const core = describeCore(agent, deps.snapshotFor?.(agentId));
  const usage = deps.usageFor(agentId);
  const others = deps.listOtherAgents(agent.sessionId, agentId);
  return composeAgentDescribe(core, usage, others);
}

function describeCore(agent: Agent, snapshot: AgentHarnessSnapshot | undefined): AgentDescribeCore {
  const capabilities = snapshot?.capabilities ?? NO_CAPABILITIES;
  if (snapshot?.claude) {
    return describeClaudeAgent({ role: agent.role, snapshot: snapshot.claude, capabilities });
  }
  if (snapshot?.codex) {
    return describeCodexAgent({ role: agent.role, snapshot: snapshot.codex, capabilities });
  }
  if (snapshot?.api) {
    return describeApiAgent({ role: agent.role, snapshot: snapshot.api, capabilities });
  }
  // No live snapshot — the same honest emptiness `handlers.ts`'s placeholder
  // handler returns today (its own comment: "an agent with no turns run yet…
  // honestly returns both empty rather than a guess").
  return {
    description: agent.description ?? "",
    capabilities: [],
    tools: [],
    model: agent.model,
    backend: agent.backend,
  };
}

/**
 * `CodexDescribeSnapshot`'s `approvalPolicy`/`sandbox` need no live harness at
 * all (see `describe/codex.ts`'s header): they are exactly what
 * `CodexHarness.startThread` would default `agent.config.codex` to. A caller
 * building a Codex snapshot combines this with a live `listMcpServers()` /
 * `listSkills()` call when a harness is running, or passes `[]` for both when
 * it is not — either way the sandbox/approval/model facts are already right.
 */
export function codexConfigDefaults(agent: Agent): Pick<CodexDescribeSnapshot, "model" | "approvalPolicy" | "sandbox"> {
  const config = agent.config?.codex;
  return {
    model: config?.model ?? agent.model,
    approvalPolicy: config?.approvalPolicy ?? "on-request",
    sandbox: config?.sandbox ?? "workspace-write",
  };
}

/** `ApiDescribeSnapshot`'s `provider`/`model` straight from the agent's own
 *  config — `builtinTools()`/`loadMcpServers()` still need a caller to run
 *  them (the former is pure, the latter reads disk), but neither needs a live
 *  harness either. */
export function apiConfigDefaults(agent: Agent): Pick<ApiDescribeSnapshot, "provider" | "model"> {
  const config = agent.config?.api;
  return {
    provider: config?.provider ?? "anthropic",
    model: config?.model ?? agent.model,
  };
}
