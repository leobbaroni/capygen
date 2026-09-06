/**
 * The agent info card (SPEC R13) and the one editable policy it carries: the
 * agent's own sub-agent routing rule (SPEC R12).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentDescribe } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { AgentInfoDrawer } from "./AgentInfoDrawer";

const initial = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initial);
});

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a-alice",
    sessionId: "s1",
    name: "alice",
    displayName: "Alice",
    mentionName: "alice",
    backend: "claude",
    model: "claude-opus-4-5",
    role: "lead",
    order: 0,
    config: null,
    createdAt: 0,
    ...overrides,
  };
}

function describeOf(description: string): AgentDescribe {
  return {
    backend: "claude",
    model: "claude-opus-4-5",
    description,
    capabilities: [],
    tools: [],
    usage: { input: 0, output: 0, cached: 0, costUsd: 0 },
    others: [],
  };
}

describe("AgentInfoDrawer (SPEC R13)", () => {
  it("does not print the user's own note twice under two headings", async () => {
    // With no running harness `describeCore` falls back to the agent's own
    // description, so both sections said exactly the same sentence.
    const note = "Writes and reviews the prose.";
    useAppStore.setState({ describeAgent: async () => describeOf(note) });
    render(<AgentInfoDrawer agent={agent({ description: note })} onBack={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-info-description")).toHaveTextContent(note),
    );
    expect(screen.queryByTestId("agent-info-usage-description")).not.toBeInTheDocument();
  });

  it("keeps both when the harness actually says something else", async () => {
    useAppStore.setState({
      describeAgent: async () => describeOf("Claude Code on claude-opus-4-5, 12 tools."),
    });
    render(<AgentInfoDrawer agent={agent({ description: "My reviewer." })} onBack={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-info-usage-description")).toHaveTextContent("12 tools"),
    );
    expect(screen.getByTestId("agent-info-description")).toHaveTextContent("My reviewer.");
  });
});

describe("sub-agent routing is reachable after creation (SPEC R12)", () => {
  it("saves a rule the agent was created without", async () => {
    const user = userEvent.setup();
    const updateAgent = vi.fn().mockResolvedValue(agent({}));
    useAppStore.setState({ describeAgent: async () => describeOf("x"), updateAgent });
    render(<AgentInfoDrawer agent={agent({})} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("agent-info-routing")).toBeInTheDocument());
    expect(screen.getByTestId("agent-info-routing-effect")).toHaveTextContent("inherit");

    await user.selectOptions(screen.getByTestId("agent-info-routing-backend"), "codex");
    await user.type(screen.getByTestId("agent-info-routing-model"), "gpt-5.5");
    await user.click(screen.getByTestId("agent-info-routing-save"));

    expect(updateAgent).toHaveBeenCalledWith("a-alice", {
      subagentRouting: { backend: "codex", model: "gpt-5.5" },
    });
  });

  it("says a Codex agent's cross-backend rule cannot be applied", async () => {
    useAppStore.setState({ describeAgent: async () => describeOf("x") });
    render(
      <AgentInfoDrawer
        agent={agent({
          backend: "codex",
          model: "gpt-5.5",
          subagentRouting: { backend: "claude", model: "claude-haiku-4-5" },
        })}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("agent-info-routing")).toBeInTheDocument());
    // ADR-0004: `codex app-server` takes MCP servers only from config.toml, so
    // the rule fails open — and until now nothing but a log line said so.
    expect(screen.getByTestId("agent-info-routing-effect")).toHaveTextContent(
      "cannot be applied",
    );
  });
});
