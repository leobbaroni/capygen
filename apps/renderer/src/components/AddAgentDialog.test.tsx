import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { AddAgentDialog } from "./AddAgentDialog";

const HARNESSES: HarnessInfo[] = [
  {
    backend: "claude",
    label: "Claude Code",
    available: true,
    models: [
      { id: "claude-opus-4-5", label: "Opus 4.5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
    ],
    defaultModel: "claude-opus-4-5",
  },
  {
    backend: "codex",
    label: "Codex",
    available: true,
    models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
    defaultModel: "gpt-5.5",
  },
];

const initialAddAgent = useAppStore.getState().addAgent;

afterEach(() => {
  useAppStore.setState({ addAgent: initialAddAgent });
});

describe("AddAgentDialog — draft mode (New Session landing)", () => {
  it("requires a display name before it can be added", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={HARNESSES}
        existingMentionNames={[]}
        onAdd={onAdd}
      />,
    );

    await user.click(screen.getByTestId("add-agent-submit"));

    expect(screen.getByTestId("add-agent-error")).toHaveTextContent("display name");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("auto-derives the mention name from the display name until edited", async () => {
    const user = userEvent.setup();
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={HARNESSES}
        existingMentionNames={[]}
        onAdd={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Code Reviewer");

    expect(screen.getByTestId("add-agent-mention-input")).toHaveValue("code-reviewer");
  });

  it("rejects a mention name that is already used in this session (unique mention names)", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={HARNESSES}
        existingMentionNames={["codex"]}
        onAdd={onAdd}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Codex");
    // Auto-derived mention name is also "codex" — already taken.
    await user.click(screen.getByTestId("add-agent-submit"));

    expect(screen.getByTestId("add-agent-error")).toHaveTextContent("already used");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("rejects a mention name with characters MentionNameSchema forbids", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={HARNESSES}
        existingMentionNames={[]}
        onAdd={onAdd}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Reviewer");
    const mentionInput = screen.getByTestId("add-agent-mention-input");
    await user.clear(mentionInput);
    await user.type(mentionInput, "Not Valid!");

    await user.click(screen.getByTestId("add-agent-submit"));

    expect(screen.getByTestId("add-agent-error")).toHaveTextContent("lowercase");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("submits a complete AgentDraft with the chosen backend/model/role and closes", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={onOpenChange}
        harnesses={HARNESSES}
        existingMentionNames={[]}
        defaultLead
        onAdd={onAdd}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Reviewer");
    await user.selectOptions(screen.getByTestId("add-agent-backend"), "codex");
    await user.click(screen.getByTestId("add-agent-submit"));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const draft = onAdd.mock.calls[0]?.[0];
    expect(draft).toMatchObject({
      displayName: "Reviewer",
      mentionName: "reviewer",
      backend: "codex",
      model: "gpt-5.5",
      role: "lead",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a message instead of the form when no backend is available", () => {
    render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={[]}
        existingMentionNames={[]}
        onAdd={vi.fn()}
      />,
    );

    expect(screen.getByTestId("add-agent-empty")).toBeInTheDocument();
    expect(screen.getByTestId("add-agent-submit")).toBeDisabled();
  });
});

describe("AddAgentDialog — live mode (an open round-table session)", () => {
  it("calls the store's addAgent and closes on success", async () => {
    const user = userEvent.setup();
    const addAgent = vi.fn().mockResolvedValue({
      id: "new-agent",
      sessionId: "s1",
      name: "Reviewer",
      displayName: "Reviewer",
      mentionName: "reviewer",
      backend: "claude",
      model: "claude-opus-4-5",
      role: "member",
      order: 1,
      config: null,
      createdAt: 0,
    });
    useAppStore.setState({ addAgent });
    const onOpenChange = vi.fn();

    render(
      <AddAgentDialog
        mode="live"
        sessionId="s1"
        open
        onOpenChange={onOpenChange}
        harnesses={HARNESSES}
        existingMentionNames={["capy"]}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Reviewer");
    await user.click(screen.getByTestId("add-agent-submit"));

    expect(addAgent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ displayName: "Reviewer", mentionName: "reviewer" }),
    );
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("shows the store's error instead of closing when addAgent rejects", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ addAgent: vi.fn().mockRejectedValue(new Error("mention name taken")) });
    const onOpenChange = vi.fn();

    render(
      <AddAgentDialog
        mode="live"
        sessionId="s1"
        open
        onOpenChange={onOpenChange}
        harnesses={HARNESSES}
        existingMentionNames={[]}
      />,
    );

    await user.type(screen.getByTestId("add-agent-name-input"), "Reviewer");
    await user.click(screen.getByTestId("add-agent-submit"));

    expect(await screen.findByTestId("add-agent-error")).toHaveTextContent("mention name taken");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("AddAgentDialog — seeding (first open after launch)", () => {
  it("fills in backend and model when harness.list lands after mount", async () => {
    // `harness.list` is deliberately un-awaited by the bootstrap (G1), so the
    // dialog mounts with an empty list. It used to seed once, at mount, and
    // never again: the first open showed a backend it did not hold and a Model
    // select with no options at all, and Add refused with "Choose a backend."
    const onAdd = vi.fn();
    const { rerender } = render(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={[]}
        existingMentionNames={[]}
        onAdd={onAdd}
      />,
    );
    rerender(
      <AddAgentDialog
        mode="draft"
        open
        onOpenChange={vi.fn()}
        harnesses={HARNESSES}
        existingMentionNames={[]}
        onAdd={onAdd}
      />,
    );

    expect(screen.getByTestId("add-agent-backend")).toHaveValue("claude");
    expect(screen.getByTestId("add-agent-model")).toHaveValue("claude-opus-4-5");

    const user = userEvent.setup();
    await user.type(screen.getByTestId("add-agent-name-input"), "Reviewer");
    await user.click(screen.getByTestId("add-agent-submit"));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "claude", model: "claude-opus-4-5" }),
    );
  });

  it("re-reads defaultLead when it is shown, so the second agent does not steal the crown", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const props = {
      mode: "draft" as const,
      harnesses: HARNESSES,
      existingMentionNames: [],
      onAdd,
    };
    // First add: the roster is empty, so this one is the lead.
    const { rerender } = render(
      <AddAgentDialog {...props} open onOpenChange={vi.fn()} defaultLead />,
    );
    await user.type(screen.getByTestId("add-agent-name-input"), "Alice");
    await user.click(screen.getByTestId("add-agent-submit"));
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ role: "lead" }));

    // Closed, then reopened with a roster that now has a lead.
    rerender(<AddAgentDialog {...props} open={false} onOpenChange={vi.fn()} defaultLead={false} />);
    rerender(<AddAgentDialog {...props} open onOpenChange={vi.fn()} defaultLead={false} />);
    expect(screen.getByTestId("add-agent-lead")).not.toBeChecked();

    await user.type(screen.getByTestId("add-agent-name-input"), "Bob");
    await user.click(screen.getByTestId("add-agent-submit"));
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ role: "member" }));
  });

  it("uses catalogue efforts and saves backend config without manual routing", async () => {
    const user = userEvent.setup(); const onAdd = vi.fn();
    const harnesses = HARNESSES.map(h => ({ ...h, models: h.models.map(m => ({ ...m, efforts: ["low", "high"] })) }));
    render(<AddAgentDialog mode="draft" open onOpenChange={vi.fn()} harnesses={harnesses} existingMentionNames={[]} onAdd={onAdd} />);
    expect(screen.queryByTestId("add-agent-routing-backend")).toBeNull();
    await user.type(screen.getByTestId("add-agent-name-input"), "Alice");
    await user.selectOptions(screen.getByTestId("add-agent-effort"), "high");
    await user.click(screen.getByTestId("add-agent-submit"));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ config: { claude: { effort: "high" } } }));
  });
});
