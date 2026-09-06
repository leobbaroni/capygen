/**
 * Settings ▸ General: `settings.getAll`/`settings.patch` mocked — the
 * section's own field wiring is what's under test.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { GeneralSection } from "./GeneralSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "settings.getAll") return Promise.resolve(DEFAULT_GLOBAL_SETTINGS);
    if (channel === "settings.patch")
      return Promise.resolve({ ...DEFAULT_GLOBAL_SETTINGS, general: { ...DEFAULT_GLOBAL_SETTINGS.general, defaultBackend: "codex" } });
    return Promise.resolve(DEFAULT_GLOBAL_SETTINGS);
  });
});

describe("GeneralSection", () => {
  it("renders the shipping defaults once settings.getAll resolves", async () => {
    render(<GeneralSection />);
    expect(await screen.findByTestId("settings-general")).toBeInTheDocument();
    expect(screen.getByTestId("select-default-backend")).toHaveValue("claude");
    expect(screen.getByTestId("input-default-model")).toHaveValue(DEFAULT_GLOBAL_SETTINGS.general.defaultModel);
  });

  it("patches general.defaultBackend when the select changes", async () => {
    const user = userEvent.setup();
    render(<GeneralSection />);
    await screen.findByTestId("settings-general");

    await user.selectOptions(screen.getByTestId("select-default-backend"), "codex");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { general: { defaultBackend: "codex" } } }),
    );
  });

  it("toggles submitWithCtrlEnter", async () => {
    const user = userEvent.setup();
    render(<GeneralSection />);
    await screen.findByTestId("settings-general");

    await user.click(screen.getByTestId("toggle-submit-ctrl-enter"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { general: { submitWithCtrlEnter: true } } }),
    );
  });
});
