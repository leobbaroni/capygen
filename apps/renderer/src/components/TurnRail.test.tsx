/**
 * The rail's dots are buttons, not anchors.
 *
 * The shell runs under a HashRouter, where `#turn-<id>` is a *route*: an
 * `<a href="#turn-…">` navigated the app out of the open session to the
 * landing page (`<Route path="*">` → `/`) instead of scrolling the transcript.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Turn } from "@capygen/shared";
import { TurnRail } from "./TurnRail";

const turn = (id: string, over: Partial<Turn> = {}): Turn => ({
  id,
  sessionId: "session-1",
  agentId: null,
  role: "agent",
  status: "done",
  parentTurnId: null,
  hopIndex: 0,
  createdAt: 1,
  ...over,
});

describe("TurnRail", () => {
  it("renders no rail without turns", () => {
    render(<TurnRail turns={[]} />);
    expect(screen.queryByTestId("turn-rail")).not.toBeInTheDocument();
  });

  it("scrolls the turn into view instead of navigating", async () => {
    const user = userEvent.setup();
    render(<TurnRail turns={[turn("t1"), turn("t2", { role: "user" })]} />);

    const anchor = document.createElement("div");
    anchor.id = "turn-t2";
    const scrollIntoView = vi.fn();
    anchor.scrollIntoView = scrollIntoView;
    document.body.appendChild(anchor);

    const dots = screen.getAllByTestId("turn-rail-dot");
    expect(dots).toHaveLength(2);
    // No href anywhere on the rail: a hash link is a route under HashRouter.
    for (const dot of dots) {
      expect(dot.tagName).toBe("BUTTON");
      expect(dot).not.toHaveAttribute("href");
    }

    await user.click(dots[1]!);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    anchor.remove();
  });
});
