import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { ShortcutsSection } from "./ShortcutsSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
});

describe("ShortcutsSection", () => {
  it("shows the shipped default combo for every shortcut row", async () => {
    render(<ShortcutsSection />);
    expect(await screen.findByTestId("settings-shortcuts")).toBeInTheDocument();
    expect(screen.getByTestId("shortcut-combo-composer.submit")).toHaveTextContent("Enter");
    expect(screen.getByTestId("shortcut-combo-session.new")).toHaveTextContent("Ctrl+N");
  });

  it("edits a combo and patches the whole overrides map", async () => {
    const user = userEvent.setup();
    render(<ShortcutsSection />);
    await screen.findByTestId("settings-shortcuts");

    await user.click(screen.getByTestId("shortcut-combo-session.new"));
    const input = screen.getByTestId("shortcut-input-session.new");
    await user.clear(input);
    await user.type(input, "Ctrl+Shift+N");
    await user.click(screen.getByTestId("shortcut-save-session.new"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", {
        patch: { shortcuts: { overrides: { "session.new": "Ctrl+Shift+N" } } },
      }),
    );
  });

  it("resets an overridden combo back to the shipped default", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "settings.getAll") {
        return Promise.resolve({
          ...DEFAULT_GLOBAL_SETTINGS,
          shortcuts: { overrides: { "session.new": "Ctrl+Shift+N" } },
        });
      }
      return Promise.resolve(DEFAULT_GLOBAL_SETTINGS);
    });
    const user = userEvent.setup();
    render(<ShortcutsSection />);
    await screen.findByTestId("settings-shortcuts");
    expect(screen.getByTestId("shortcut-combo-session.new")).toHaveTextContent("Ctrl+Shift+N");

    await user.click(screen.getByTestId("shortcut-reset-session.new"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { shortcuts: { overrides: {} } } }),
    );
  });
});
