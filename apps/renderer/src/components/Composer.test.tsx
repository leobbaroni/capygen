import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, SlashCommand } from "@capygen/shared";
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
    expect(screen.getByTestId("composer-agent-picker")).toHaveTextContent("Codex · GPT-5.5");
    // With nothing chosen it says so rather than naming a backend the session
    // would not actually run on.
    renderComposer({ harnesses: HARNESSES, testId: "composer2" });
    expect(screen.getByTestId("composer2-agent-picker")).toHaveTextContent("Choose model");
  });
});

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a-codex",
    sessionId: "s1",
    name: "codex",
    displayName: "Codex",
    mentionName: "codex",
    backend: "codex",
    model: "gpt-5.5",
    role: "member",
    order: 0,
    config: null,
    createdAt: 0,
    ...overrides,
  };
}

const AGENTS: Agent[] = [
  agent({ id: "a-codex", mentionName: "codex", displayName: "Codex", order: 0 }),
  agent({
    id: "a-capy",
    mentionName: "capy",
    displayName: "Capy",
    backend: "claude",
    model: "claude-opus-4-5",
    order: 1,
  }),
];

describe("@mention autocomplete (SPEC item B2.2)", () => {
  it("opens on '@' and lists the session agents", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });

    await user.type(screen.getByTestId("composer-input"), "@");

    const items = screen.getAllByTestId("mention-menu-item");
    expect(items).toHaveLength(2);
  });

  it("never opens when no agents are passed (solo composer)", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByTestId("composer-input"), "hey @anyone");

    expect(screen.queryByTestId("mention-menu")).not.toBeInTheDocument();
  });

  it("filters by mention name as the user types", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });

    await user.type(screen.getByTestId("composer-input"), "@cap");

    const items = screen.getAllByTestId("mention-menu-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("@capy");
  });

  it("inserts the mention plus a trailing space on Enter and closes the menu", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer({ agents: AGENTS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "@cod{Enter}");

    expect(input).toHaveValue("@codex ");
    expect(screen.queryByTestId("mention-menu")).not.toBeInTheDocument();
    // Enter selected the mention, not the message — nothing was sent yet.
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(input, "review this{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("@codex review this");
  });

  it("inserts the mention on Tab as well as Enter", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "@cod");
    await user.keyboard("{Tab}");

    expect(input).toHaveValue("@codex ");
  });

  it("inserts the highlighted (arrow-key-moved) agent, not always the first", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "@");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(input).toHaveValue("@capy ");
  });

  it("selecting a mention by click inserts it too", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "@ca");
    await user.click(screen.getByText("@capy"));

    expect(input).toHaveValue("@capy ");
  });

  it("does not interfere with the slash menu when the message starts with '/'", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS, commands: COMMANDS });

    await user.type(screen.getByTestId("composer-input"), "/co");

    expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("mention-menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and reopens as the query changes, like the slash menu", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });
    const input = screen.getByTestId("composer-input");

    await user.type(input, "@co");
    expect(screen.getByTestId("mention-menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("mention-menu")).not.toBeInTheDocument();

    await user.type(input, "d");
    expect(screen.getByTestId("mention-menu")).toBeInTheDocument();
  });

  it("does not treat an email-shaped @ (no leading space) as a mention trigger", async () => {
    const user = userEvent.setup();
    renderComposer({ agents: AGENTS });

    await user.type(screen.getByTestId("composer-input"), "ping bob@codex");

    expect(screen.queryByTestId("mention-menu")).not.toBeInTheDocument();
  });
});

/** The smallest real PNG: an 8-byte signature is all `sniffImageMediaType` reads. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
function pngFile(name: string): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}
// jsdom has no object URLs; the chip preview only needs a string.
let created = 0;
let revoked: string[] = [];
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: () => `blob:preview-${(created += 1)}`,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (url: string) => revoked.push(url),
    writable: true,
  });
});
beforeEach(() => {
  created = 0;
  revoked = [];
});

describe("Composer completion and text attachments", () => {
  it("Tab completes the highlighted slash command without sending", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer({ commands: COMMANDS });
    await user.type(screen.getByTestId("composer-input"), "/co{ArrowDown}{Tab}");
    expect(screen.getByTestId("composer-input")).toHaveValue("/context ");
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("clicking a skill inserts it into the draft without sending", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer({ commands: [{ name: "/review", source: "skill", description: "Review changes" }] });
    await user.type(screen.getByTestId("composer-input"), "/rev");
    await user.click(screen.getByTestId("slash-menu-item"));
    expect(screen.getByTestId("composer-input")).toHaveValue("/review ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-draft-highlight")).toHaveTextContent("/review");
    expect(screen.queryByLabelText("Dictation language")).not.toBeInTheDocument();
  });
  it("enables text attachment selection and sends the selected file contents", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    expect(screen.getByTestId("composer-attach")).toBeEnabled();
    await user.upload(screen.getByTestId("composer-file-input"), new File(["const answer = 42;"], "answer.ts", { type: "text/plain" }));
    await screen.findByRole("button", { name: "Remove answer.ts" });
    await user.click(screen.getByTestId("composer-send"));
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('"content": "const answer = 42;"'));
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('"name": "answer.ts"'));
  });
  it("refuses an unsupported binary visibly without creating a misleading attachment", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    await user.upload(screen.getByTestId("composer-file-input"), new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "spec.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("binary attachments are not supported");
    expect(screen.queryByRole("button", { name: "Remove spec.pdf" })).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("refuses a file whose bytes are not the image type it claims", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    await user.upload(screen.getByTestId("composer-file-input"), new File([new Uint8Array([0, 1, 2])], "image.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a valid image/png file");
    expect(screen.queryByRole("button", { name: "Remove image.png" })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("attaches a real PNG and sends it as an image, not as text", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    await user.upload(screen.getByTestId("composer-file-input"), pngFile("shot.png"));
    await screen.findByRole("button", { name: "Remove shot.png" });
    await user.type(screen.getByTestId("composer-input"), "what is this?");
    await user.click(screen.getByTestId("composer-send"));
    expect(onSubmit).toHaveBeenCalledWith("what is this?", [
      { name: "shot.png", mediaType: "image/png", size: PNG_BYTES.length, data: PNG_BASE64 },
    ]);
    // The picture is an attachment, never prose: nothing base64-shaped is in the text.
    expect(String(onSubmit.mock.calls[0]![0])).not.toContain(PNG_BASE64);
  });
  it("frees the previews it made when another file in the same batch is refused", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    await user.upload(screen.getByTestId("composer-file-input"), [
      pngFile("good.png"),
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "spec.pdf", { type: "application/pdf" }),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent("binary attachments are not supported");
    // Nothing half-attached, and no object URL left behind for the picture that
    // did load before its sibling was refused.
    expect(screen.queryByRole("button", { name: "Remove good.png" })).not.toBeInTheDocument();
    expect(revoked).toHaveLength(created);
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("releases an attached preview when the composer unmounts", async () => {
    const user = userEvent.setup(); const view = render(<Composer onSubmit={vi.fn()} testId="composer" />);
    await user.upload(screen.getByTestId("composer-file-input"), pngFile("keep.png"));
    await screen.findByRole("button", { name: "Remove keep.png" });
    expect(revoked).toHaveLength(0);
    view.unmount();
    expect(revoked).toHaveLength(created);
  });
  it("can send an image with no message text at all", async () => {
    const user = userEvent.setup(); const { onSubmit } = renderComposer();
    await user.upload(screen.getByTestId("composer-file-input"), pngFile("only.png"));
    await screen.findByRole("button", { name: "Remove only.png" });
    expect(screen.getByTestId("composer-send")).toBeEnabled();
    await user.click(screen.getByTestId("composer-send"));
    expect(onSubmit).toHaveBeenCalledWith("", [expect.objectContaining({ name: "only.png" })]);
  });
});

it("uses catalogue labels and offers API effort independently of model commands", async () => {
  const user = userEvent.setup(); const onPickAgent = vi.fn();
  renderComposer({ agent: { backend: "api", model: "provider/model-id" }, canPickModel: false, onPickAgent,
    harnesses: [{ backend: "api", available: true, models: [{ id: "provider/model-id", label: "Actual model name", efforts: ["low", "high"] }], defaultModel: "provider/model-id" }] as never });
  expect(screen.getByTestId("composer-agent-picker")).toHaveTextContent("Actual model name");
  await user.selectOptions(screen.getByLabelText("Model effort"), "high");
  expect(onPickAgent).toHaveBeenCalledWith({ backend: "api", model: "provider/model-id", effort: "high" });
});
