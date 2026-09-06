import { render, screen, within } from "@testing-library/react";
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
  { name: "/model", description: "Switch model", source: "builtin", argumentHint: "<name> | default" },
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

  it("filters the slash menu as the user types", async () => {
    const user = userEvent.setup();
    renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/co");

    const items = screen.getAllByTestId("slash-menu-item");
    // "/compact" and "/context" match "/co"; "/clear" and "/model" do not.
    expect(items).toHaveLength(2);
  });

  it("runs an argument-less command immediately when clicked (R14)", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/co");
    await user.click(screen.getByText("/compact"));

    // /compact takes no argument — it goes straight through, the composer
    // clears, and the slash menu closes with it.
    expect(onSubmit).toHaveBeenCalledWith("/compact");
    expect(input).toHaveValue("");
    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();
  });

  it("inserts (does not run) a command that takes an argument, for editing", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/model");
    // Scoped to the menu: the textarea's own typed value is also "/model" at
    // this point, and `getByText` would otherwise find both.
    await user.click(within(screen.getByTestId("slash-menu")).getByText("/model"));

    // Inserted, not sent: `/model opus` and `/cockpit:pilot <task>` need their
    // argument typed after the command before it goes anywhere.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue("/model ");
    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();

    await user.type(input, "opus{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("/model opus");
  });

  it("Enter on a highlighted argument-less command runs it immediately (R14)", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/compact{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("/compact");
    expect(input).toHaveValue("");
  });

  it("matches a namespaced command on a substring, not just its prefix", async () => {
    const user = userEvent.setup();
    renderComposer({
      commands: [
        ...COMMANDS,
        { name: "/cockpit:pilot", description: "Phase pilot", source: "plugin" },
      ],
    });

    await user.type(screen.getByTestId("composer-input"), "/pilot");

    const items = screen.getAllByTestId("slash-menu-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("/cockpit:pilot");
  });

  it("dismisses the slash menu on Escape and reopens it as the query changes", async () => {
    const user = userEvent.setup();
    renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "/co");
    expect(screen.getByTestId("slash-menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();

    await user.type(input, "n");
    expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
  });

  it("restores the draft and shows the error when the send fails", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("unknown session"));
    render(
      <MemoryRouter>
        <Composer onSubmit={onSubmit} testId="composer" />
      </MemoryRouter>,
    );
    const input = screen.getByTestId("composer-input");

    await user.type(input, "keep me{Enter}");

    expect(onSubmit).toHaveBeenCalledWith("keep me");
    expect(input).toHaveValue("keep me");
    expect(screen.getByTestId("composer-error")).toHaveTextContent("unknown session");
  });

  it("renders the slash menu outside the clipping wrapper, as a child of the form", async () => {
    const user = userEvent.setup();
    renderComposer({ commands: COMMANDS });

    await user.type(screen.getByTestId("composer-input"), "/co");

    // The textarea wrapper is `overflow-hidden`, and the menu sits above the
    // composer — inside it, the popup is clipped away entirely.
    const menu = screen.getByTestId("slash-menu");
    expect(menu.parentElement).toBe(screen.getByTestId("composer"));
  });

  it("does not open the slash menu for text that merely contains a slash", async () => {
    const user = userEvent.setup();
    renderComposer({ commands: COMMANDS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "see docs/readme");

    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();
  });
});

describe("the harness/model picker (SPEC item 5)", () => {
  const HARNESSES = [
    {
      backend: "claude" as const,
      label: "Claude Code",
      available: true,
      models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
      defaultModel: "claude-sonnet-5",
    },
    {
      backend: "codex" as const,
      label: "Codex",
      available: true,
      models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      defaultModel: "gpt-5.5",
    },
    {
      backend: "api" as const,
      label: "API model",
      available: false,
      reason: "no API key stored — add one in Settings ▸ API keys",
      models: [],
      defaultModel: "",
    },
  ];

  it("keeps every backend pickable on the landing, even after a choice", async () => {
    const user = userEvent.setup();
    // The landing passes `agent` only to label the button; without
    // `lockBackend` a first pick used to hide every other backend for good.
    renderComposer({ harnesses: HARNESSES, agent: { backend: "codex", model: "gpt-5.5" } });
    await user.click(screen.getByTestId("composer-agent-picker"));
    const labels = screen.getAllByTestId("composer-agent-option").map((b) => b.textContent);
    expect(labels).toEqual(["Claude Code — Claude Sonnet 5", "Codex — GPT-5.5"]);
  });

  it("narrows to the agent's own backend once a session exists", async () => {
    const user = userEvent.setup();
    renderComposer({
      harnesses: HARNESSES,
      agent: { backend: "codex", model: "gpt-5.5" },
      lockBackend: true,
    });
    await user.click(screen.getByTestId("composer-agent-picker"));
    expect(screen.getAllByTestId("composer-agent-option").map((b) => b.textContent)).toEqual([
      "GPT-5.5",
    ]);
  });

  it("shows an unavailable backend's reason instead of dropping the row", async () => {
    const user = userEvent.setup();
    renderComposer({ harnesses: HARNESSES });
    await user.click(screen.getByTestId("composer-agent-picker"));
    const row = screen.getByTestId("composer-agent-unavailable");
    expect(row).toHaveTextContent("API model");
    expect(row).toHaveTextContent("no API key stored");
  });

  it("names the model it will actually use, never just a backend", () => {
    renderComposer({ harnesses: HARNESSES, agent: { backend: "codex", model: "gpt-5.5" } });
    expect(screen.getByTestId("composer-agent-picker")).toHaveTextContent("Codex · gpt-5.5");
    // With nothing chosen it says so rather than naming a backend the session
    // would not actually run on.
    renderComposer({ harnesses: HARNESSES, testId: "composer2" });
    expect(screen.getByTestId("composer2-agent-picker")).toHaveTextContent("Choose model");
  });
});
