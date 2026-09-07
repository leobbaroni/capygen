/**
 * Every ported-but-deferred section: renders, names its phase (or its
 * capygen redirect), and offers no dead control (no button/input/select).
 */
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  AccountSection,
  LegacyIntegrationsSection,
  LocalCliSection,
  MembersSection,
  PoliciesSection,
  SharingSection,
  UpdatesSection,
} from "./PlaceholderSections";

function renderWithRouter(node: ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("PlaceholderSections", () => {
  it.each([
    ["settings-updates", UpdatesSection, "Phase 12"],
    ["settings-members", MembersSection, "Phase 9"],
    ["settings-policies", PoliciesSection, "Phase 9"],
    ["settings-sharing", SharingSection, "Phase 9"],
  ] as const)("%s names its arriving phase and has no dead controls", (testId, Section, phase) => {
    renderWithRouter(<Section />);
    const root = screen.getByTestId(testId);
    expect(root).toHaveTextContent(phase);
    expect(root.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
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
