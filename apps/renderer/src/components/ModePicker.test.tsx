import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModePicker } from "./ModePicker";

describe("ModePicker (SPEC R10)", () => {
  it("marks the current mode as checked", () => {
    render(<ModePicker mode="round-table" onChange={vi.fn()} />);
    expect(screen.getByTestId("mode-picker-solo")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("mode-picker-round-table")).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the clicked mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModePicker mode="solo" onChange={onChange} />);

    await user.click(screen.getByTestId("mode-picker-round-table"));

    expect(onChange).toHaveBeenCalledWith("round-table");
  });

  it("does not call onChange when clicking the already-active mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModePicker mode="solo" onChange={onChange} />);

    await user.click(screen.getByTestId("mode-picker-solo"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables both options when disabled", () => {
    render(<ModePicker mode="solo" onChange={vi.fn()} disabled />);
    expect(screen.getByTestId("mode-picker-solo")).toBeDisabled();
    expect(screen.getByTestId("mode-picker-round-table")).toBeDisabled();
  });

  it("uses a custom testId prefix when given", () => {
    render(<ModePicker mode="solo" onChange={vi.fn()} testId="landing-mode-picker" />);
    expect(screen.getByTestId("landing-mode-picker")).toBeInTheDocument();
    expect(screen.getByTestId("landing-mode-picker-round-table")).toBeInTheDocument();
  });
});
