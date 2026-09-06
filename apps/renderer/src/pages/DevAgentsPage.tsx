/**
 * `/dev/agents` — fixture round-table session for visual QA and the B2
 * screenshot evidence (`e2e-out/agents-pane.png`, `e2e-out/add-agent.png`).
 * Seeds a fixture session, its agents, and a couple of subagent blocks into
 * the real store (restored on unmount) — the same pattern `DevCardsPage`
 * uses — then renders `AgentsPane` against it. Nothing here talks to a real
 * backend: the pane's own "Add agent" button opens `AddAgentDialog` in
 * `live` mode, whose submit calls the store's `addAgent`, which would throw
 * against a real IPC bridge outside Electron — the screenshot script only
 * needs the dialog *open*, never actually submits it.
 *
 * `App.tsx` only mounts this route when `import.meta.env.DEV` — it never
 * ships in a production build.
 */
import { useEffect } from "react";
import type { Agent, Block, HarnessInfo, Session } from "@capygen/shared";
import { DEFAULT_SESSION_SETTINGS } from "@capygen/shared";
import { AgentsPane } from "@/components/AgentsPane";
import { useAppStore } from "@/store/appStore";

const SESSION_ID = "session-fixture-agents";
const PROJECT_ID = "project-fixture-agents";

const FIXTURE_SESSION: Session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  mode: "round-table",
  leadAgentId: "agent-capy",
  title: "Round-table fixture",
  status: "idle",
  settings: DEFAULT_SESSION_SETTINGS,
  createdAt: 0,
  updatedAt: 0,
  archived: false,
};

const FIXTURE_AGENTS: Agent[] = [
  {
    id: "agent-capy",
    sessionId: SESSION_ID,
    name: "capy",
    displayName: "Capy",
    mentionName: "capy",
    backend: "claude",
    model: "claude-opus-4-5",
    role: "lead",
    description: "Orchestrates the round-table and reviews every plan before it ships.",
    order: 0,
    config: null,
    createdAt: 0,
  },
  {
    id: "agent-codex",
    sessionId: SESSION_ID,
    name: "codex",
    displayName: "Codex",
    mentionName: "codex",
    backend: "codex",
    model: "gpt-5.5",
    role: "member",
    description: "Runs shell commands and reviews diffs.",
    subagentRouting: { backend: "codex", model: "gpt-5.5-mini" },
    order: 1,
    config: null,
    createdAt: 0,
  },
  {
    id: "agent-haiku",
    sessionId: SESSION_ID,
    name: "haiku",
    displayName: "Haiku reviewer",
    mentionName: "haiku",
    backend: "api",
    model: "claude-haiku-4-5",
    role: "member",
    order: 2,
    config: null,
    createdAt: 0,
  },
];

const base = { turnId: "turn-fixture", sessionId: SESSION_ID, index: 0, createdAt: 0, updatedAt: 0 };

const FIXTURE_BLOCKS: Block[] = [
  {
    ...base,
    id: "subagent-1",
    kind: "subagent",
    agentId: null,
    parentAgentId: "agent-codex",
    name: "reviewer",
    backend: "codex",
    model: "gpt-5.5-mini",
    description: "Reviews the diff.",
    status: "done",
    costUsd: 0.0123,
    delegated: true,
  },
  {
    ...base,
    id: "subagent-2",
    kind: "subagent",
    agentId: null,
    parentAgentId: "agent-codex",
    name: "test-runner",
    backend: "codex",
    model: "gpt-5.5-mini",
    description: "Runs the test suite.",
    status: "running",
  },
];

const FIXTURE_HARNESSES: HarnessInfo[] = [
  {
    backend: "claude",
    label: "Claude Code",
    available: true,
    models: [
      { id: "claude-opus-4-5", label: "Opus 4.5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
    ],
    defaultModel: "claude-opus-4-5",
  },
  {
    backend: "codex",
    label: "Codex",
    available: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini" },
    ],
    defaultModel: "gpt-5.5",
  },
  {
    backend: "api",
    label: "API model",
    available: true,
    models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
    defaultModel: "claude-haiku-4-5",
  },
];

export function DevAgentsPage() {
  useEffect(() => {
    const before = useAppStore.getState();
    useAppStore.setState({
      sessions: [FIXTURE_SESSION, ...before.sessions.filter((s) => s.id !== SESSION_ID)],
      activeSessionId: SESSION_ID,
      agents: FIXTURE_AGENTS,
      blocks: { ...before.blocks, ...Object.fromEntries(FIXTURE_BLOCKS.map((b) => [b.id, b])) },
      harnesses: FIXTURE_HARNESSES,
    });
    return () => {
      useAppStore.setState({
        sessions: before.sessions,
        activeSessionId: before.activeSessionId,
        agents: before.agents,
        blocks: before.blocks,
        harnesses: before.harnesses,
      });
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1" data-testid="dev-agents-page">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-8">
        <h1 className="text-2xl font-semibold text-foreground">Agents pane fixture</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          A fixture round-table session — not a real backend. Use the pane's own "Add agent"
          button for the dialog screenshot. Dev-only route, never part of a production build.
        </p>
      </div>
      <AgentsPane sessionId={SESSION_ID} onClose={() => undefined} />
    </div>
  );
}
