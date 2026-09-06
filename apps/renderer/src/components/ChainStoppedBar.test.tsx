import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChainStoppedBar } from "./ChainStoppedBar";

describe("ChainStoppedBar (ADR-0002, SPEC R11)", () => {
  it("names the hop count on a hop-cap stop", () => {
    render(<ChainStoppedBar hopCount={3} reason="hop_cap" busy={false} onContinue={vi.fn()} />);
    expect(screen.getByTestId("chain-stopped-bar")).toHaveTextContent("Chain stopped after 3 hops.");
  });

  it("uses the singular for exactly one hop", () => {
    render(<ChainStoppedBar hopCount={1} reason="hop_cap" busy={false} onContinue={vi.fn()} />);
    expect(screen.getByTestId("chain-stopped-bar")).toHaveTextContent("Chain stopped after 1 hop.");
  });

  it("names the error reason instead of a hop count", () => {
    render(<ChainStoppedBar hopCount={2} reason="error" busy={false} onContinue={vi.fn()} />);
    expect(screen.getByTestId("chain-stopped-bar")).toHaveTextContent(
      "The agent chain stopped after an error.",
    );
  });

  it("calls onContinue (chat.continue) when the button is clicked", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<ChainStoppedBar hopCount={3} reason="hop_cap" busy={false} onContinue={onContinue} />);

    await user.click(screen.getByTestId("chain-stopped-continue"));

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("disables Continue while another turn is busy", () => {
    render(<ChainStoppedBar hopCount={3} reason="hop_cap" busy onContinue={vi.fn()} />);
    expect(screen.getByTestId("chain-stopped-continue")).toBeDisabled();
  });
});
