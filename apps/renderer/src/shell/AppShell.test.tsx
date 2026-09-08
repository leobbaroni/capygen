/**
 * `AppShell` mounts `useApplyGlobalTheme` (Phase 6) — this is the "theme
 * application" integration test: `settings.getAll`'s answer lands on
 * `<html>` as `.dark`, and a later `settings.changed` broadcast (what
 * `AppearanceSection`'s own `settings.patch` triggers) re-applies live,
 * without this component reading `appStore.settings.theme` any more.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { AppShell } from "./AppShell";
import { useAppStore } from "@/store/appStore";

const invoke = vi.fn();
let changedListener: ((payload: { settings: typeof DEFAULT_GLOBAL_SETTINGS }) => void) | null = null;

vi.mock("@/lib/ipc", () => ({
  ipc: () => ({
    invoke,
    on: (event: string, listener: (payload: unknown) => void) => {
      if (event === "settings.changed") changedListener = listener as typeof changedListener;
      return () => undefined;
    },
  }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  changedListener = null;
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  useAppStore.setState({ sessions: [], activeSessionId: null });
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell theme wiring", () => {
  it("applies .dark on <html> from the fetched GlobalSettings.appearance.theme", async () => {
    invoke.mockResolvedValue({ ...DEFAULT_GLOBAL_SETTINGS, appearance: { ...DEFAULT_GLOBAL_SETTINGS.appearance, theme: "dark" } });
    renderShell();

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(invoke).toHaveBeenCalledWith("settings.getAll", {});
  });

  it("re-applies live on a settings.changed broadcast (a patch from the Appearance section)", async () => {
    invoke.mockResolvedValue(DEFAULT_GLOBAL_SETTINGS);
    renderShell();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings.getAll", {}));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    changedListener?.({ settings: { ...DEFAULT_GLOBAL_SETTINGS, appearance: { ...DEFAULT_GLOBAL_SETTINGS.appearance, theme: "light", palette: "nord" } } });

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    expect(document.documentElement.getAttribute("data-theme")).toBe("nord");
  });
});
