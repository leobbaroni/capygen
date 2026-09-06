import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DevServersSection } from "./DevServersSection";

afterEach(() => {
  window.localStorage.clear();
});

describe("DevServersSection", () => {
  it("defaults to auto-detect on and 'Open it automatically'", () => {
    render(<DevServersSection />);
    expect(screen.getByTestId("toggle-auto-detect")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("select-browser-behavior")).toHaveValue("auto-open");
  });

  it("persists a toggle to localStorage and reflects it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DevServersSection />);
    await user.click(screen.getByTestId("toggle-auto-detect"));
    expect(screen.getByTestId("toggle-auto-detect")).toHaveAttribute("aria-checked", "false");
    unmount();

    render(<DevServersSection />);
    expect(screen.getByTestId("toggle-auto-detect")).toHaveAttribute("aria-checked", "false");
    expect(JSON.parse(window.localStorage.getItem("capygen:settings:devServers")!)).toMatchObject({
      autoDetect: false,
    });
  });

  it("changes browser behaviour", async () => {
    const user = userEvent.setup();
    render(<DevServersSection />);
    await user.selectOptions(screen.getByTestId("select-browser-behavior"), "manual");
    expect(screen.getByTestId("select-browser-behavior")).toHaveValue("manual");
  });
});
