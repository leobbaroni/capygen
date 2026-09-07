import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_SETTINGS, type Agent, type Block, type Session } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { AgentsPane } from "./AgentsPane";

const initial = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initial);
});

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a-capy",
    sessionId: "s1",
    name: "capy",
    displayName: "Capy",
    mentionName: "capy",
    backend: "claude",
    model: "claude-opus-4-5",
    role: "lead",
    order: 0,
    config: null,
    createdAt: 0,
    ...overrides,
  };
}

const session: Session = {
  id: "s1",
  projectId: "p1",
  mode: "round-table",
  leadAgentId: "a-capy",
  title: "Round table",
  status: "idle",
  settings: DEFAULT_SESSION_SETTINGS,
  createdAt: 0,
  updatedAt: 0,
  archived: false,
};

const agents: Agent[] = [
  agent({ id: "a-capy", mentionName: "capy", displayName: "Capy", role: "lead", order: 0 }),
  agent({
    id: "a-codex",
    mentionName: "codex",
    displayName: "Codex",
    backend: "codex",
    model: "gpt-5.5",
    role: "member",
    order: 1,
  }),
];

const subagentBlock: Block = {
  id: "sub-1",
  turnId: "t1",
  sessionId: "s1",
  index: 0,
  createdAt: 0,
  updatedAt: 0,
  kind: "subagent",
  agentId: null,
  parentAgentId: "a-codex",
  name: "reviewer",
  backend: "codex",
  model: "gpt-5.5-mini",
  description: "Reviews the diff.",
  status: "running",
  costUsd: 0.02,
};

function seed(): void {
  useAppStore.setState({
    sessions: [session],
    agents,
    blocks: { [subagentBlock.id]: subagentBlock },
    harnesses: [],
  });
}

describe("AgentsPane tree (SPEC R13, item B2.3)", () => {
  it("lists every top-level agent in order", () => {
    seed();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);

    const rows = screen.getAllByTestId("agents-tree-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Capy")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Codex")).toBeInTheDocument();
  });

  it("marks the lead agent", () => {
    seed();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);
    const leadRow = screen.getAllByTestId("agents-tree-row")[0]!;
    expect(within(leadRow).getByLabelText("Lead agent")).toBeInTheDocument();
  });

  it("groups sub-agent blocks under their parentAgentId", () => {
    seed();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);

    const codexRow = screen.getAllByTestId("agents-tree-row")[1]!;
    expect(within(codexRow).getByTestId("agents-tree-subagent")).toHaveTextContent("reviewer");
    // The lead's row has no sub-agents to show.
    const leadRow = screen.getAllByTestId("agents-tree-row")[0]!;
    expect(within(leadRow).queryByTestId("agents-tree-subagent")).not.toBeInTheDocument();
  });

  it("shows '+ Add agent' only in round-table sessions", () => {
    seed();
    const { rerender } = render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByTestId("agents-pane-add")).toBeInTheDocument();

    useAppStore.setState({ sessions: [{ ...session, mode: "solo" }] });
    rerender(<AgentsPane sessionId="s1" onClose={vi.fn()} />);
    expect(screen.queryByTestId("agents-pane-add")).not.toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    seed();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AgentsPane sessionId="s1" onClose={onClose} />);

    await user.click(screen.getByTestId("agents-pane-close"));

    expect(onClose).toHaveBeenCalled();
  });
});

describe("AgentsPane → AgentInfoDrawer (SPEC R13)", () => {
  it("opens the info drawer for the clicked agent and can navigate back", async () => {
    seed();
    useAppStore.setState({
      describeAgent: vi.fn().mockResolvedValue({
        description: "Runs shell commands and reviews diffs.",
        capabilities: ["shell"],
        tools: ["Bash"],
        model: "gpt-5.5",
        backend: "codex",
        usage: { input: 100, output: 50, cached: 0, costUsd: 0.01 },
        others: [{ agentId: "a-capy", mentionName: "capy", backend: "claude", model: "claude-opus-4-5" }],
      }),
    });
    const user = userEvent.setup();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);

    const codexRow = screen.getAllByTestId("agent-tree-select")[1]!;
    await user.click(codexRow);

    expect(await screen.findByTestId("agent-info-drawer")).toBeInTheDocument();
    expect(screen.getByText("Runs shell commands and reviews diffs.")).toBeInTheDocument();
    expect(screen.getByTestId("agent-info-other")).toHaveTextContent("@capy");
    // The tree is replaced, not layered underneath.
    expect(screen.queryByTestId("agents-tree")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("agent-info-back"));
    expect(screen.getByTestId("agents-tree")).toBeInTheDocument();
  });

  it("shows an error instead of hanging when agents.describe fails", async () => {
    seed();
    useAppStore.setState({ describeAgent: vi.fn().mockRejectedValue(new Error("unknown agent")) });
    const user = userEvent.setup();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);

    await user.click(screen.getAllByTestId("agent-tree-select")[0]!);

    expect(await screen.findByTestId("agent-info-error")).toHaveTextContent("unknown agent");
  });
});

describe("the roster is editable, not append-only (SPEC R12/R13)", () => {
  it("promotes a member to lead and removes an agent", async () => {
    const user = userEvent.setup();
    seed();
    const setLead = vi.fn().mockResolvedValue(session);
    const removeAgent = vi.fn().mockResolvedValue(true);
    useAppStore.setState({ setLead, removeAgent });
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);

    const codexRow = screen.getAllByTestId("agents-tree-row")[1]!;
    await user.click(within(codexRow).getByTestId("agent-make-lead"));
    expect(setLead).toHaveBeenCalledWith("s1", "a-codex");

    await user.click(within(codexRow).getByTestId("agent-remove"));
    expect(removeAgent).toHaveBeenCalledWith("a-codex");
  });

  it("offers no crown on the lead and no remove on the last agent", () => {
    useAppStore.setState({
      sessions: [session],
      agents: [agents[0]!],
      blocks: {},
      harnesses: [],
    });
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);
    const row = screen.getAllByTestId("agents-tree-row")[0]!;
    expect(within(row).queryByTestId("agent-make-lead")).not.toBeInTheDocument();
    // A session with no agents answers nothing, so the last one stays.
    expect(within(row).queryByTestId("agent-remove")).not.toBeInTheDocument();
  });

  it("keeps a sub-agent's name legible and recoverable", () => {
    seed();
    render(<AgentsPane sessionId="s1" onClose={vi.fn()} />);
    const sub = screen.getByTestId("agents-tree-subagent");
    // The name, not the model id, is what the tree exists to show.
    expect(within(sub).getByTitle("reviewer")).toBeInTheDocument();
    expect(within(sub).getByTitle("gpt-5.5-mini")).toBeInTheDocument();
  });
});

/**
 * [7-P1] A model/config edit made mid-turn applies to the agent's next turn.
 * The pane says so rather than leaving the user to wonder whether the change
 * was accepted at all.
 */
describe("pending restart badge", () => {
  it("marks only the agent whose configuration is waiting", () => {
    useAppStore.setState({
      sessions: [session],
      agents,
      pendingAgentRestarts: [agents[0]!.id],
    });
    render(<AgentsPane sessionId={session.id} onClose={() => {}} />);
    const rows = screen.getAllByTestId("agents-tree-row");
    expect(within(rows[0]!).getByTestId("agent-restart-pending")).toBeInTheDocument();
    for (const row of rows.slice(1)) {
      expect(within(row).queryByTestId("agent-restart-pending")).not.toBeInTheDocument();
    }
  });

  it("shows nothing when no restart is pending", () => {
    useAppStore.setState({ sessions: [session], agents, pendingAgentRestarts: [] });
    render(<AgentsPane sessionId={session.id} onClose={() => {}} />);
    expect(screen.queryByTestId("agent-restart-pending")).not.toBeInTheDocument();
  });
});
