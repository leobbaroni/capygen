import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ContextMeter } from "./ContextMeter";
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ hasBridge: () => true, ipc: () => ({ invoke, on: () => () => {} }) }));
it("shows independent measured windows and never estimates an unknown capacity", async () => {
  invoke.mockResolvedValue([
    { agentId: "lead", backend: "claude", model: "lead", inputTokens: 100, capacityTokens: 200, source: "last-request", updatedAt: 1 },
    { agentId: "worker", parentAgentId: "lead", displayName: "Worker", backend: "codex", model: "worker", inputTokens: 30, capacityTokens: null, source: "last-request", updatedAt: 1 },
  ]);
  render(<ContextMeter sessionId="s" mode="custom" />);
  await waitFor(() => expect(screen.getByText("100 / 200")).toBeInTheDocument());
  expect(screen.getByText("30 / limit unknown")).toBeInTheDocument();
  expect(screen.getAllByRole("progressbar", { hidden: true })).toHaveLength(1);
  expect(screen.getByText(/Windows are not pooled/)).toBeInTheDocument();
});
