import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubagentCard } from "./SubagentCard";

const base = { id: "b", turnId: "t", sessionId: "s", index: 0, agentId: null, kind: "subagent" as const, createdAt: 1, updatedAt: 1 };

describe("SubagentCard crew routing", () => {
  it("shows route metadata when expanded, including an empty description", async () => {
    render(<SubagentCard block={{ ...base, name: "worker", backend: "codex", model: "astra", description: "", status: "done", crewRoute: {
      ruleId: "design-rule", rosterId: "design", taskKind: "design", difficulty: "medium",
      target: { backend: "codex", model: "astra", effort: "low" },
    } }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("block-subagent-crew-route")).toHaveTextContent("Rule: design-rule");
    expect(screen.getByTestId("block-subagent-crew-route")).toHaveTextContent("Roster: design");
    expect(screen.getByTestId("block-subagent-crew-route")).toHaveTextContent("Classified: design · medium");
    expect(screen.getByTestId("block-subagent-crew-route")).toHaveTextContent("Target: codex · astra · low");
  });

  it("keeps legacy cards without route metadata", async () => {
    render(<SubagentCard block={{ ...base, name: "worker", backend: "claude", model: "sonnet", description: "old", status: "running" }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.queryByTestId("block-subagent-crew-route")).toBeNull();
  });
});
