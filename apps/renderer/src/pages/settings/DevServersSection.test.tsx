/**
 * [review] The old cases here asserted that two controls persisted a
 * `localStorage` key — which they did, and which nothing in the app ever read
 * (`DevServerService.detect` is unconditional). Testing that a dead control
 * remembers its own dead value is worse than no test, so the section now says
 * what the app actually does and this asserts exactly that: the note is there,
 * and there is no control pretending to change behaviour.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DevServersSection } from "./DevServersSection";

function renderSection(): void {
  render(
    <MemoryRouter>
      <DevServersSection />
    </MemoryRouter>,
  );
}

describe("DevServersSection", () => {
  it("says the defaults are not configurable yet instead of offering dead controls", () => {
    renderSection();
    expect(screen.getByTestId("arrives-later-note")).toBeInTheDocument();
    expect(screen.getByTestId("settings-dev-servers")).toHaveTextContent(/what capygen does today/i);
    expect(screen.queryByTestId("toggle-auto-detect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-browser-behavior")).not.toBeInTheDocument();
  });

  it("writes nothing to localStorage", () => {
    renderSection();
    expect(window.localStorage.getItem("capygen:settings:devServers")).toBeNull();
  });
});
