/**
 * The Settings hub shell: the nav renders every section id (Task B2's own
 * "nav lists every section id" requirement — mirrored against
 * `shell/settingsNav.test.tsx`'s own assertion on the same array so the two
 * can't drift), and each id routes to a body that actually renders under
 * mocked IPC — not just a blank pane.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@capygen/shared";
import { SettingsPage } from "./SettingsPage";
import { SETTINGS_SECTIONS } from "@/shell/settingsNav";
import { useAppStore } from "@/store/appStore";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    switch (channel) {
      case "settings.getAll":
        return Promise.resolve(DEFAULT_GLOBAL_SETTINGS);
      case "settings.patch":
      case "settings.reset":
        return Promise.resolve(DEFAULT_GLOBAL_SETTINGS);
      case "integrations.list":
        return Promise.resolve({ mcpServers: [], plugins: [], skills: [], tools: [], lastSync: null });
      case "integrations.plugin.marketplaces":
        return Promise.resolve([]);
      case "prereqs.status":
        return Promise.resolve({ steps: [], recommendation: "" });
      case "diagnostics.get":
        return Promise.resolve({
          versions: {},
          paths: {},
          harnessAvailability: [],
          dbSizeBytes: 0,
          logDir: "C:/logs",
        });
      case "secrets.has":
        return Promise.resolve({ has: false, source: "none" });
      case "sessions.list":
        return Promise.resolve([]);
      default:
        return Promise.resolve({ ok: true });
    }
  });
  useAppStore.setState({ harnesses: [], sessions: [] });
});

function renderSection(sectionId: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings/${sectionId}`]}>
      <Routes>
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SettingsPage nav", () => {
  it("lists every settings section id from shell/settingsNav's SETTINGS_SECTIONS", () => {
    renderSection("general");
    for (const section of SETTINGS_SECTIONS) {
      expect(screen.getByTestId(`settings-nav-${section.id}`)).toBeInTheDocument();
    }
    // Also the reverse: no stray nav row not backed by the shared list.
    const rows = screen.getByTestId("settings-nav").querySelectorAll("[data-section-id]");
    expect(rows).toHaveLength(SETTINGS_SECTIONS.length);
  });

  it("marks the current route's nav row aria-current=page", () => {
    renderSection("appearance");
    expect(screen.getByTestId("settings-nav-appearance")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("settings-nav-general")).not.toHaveAttribute("aria-current");
  });

  it("defaults an unknown section to General", () => {
    renderSection("not-a-real-section");
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
  });

  it.each(SETTINGS_SECTIONS.map((s) => s.id))("renders a body for every section id: %s", async (id) => {
    renderSection(id);
    await waitFor(() => expect(screen.getByTestId("settings-body")).not.toBeEmptyDOMElement());
  });

  it("clicking a nav row navigates to that section's body", async () => {
    const user = userEvent.setup();
    renderSection("general");
    await screen.findByTestId("settings-general");

    await user.click(screen.getByTestId("settings-nav-mcp"));

    expect(await screen.findByTestId("settings-mcp")).toBeInTheDocument();
  });
});
