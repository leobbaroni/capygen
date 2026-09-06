import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { GitSection } from "./GitSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
});

describe("GitSection", () => {
  it("defaults autoCommitMessages (unset) to 'Ask each time'", async () => {
    render(<GitSection />);
    expect(await screen.findByTestId("settings-git")).toBeInTheDocument();
    expect(screen.getByTestId("select-auto-commit-messages")).toHaveValue("ask");
    expect(screen.getByTestId("toggle-worktree-default")).toHaveAttribute("aria-checked", "false");
  });

  it("patches autoCommitMessages: true for 'Always generate'", async () => {
    const user = userEvent.setup();
    render(<GitSection />);
    await screen.findByTestId("settings-git");

    await user.selectOptions(screen.getByTestId("select-auto-commit-messages"), "always");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { git: { autoCommitMessages: true } } }),
    );
  });

  it("toggles worktreeDefault", async () => {
    const user = userEvent.setup();
    render(<GitSection />);
    await screen.findByTestId("settings-git");

    await user.click(screen.getByTestId("toggle-worktree-default"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { git: { worktreeDefault: true } } }),
    );
  });
});
