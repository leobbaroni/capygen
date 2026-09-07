import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi, beforeEach } from "vitest";
import { UsagePage } from "./UsagePage";

const invoke = vi.fn(async (channel: string) => channel === "usage.report" ? ({ range: { from: 1, to: 2, timeZone: "UTC" }, totals: { events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }, days: [{ day: "2026-09-07", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }], byBackendModel: [{ backend: "claude", model: "sonnet", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }], sessions: [{ sessionId: "s1", title: "Review", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }] }) : []);
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: () => () => {} }) }));
beforeEach(() => invoke.mockClear());

it("renders unknown cost events explicitly instead of treating them as zero", async () => {
  render(<UsagePage />);
  await waitFor(() => expect(screen.getByText("Unknown cost events")).toBeTruthy());
  expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  expect(invoke).toHaveBeenCalledWith("usage.report", expect.objectContaining({ timeZone: expect.any(String), from: expect.any(Number), to: expect.any(Number) }));
});
