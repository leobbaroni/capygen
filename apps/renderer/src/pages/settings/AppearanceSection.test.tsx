import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { AppearanceSection } from "./AppearanceSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
});

describe("AppearanceSection", () => {
  it("renders the shipping theme/palette/font-scale/reduced-motion defaults", async () => {
    render(<AppearanceSection />);
    expect(await screen.findByTestId("settings-appearance")).toBeInTheDocument();
    expect(screen.getByTestId("select-theme")).toHaveValue("system");
    expect(screen.getByTestId("select-palette")).toHaveValue("default");
    expect(screen.getByTestId("select-font-scale")).toHaveValue("1");
    expect(screen.getByTestId("toggle-reduced-motion")).toHaveAttribute("aria-checked", "false");
  });

  it("patches appearance.theme to 'dark' when the theme select changes", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await screen.findByTestId("settings-appearance");

    await user.selectOptions(screen.getByTestId("select-theme"), "dark");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { appearance: { theme: "dark" } } }),
    );
  });

  it("patches appearance.palette", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await screen.findByTestId("settings-appearance");

    await user.selectOptions(screen.getByTestId("select-palette"), "nord");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { appearance: { palette: "nord" } } }),
    );
  });

  it("toggles reducedMotion", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await screen.findByTestId("settings-appearance");

    await user.click(screen.getByTestId("toggle-reduced-motion"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings.patch", { patch: { appearance: { reducedMotion: true } } }),
    );
  });
});
