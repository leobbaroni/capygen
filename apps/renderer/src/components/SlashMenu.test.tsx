/**
 * SlashMenu's own rendering (R14): section grouping and argument hints.
 * Keyboard navigation and the run-vs-insert decision live in `Composer` and
 * are tested there — this only covers what the popup itself renders.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SlashCommand } from "@capygen/shared";
import { SlashMenu } from "./SlashMenu";

function renderMenu(commands: SlashCommand[], highlightedIndex = 0) {
  return render(
    <SlashMenu
      commands={commands}
      highlightedIndex={highlightedIndex}
      onSelect={vi.fn()}
      onHover={vi.fn()}
    />,
  );
}

describe("SlashMenu", () => {
  it("groups commands into Built-ins / Skills / Plugins / Backend commands sections", () => {
    renderMenu([
      { name: "/compact", description: "", source: "builtin" },
      { name: "/deploy", description: "", source: "backend" },
      { name: "/cockpit:pilot", description: "", source: "plugin" },
      { name: "/review", description: "", source: "skill" },
    ]);
    const sections = screen.getAllByTestId("slash-menu-section");
    expect(sections).toHaveLength(4);
    // Display order is fixed regardless of input order: Built-ins, Skills,
    // Plugins, Backend commands.
    expect(sections[0]).toHaveTextContent("Built-ins");
    expect(sections[0]).toHaveTextContent("/compact");
    expect(sections[1]).toHaveTextContent("Skills");
    expect(sections[1]).toHaveTextContent("/review");
    expect(sections[2]).toHaveTextContent("Plugins");
    expect(sections[2]).toHaveTextContent("/cockpit:pilot");
    expect(sections[3]).toHaveTextContent("Backend commands");
    expect(sections[3]).toHaveTextContent("/deploy");
  });

  it("omits section headers entirely when every match is the same source", () => {
    renderMenu([
      { name: "/compact", description: "", source: "builtin" },
      { name: "/clear", description: "", source: "builtin" },
    ]);
    expect(screen.queryByText("Built-ins")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("slash-menu-item")).toHaveLength(2);
  });

  it("shows the argument hint next to a command that takes one", () => {
    renderMenu([{ name: "/model", description: "", source: "builtin", argumentHint: "<name> | default" }]);
    expect(screen.getByText("<name> | default")).toBeInTheDocument();
  });

  it("highlights the row at highlightedIndex, keyed to the flat commands order", () => {
    const commands: SlashCommand[] = [
      { name: "/compact", description: "", source: "builtin" },
      { name: "/deploy", description: "", source: "backend" },
    ];
    renderMenu(commands, 1);
    const items = screen.getAllByTestId("slash-menu-item");
    expect(items[0]).toHaveAttribute("aria-selected", "false");
    expect(items[1]).toHaveAttribute("aria-selected", "true");
  });

  it("shows a 'no matching commands' message when the list is empty", () => {
    renderMenu([]);
    expect(screen.getByTestId("slash-menu")).toHaveTextContent("No matching commands");
    expect(screen.queryByTestId("slash-menu-item")).not.toBeInTheDocument();
  });

  it("shows each command's description under its name", () => {
    renderMenu([{ name: "/compact", description: "Summarise the conversation", source: "builtin" }]);
    const item = within(screen.getByTestId("slash-menu")).getByTestId("slash-menu-item");
    expect(item).toHaveTextContent("Summarise the conversation");
  });
});
