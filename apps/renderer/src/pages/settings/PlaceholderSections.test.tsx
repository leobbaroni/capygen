/**
 * Every ported-but-deferred section: renders, names its phase (or its
 * capygen redirect), and offers no dead control (no button/input/select).
 */
import { UpdatesSection as LiveUpdatesSection } from "./UpdatesSection";
import type { ReactElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSection,
  LegacyIntegrationsSection,
  LocalCliSection,
  UpdatesSection,
} from "./PlaceholderSections";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }), hasBridge: () => true }));
beforeEach(() => { invoke.mockReset(); invoke.mockImplementation((channel) => Promise.resolve(channel === "harness.list" ? [] : { ok: false, started: false })); });

function renderWithRouter(node: ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("PlaceholderSections", () => {
  it("keeps the updates section wired to the live update controls", () => {
    expect(UpdatesSection).toBe(LiveUpdatesSection);
  });

  it("Account explains capygen has no cloud login and links to Harnesses / API keys", () => {
    renderWithRouter(<AccountSection />);
    const root = screen.getByTestId("settings-account");
    expect(root).toHaveTextContent(/no cloud account/i);
    expect(screen.getByRole("link", { name: "Harnesses" })).toHaveAttribute("href", "/settings/harnesses");
    expect(screen.getByRole("link", { name: /Providers/ })).toHaveAttribute("href", "/settings/api-keys");
  });

  it("legacy Integrations redirects to MCP/Skills/Plugins/Tools", () => {
    renderWithRouter(<LegacyIntegrationsSection />);
    expect(screen.getByRole("link", { name: "MCP servers" })).toHaveAttribute("href", "/settings/mcp");
    expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute("href", "/settings/skills");
    expect(screen.getByRole("link", { name: "Plugins" })).toHaveAttribute("href", "/settings/plugins");
    expect(screen.getByRole("link", { name: "Tools" })).toHaveAttribute("href", "/settings/tools");
  });

  it("Local CLI redirects to Prerequisites and Harnesses", () => {
    renderWithRouter(<LocalCliSection />);
    expect(screen.getByRole("link", { name: "Prerequisites" })).toHaveAttribute("href", "/settings/prereqs");
    expect(screen.getByRole("link", { name: "Harnesses" })).toHaveAttribute("href", "/settings/harnesses");
  });
});

it("runs the chosen native login only on click and reports a launch that did not start", async () => {
  renderWithRouter(<AccountSection />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("harness.list", {}));
  expect(invoke).not.toHaveBeenCalledWith("prereqs.run", expect.anything());
  fireEvent.click(screen.getAllByRole("button", { name: "Sign in / reconnect" })[1]!);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("prereqs.run", { stepId: "codex-login" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Codex sign-in did not start");
});
