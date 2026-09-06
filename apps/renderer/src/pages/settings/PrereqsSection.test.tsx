/**
 * Settings ▸ Prerequisites: a thin wrapper around the shared `PrereqPanel`
 * (`components/prereqs/PrereqPanel.test.tsx` owns the behavioural coverage —
 * re-detect, Run, polling, blocked steps); this just confirms the section
 * renders it with real data reaching the page.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrereqStep } from "@capygen/shared";
import { PrereqsSection } from "./PrereqsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const STEPS: PrereqStep[] = [
  { id: "claude-cli", title: "Claude Code CLI", detected: true, version: "2.1.261", command: "winget install …", description: "", kind: "cli" },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "prereqs.status") return Promise.resolve({ steps: STEPS, recommendation: "All set." });
    return Promise.resolve({ ok: true });
  });
});

describe("PrereqsSection", () => {
  it("renders the shared PrereqPanel with the section's own heading", async () => {
    render(<PrereqsSection />);
    expect(screen.getByTestId("settings-prereqs")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Prerequisites" })).toBeInTheDocument();
    expect(await screen.findByTestId("prereq-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("prereq-recommendation")).toHaveTextContent("All set.");
  });
});
