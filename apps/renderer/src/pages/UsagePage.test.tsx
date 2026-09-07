import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { expect, it, vi, beforeEach } from "vitest";
import { UsagePage } from "./UsagePage";

const invoke = vi.fn(async (channel: string) => channel === "usage.report" ? ({ range: { from: 1, to: 2, timeZone: "UTC" }, totals: { events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }, days: [{ day: "2026-09-07", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }], byBackendModel: [{ backend: "claude", model: "sonnet", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }], sessions: [{ sessionId: "s1", title: "Review", events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0.01, unknownCostEvents: 1 }] }) : []);
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: () => () => {} }) }));
beforeEach(() => invoke.mockClear());

it("renders unknown cost events explicitly instead of treating them as zero", async () => {
  render(<MemoryRouter><UsagePage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Unknown cost events")).toBeTruthy());
  expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/c/s1");
  expect(invoke).toHaveBeenCalledWith("usage.report", expect.objectContaining({ timeZone: expect.any(String), from: expect.any(Number), to: expect.any(Number) }));
});

it("hides the previous report when the selected range fails", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><UsagePage /></MemoryRouter>);
  await screen.findByRole("link", { name: "Review" });
  invoke.mockRejectedValueOnce(new Error("Invalid range"));
  await user.click(screen.getByRole("button", { name: "Custom" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
});
