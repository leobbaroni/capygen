import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { SlashCommand } from "@capygen/shared";
import { Composer } from "./Composer";

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const onSubmit = vi.fn();
  render(
    <MemoryRouter>
      <Composer onSubmit={onSubmit} testId="composer" {...props} />
    </MemoryRouter>,
  );
  return { onSubmit };
}

const COMMANDS: SlashCommand[] = [
  { name: "/compact", description: "Summarise the conversation", source: "builtin" },
  { name: "/context", description: "Show context", source: "builtin" },
  { name: "/clear", description: "Start fresh", source: "builtin" },
];

describe("Composer", () => {
  it("submits on Enter and clears the input", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer();
    const input = screen.getByTestId("composer-input");

    await user.type(input, "hello there{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello there");
    expect(input).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter instead of submitting", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer();
    const input = screen.getByTestId("composer-input");

    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue("line one\nline two");
  });

  it("does not submit empty or whitespace-only text", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer();
    const input = screen.getByTestId("composer-input");
    const send = screen.getByTestId("composer-send");

    expect(send).toBeDisabled();

    await user.type(input, "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits via the send button", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer();
    const input = screen.getByTestId("composer-input");

    await user.type(input, "ship it");
    await user.click(screen.getByTestId("composer-send"));

    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("shows the stop button and hides send while busy", () => {
    renderComposer({ busy: true });
    expect(screen.getByTestId("composer-stop")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
  });

  it("filters the slash menu as the user types and sends the selected command", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/co");

    const items = screen.getAllByTestId("slash-menu-item");
    // "/compact" and "/context" match "/co"; "/clear" does not.
    expect(items).toHaveLength(2);

    await user.click(screen.getByText("/compact"));

    expect(onSubmit).toHaveBeenCalledWith("/compact");
    expect(input).toHaveValue("");
  });

  it("does not open the slash menu for text that merely contains a slash", async () => {
    const user = userEvent.setup();
    renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "see docs/readme");

    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();
  });
});
