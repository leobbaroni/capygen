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

describe("agent configuration", () => {
  it("saves a bounded API context capacity and preserves API config", async () => {
    const user = userEvent.setup(); const updateAgent = vi.fn().mockResolvedValue(agent({}));
    useAppStore.setState({ describeAgent: async () => describeOf("x"), updateAgent });
    render(<AgentInfoDrawer agent={agent({ backend: "api", config: { api: { provider: "openai", contextWindowTokens: 4096 } } as never })} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("agent-info-api-capacity")).toBeInTheDocument());
    await user.clear(screen.getByTestId("agent-info-api-capacity-input")); await user.type(screen.getByTestId("agent-info-api-capacity-input"), "8192"); await user.click(screen.getByRole("button", { name: "Save capacity" }));
    expect(updateAgent).toHaveBeenCalledWith("a-alice", { config: { api: { provider: "openai", contextWindowTokens: 8192 } } });
  });
  it.each(["claude", "codex", "api"] as const)("saves supported %s effort and preserves other config", async (backend) => {
    const user = userEvent.setup(); const updateAgent = vi.fn().mockResolvedValue(agent({}));
    useAppStore.setState({ describeAgent: async () => describeOf("x"), updateAgent,
      harnesses: [{ backend, available: true, models: [{ id: "real-model", label: "Catalogue model", efforts: ["low", "high"] }], defaultModel: "real-model" }] as never });
    render(<AgentInfoDrawer agent={agent({ backend, model: "real-model", config: { [backend]: { marker: "keep" } } })} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Agent effort")).toBeInTheDocument());
    expect(screen.getByText("Catalogue model")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-info-routing")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Agent effort"), "high");
    await user.click(screen.getByRole("button", { name: "Save effort" }));
    expect(updateAgent).toHaveBeenCalledWith("a-alice", { config: { [backend]: { marker: "keep", [backend === "claude" ? "effort" : "reasoningEffort"]: "high" } } });
  });
});
