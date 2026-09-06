/**
 * Settings ▸ Harnesses: `appStore.harnesses` seeded directly (the same
 * fixture pattern `DevAgentsPage` uses) rather than mocking the store module
 * — `useAppStore` is real zustand, so `setState` is enough.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, type HarnessInfo } from "@capygen/shared";
import { HarnessesSection } from "./HarnessesSection";
import { useAppStore } from "@/store/appStore";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const FIXTURE_HARNESSES: HarnessInfo[] = [
  { backend: "claude", label: "Claude Code", available: true, models: [], defaultModel: "claude-opus-4-5" },
  { backend: "codex", label: "Codex", available: false, reason: "Codex is not signed in", models: [], defaultModel: "gpt-5.5" },
  { backend: "api", label: "API model", available: false, reason: "No API key configured", models: [], defaultModel: "" },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
  useAppStore.setState({ harnesses: FIXTURE_HARNESSES });
});

afterEach(() => {
  useAppStore.setState({ harnesses: [] });
});

describe("HarnessesSection", () => {
  it("shows availability + reason for every backend from appStore.harnesses", async () => {
    render(<HarnessesSection />);
    expect(await screen.findByTestId("settings-harnesses")).toBeInTheDocument();
    expect(screen.getByTestId("harness-status-claude")).toHaveTextContent("Available");
    expect(screen.getByTestId("harness-status-codex")).toHaveTextContent("Codex is not signed in");
    expect(screen.getByTestId("harness-status-api")).toHaveTextContent("No API key configured");
  });

  it("patches backends.claude.permissionMode from the claude card's Defaults", async () => {
    const user = userEvent.setup();
    render(<HarnessesSection />);
    await screen.findByTestId("settings-harnesses");
    await waitFor(() => expect(screen.getByTestId("select-claude-permission-mode")).toBeInTheDocument());

    await user.selectOptions(screen.getByTestId("select-claude-permission-mode"), "acceptEdits");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", {
        patch: { backends: { claude: { permissionMode: "acceptEdits" } } },
      }),
    );
  });

  it("patches backends.codex.approvalPolicy and .sandbox independently", async () => {
    const user = userEvent.setup();
    render(<HarnessesSection />);
    await screen.findByTestId("settings-harnesses");
    await waitFor(() => expect(screen.getByTestId("select-codex-sandbox")).toBeInTheDocument());

    await user.selectOptions(screen.getByTestId("select-codex-sandbox"), "workspace-write");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", {
        patch: { backends: { codex: { sandbox: "workspace-write" } } },
      }),
    );
  });

  it("mentions per-agent overrides winning over the default", async () => {
    render(<HarnessesSection />);
    await screen.findByTestId("settings-harnesses");
    expect(screen.getAllByText(/per-agent override wins/i).length).toBeGreaterThan(0);
  });
});
