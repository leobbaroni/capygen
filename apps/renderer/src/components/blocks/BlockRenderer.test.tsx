/**
 * One test per block kind (SPEC R6): the fixture round-trips through
 * `BlockRenderer` and lands the `data-testid="block-<kind>"` card the rest
 * of the app (and the e2e suite) keys off. Interactive cards (permission,
 * question) also exercise the click → store-action wiring.
 */
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Block,
  DiffBlock,
  ElicitationBlock,
  ErrorBlock,
  PermissionBlock,
  QuestionBlock,
  SubagentBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  UsageBlock,
  UsageEvent,
} from "@capygen/shared";
import { BlockRenderer } from "./BlockRenderer";
import { useAppStore } from "@/store/appStore";

// `ToolCallCard`'s outputRef fetch (R25) is the only thing in this file that
// touches the real IPC bridge — everything else (permission/question/
// elicitation) goes through a mocked store action instead. Mocking it here
// keeps that one path testable without every other test having to care.
const ipcInvoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke: ipcInvoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const base = {
  turnId: "turn-1",
  sessionId: "session-1",
  index: 0,
  createdAt: 1,
  updatedAt: 1,
};

function renderBlock(block: Block, isUser = false) {
  // A local-policy card links to its owning restriction's editor, so the tree
  // needs a router; every other block renders identically inside one.
  return render(
    <MemoryRouter>
      <BlockRenderer block={block} isUser={isUser} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  ipcInvoke.mockReset();
  useAppStore.setState({ staleRequests: [], usageEvents: [], blocks: {} });
});

describe("BlockRenderer", () => {
  it("renders a text block's text", () => {
    const block: TextBlock = { ...base, id: "b1", kind: "text", text: "hello world" };
    renderBlock(block);
    expect(screen.getByTestId("block-text")).toHaveTextContent("hello world");
  });

  it("renders a thinking block collapsed by default", async () => {
    const user = userEvent.setup();
    const block: ThinkingBlock = { ...base, id: "b2", kind: "thinking", text: "pondering…" };
    renderBlock(block);
    const card = screen.getByTestId("block-thinking");
    expect(card).not.toHaveTextContent("pondering…");
    await user.click(screen.getByText("Thinking"));
    expect(card).toHaveTextContent("pondering…");
  });

  it("renders a tool_call block with its name and expands to show input/output", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "b3",
      kind: "tool_call",
      name: "sys_os_read",
      input: { path: "README.md" },
      output: "# capygen",
      status: "success",
    };
    renderBlock(block);
    const card = screen.getByTestId("block-tool-call");
    expect(card).toHaveTextContent("sys_os_read");
    expect(card).not.toHaveTextContent("# capygen");
    await user.click(screen.getByText("sys_os_read"));
    expect(card).toHaveTextContent("# capygen");
    expect(card).toHaveTextContent("README.md");
  });

  it("renders a diff block's path and +/- counts", () => {
    const block: DiffBlock = {
      ...base,
      id: "b4",
      kind: "diff",
      path: "src/index.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
    };
    renderBlock(block);
    const card = screen.getByTestId("block-diff");
    expect(card).toHaveTextContent("src/index.ts");
    expect(card).toHaveTextContent("+1");
    expect(card).toHaveTextContent("−1");
  });

  it("renders a pending permission block and answers allow through the store", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    const block: PermissionBlock = {
      ...base,
      id: "b5",
      kind: "permission",
      request: { requestId: "req-1", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
      decision: null,
    };
    renderBlock(block);
    expect(screen.getByTestId("block-permission")).toHaveAttribute("data-state", "pending");
    await user.click(screen.getByTestId("block-permission-allow"));
    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow");
  });

  it("renders a responded permission block without action buttons", () => {
    const block: PermissionBlock = {
      ...base,
      id: "b5b",
      kind: "permission",
      request: { requestId: "req-1", toolName: "Bash", input: {}, suggestions: [] },
      decision: { behavior: "deny", scope: "once", decidedAt: 2 },
    };
    renderBlock(block);
    const card = screen.getByTestId("block-permission");
    expect(card).toHaveAttribute("data-state", "responded");
    expect(screen.queryByTestId("block-permission-allow")).not.toBeInTheDocument();
  });

  it("renders a question block, gates submit until answered, and posts through the store", async () => {
    const user = userEvent.setup();
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerQuestion });
    const block: QuestionBlock = {
      ...base,
      id: "b6",
      kind: "question",
      requestId: "req-2",
      questions: [
        {
          question: "Which framework?",
          multiSelect: false,
          options: [{ label: "React" }, { label: "Vue" }],
        },
      ],
      answers: null,
    };
    renderBlock(block);
    expect(screen.getByTestId("block-question-submit")).toBeDisabled();
    await user.click(screen.getByText("React"));
    expect(screen.getByTestId("block-question-submit")).toBeEnabled();
    await user.click(screen.getByTestId("block-question-submit"));
    expect(answerQuestion).toHaveBeenCalledWith("req-2", { "Which framework?": "React" });
  });

  it("renders a subagent block's name and status", () => {
    const block: SubagentBlock = {
      ...base,
      id: "b7",
      kind: "subagent",
      agentId: null,
      name: "reviewer",
      backend: "claude",
      model: "claude-opus-4-5",
      description: "Reviews the diff",
      status: "running",
    };
    renderBlock(block);
    expect(screen.getByTestId("block-subagent")).toHaveTextContent("reviewer");
    expect(screen.getByTestId("block-subagent")).toHaveTextContent("running");
  });

  it("shows the routed model, the routing marker and the cost (SPEC R12/R23)", () => {
    // Without these three an unrouted spawn and one capygen re-homed onto
    // another model render byte-identically, and the only surface that told
    // them apart was a pane ChatPage opens closed.
    const block: SubagentBlock = {
      ...base,
      id: "b7r",
      kind: "subagent",
      agentId: null,
      name: "reviewer",
      backend: "codex",
      model: "gpt-5.5",
      description: "",
      status: "done",
      delegated: true,
      costUsd: 0.0053,
    };
    renderBlock(block);
    const card = screen.getByTestId("block-subagent");
    expect(within(card).getByTestId("block-subagent-model")).toHaveTextContent("gpt-5.5");
    expect(within(card).getByTestId("block-subagent-routed")).toBeInTheDocument();
    expect(within(card).getByTestId("block-subagent-cost")).toHaveTextContent("$0.0053");
  });

  it("renders an error block's message", () => {
    const block: ErrorBlock = { ...base, id: "b8", kind: "error", message: "boom" };
    renderBlock(block);
    expect(screen.getByTestId("block-error")).toHaveTextContent("boom");
  });

  it("expands a truncated tool output back to the whole value (R25)", async () => {
    const user = userEvent.setup();
    const whole = `${"x".repeat(64)}TAIL`;
    const block: ToolCallBlock = {
      ...base,
      id: "b3t",
      kind: "tool_call",
      name: "Read",
      input: { path: "big.txt" },
      output: `${"x".repeat(64)}
… 4 more characters`,
      truncated: true,
      fullOutput: whole,
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("Read"));
    const card = screen.getByTestId("block-tool-call");
    expect(card).toHaveTextContent("truncated");
    expect(card).not.toHaveTextContent("TAIL");
    await user.click(screen.getByTestId("tool-output-expand"));
    expect(card).toHaveTextContent("TAIL");
  });

  it("says a permission answer went nowhere instead of showing it as decided", () => {
    useAppStore.setState({ staleRequests: ["req-stale"] });
    const block: PermissionBlock = {
      ...base,
      id: "b5c",
      kind: "permission",
      request: { requestId: "req-stale", toolName: "Bash", input: {}, suggestions: [] },
      decision: null,
    };
    renderBlock(block);
    const card = screen.getByTestId("block-permission");
    expect(card).toHaveAttribute("data-state", "stale");
    expect(card).toHaveTextContent("not live any more");
    expect(screen.queryByTestId("block-permission-allow")).not.toBeInTheDocument();
  });

  it("answers a question with free text when no option fits (R32)", async () => {
    const user = userEvent.setup();
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerQuestion });
    const block: QuestionBlock = {
      ...base,
      id: "b6b",
      kind: "question",
      requestId: "req-3",
      questions: [
        {
          question: "Which framework?",
          multiSelect: false,
          options: [
            { label: "Vite", description: "The bundler" },
            { label: "Next" },
          ],
        },
      ],
      answers: null,
    };
    renderBlock(block);
    // Option descriptions are rendered, not hidden in a tooltip.
    expect(screen.getByTestId("block-question")).toHaveTextContent("The bundler");

    await user.click(screen.getByTestId("block-question-other"));
    await user.type(screen.getByTestId("block-question-other-input"), "Astro");
    await user.click(screen.getByTestId("block-question-submit"));
    expect(answerQuestion).toHaveBeenCalledWith("req-3", { "Which framework?": "Astro" });
  });

  it("says an AskUserQuestion answer went nowhere when nothing was waiting", () => {
    useAppStore.setState({ staleRequests: ["req-4"] });
    const block: QuestionBlock = {
      ...base,
      id: "b6c",
      kind: "question",
      requestId: "req-4",
      questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }] }],
      answers: null,
    };
    renderBlock(block);
    expect(screen.getByTestId("block-question")).toHaveAttribute("data-state", "stale");
    expect(screen.queryByTestId("block-question-submit")).not.toBeInTheDocument();
  });

  it("renders a usage block's totals", () => {
    const block: UsageBlock = {
      ...base,
      id: "b9",
      kind: "usage",
      model: "claude-opus-4-5",
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.0321,
      },
    };
    renderBlock(block);
    const line = screen.getByTestId("block-usage");
    expect(line).toHaveTextContent("1,234 in");
    expect(line).toHaveTextContent("56 out");
  });

  it("shows a byModel breakdown once more than one model billed the same turn (R23)", async () => {
    const user = userEvent.setup();
    const events: UsageEvent[] = [
      {
        id: "u1",
        sessionId: "session-1",
        agentId: null,
        turnId: "turn-1",
        backend: "claude",
        model: "claude-opus-4-5",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
        ts: 1,
      },
      {
        id: "u2",
        sessionId: "session-1",
        agentId: null,
        turnId: "turn-1",
        backend: "claude",
        model: "claude-haiku-4-5",
        inputTokens: 20,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
        ts: 2,
      },
    ];
    useAppStore.setState({ usageEvents: events });
    const block: UsageBlock = {
      ...base,
      id: "b9b",
      kind: "usage",
      model: "claude-opus-4-5",
      usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.011 },
    };
    renderBlock(block);
    expect(screen.queryByTestId("usage-breakdown-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-breakdown")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("usage-breakdown-trigger"));
    const breakdown = screen.getByTestId("usage-breakdown");
    expect(breakdown).toHaveTextContent("claude-opus-4-5");
    expect(breakdown).toHaveTextContent("claude-haiku-4-5");
  });

  it("does not show a breakdown affordance for a single-model turn", () => {
    useAppStore.setState({
      usageEvents: [
        {
          id: "u1",
          sessionId: "session-1",
          agentId: null,
          turnId: "turn-1",
          backend: "claude",
          model: "claude-opus-4-5",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
          ts: 1,
        },
      ],
    });
    const block: UsageBlock = {
      ...base,
      id: "b9c",
      kind: "usage",
      model: "claude-opus-4-5",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001 },
    };
    renderBlock(block);
    expect(screen.queryByTestId("usage-breakdown-trigger")).not.toBeInTheDocument();
  });
});

describe("PermissionCard (R32/R28)", () => {
  function pendingBlock(overrides: Partial<PermissionBlock> = {}): PermissionBlock {
    return {
      ...base,
      id: "perm-1",
      kind: "permission",
      request: { requestId: "req-1", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
      decision: null,
      ...overrides,
    };
  }

  /** The card arms its keyboard shortcut only for the oldest *pending* block
   *  in the store, so a card under test has to actually be in the store. */
  function renderPending(block: PermissionBlock, ...others: PermissionBlock[]) {
    const blocks = Object.fromEntries([block, ...others].map((b) => [b.id, b]));
    useAppStore.setState({ blocks });
    return renderBlock(block);
  }

  it("shows a title/description from _meta permissionDisplay and the tool input", () => {
    renderPending(
      pendingBlock({
        title: "Run a shell command",
        description: "capygen wants to run this in your project.",
      }),
    );
    const card = screen.getByTestId("block-permission");
    expect(card).toHaveTextContent("Run a shell command");
    expect(card).toHaveTextContent("capygen wants to run this in your project.");
    // A shell approval renders the command itself, not the transport JSON.
    expect(screen.getByTestId("block-permission-command")).toHaveTextContent("ls");
    expect(card).not.toHaveTextContent('"command"');
  });

  it("renders an apply_patch approval as the files it touches, not a JSON array", () => {
    renderPending(
      pendingBlock({
        request: {
          requestId: "req-1",
          toolName: "apply_patch",
          input: { changes: [{ path: "src/a.ts", kind: "update" }] },
          suggestions: [],
        },
      }),
    );
    const changes = screen.getByTestId("block-permission-changes");
    expect(changes).toHaveTextContent("src/a.ts");
    expect(screen.getByTestId("block-permission")).not.toHaveTextContent('"changes"');
  });

  it("allows for the session through the middle button", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderBlock(pendingBlock());
    await user.click(screen.getByTestId("block-permission-allow-always"));
    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow_always");
  });

  it("denies with no reason when the field is left blank", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderBlock(pendingBlock());
    await user.click(screen.getByTestId("block-permission-deny"));
    expect(answerPermission).toHaveBeenCalledWith("req-1", "deny");
  });

  it("denies with the typed reason", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderBlock(pendingBlock());
    await user.type(screen.getByTestId("block-permission-reason"), "Too destructive");
    await user.click(screen.getByTestId("block-permission-deny"));
    expect(answerPermission).toHaveBeenCalledWith("req-1", "deny", { message: "Too destructive" });
  });

  it("shows a distinct label for an allow_always decision", () => {
    renderBlock(
      pendingBlock({ decision: { behavior: "allow_always", scope: "always", decidedAt: 1 } }),
    );
    expect(screen.getByTestId("block-permission")).toHaveTextContent("Allowed for the session");
  });

  it("Enter allows the pending request (R32 keyboard shortcut)", () => {
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderPending(pendingBlock());
    fireEvent.keyDown(window, { key: "Enter" });
    expect(answerPermission).toHaveBeenCalledWith("req-1", "allow");
  });

  it("Escape denies the pending request (R32 keyboard shortcut)", () => {
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderPending(pendingBlock());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(answerPermission).toHaveBeenCalledWith("req-1", "deny");
  });

  it("arms the shortcut on only the oldest pending card (R27: no bulk approval)", () => {
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    const older = pendingBlock({ id: "perm-0", createdAt: 1 });
    const newer = pendingBlock({
      id: "perm-1",
      createdAt: 2,
      request: { requestId: "req-2", toolName: "Bash", input: { command: "rm" }, suggestions: [] },
    });
    // Render the *newer* card while both are pending: one Enter must not
    // approve it, because the older card owns the shortcut.
    renderPending(newer, older);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(answerPermission).not.toHaveBeenCalled();
  });

  it("does not steal Enter/Escape while a text field has focus", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderBlock(pendingBlock());
    const reasonInput = screen.getByTestId("block-permission-reason");
    await user.click(reasonInput);
    fireEvent.keyDown(reasonInput, { key: "Enter" });
    expect(answerPermission).not.toHaveBeenCalled();
  });

  it("stops listening for shortcuts once the request is answered", () => {
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    const { rerender } = renderPending(pendingBlock());
    useAppStore.setState({ blocks: {} });
    rerender(
      <BlockRenderer
        block={pendingBlock({ decision: { behavior: "allow", scope: "once", decidedAt: 1 } })}
        isUser={false}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(answerPermission).not.toHaveBeenCalled();
  });
});

describe("QuestionCard allowOther (R32)", () => {
  it("hides the Other row when the harness disallows free text", () => {
    const block: QuestionBlock = {
      ...base,
      id: "q-no-other",
      kind: "question",
      requestId: "req-no-other",
      questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
      answers: null,
      allowOther: false,
    };
    renderBlock(block);
    expect(screen.queryByTestId("block-question-other")).not.toBeInTheDocument();
  });

  it("shows the Other row when allowOther is absent (legacy default)", () => {
    const block: QuestionBlock = {
      ...base,
      id: "q-legacy",
      kind: "question",
      requestId: "req-legacy",
      questions: [{ question: "Pick one", multiSelect: false, options: [{ label: "A" }] }],
      answers: null,
    };
    renderBlock(block);
    expect(screen.getByTestId("block-question-other")).toBeInTheDocument();
  });
});

describe("QuestionCard states and controls (R32)", () => {
  function question(overrides: Partial<QuestionBlock> = {}): QuestionBlock {
    return {
      ...base,
      id: "q-1",
      kind: "question",
      requestId: "req-q1",
      questions: [
        { question: "Pick one", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
      ],
      answers: null,
      ...overrides,
    };
  }

  it("never reads an empty answer map as a submission", () => {
    // `{}` is truthy, which is how an interrupted question used to render as
    // a green "Submitted" with an empty list.
    renderBlock(question({ answers: {}, status: "cancelled" }));
    const card = screen.getByTestId("block-question");
    expect(card).toHaveAttribute("data-state", "cancelled");
    expect(card).not.toHaveTextContent("Submitted");
  });

  it("says a question was cancelled when the turn ended without an answer", () => {
    renderBlock(question({ status: "cancelled" }));
    expect(screen.getByTestId("block-question")).toHaveAttribute("data-state", "cancelled");
  });

  it("uses radios for single-select and checkboxes for multi-select", () => {
    renderBlock(question());
    expect(
      within(screen.getByTestId("block-question-options")).getAllByRole("radio"),
    ).toHaveLength(3); // two options plus the Other row
    cleanup();
    renderBlock(
      question({
        id: "q-multi",
        questions: [
          { question: "Pick any", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    );
    expect(
      within(screen.getByTestId("block-question-options")).getAllByRole("checkbox"),
    ).toHaveLength(3);
  });

  it("declines through the same channel, with no answers", async () => {
    const user = userEvent.setup();
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerQuestion });
    // With `allowOther: false` and no acceptable option, Decline is the only
    // exit that is not "interrupt the whole turn".
    renderBlock(question({ allowOther: false }));
    await user.click(screen.getByTestId("block-question-decline"));
    expect(answerQuestion).toHaveBeenCalledWith("req-q1", {});
  });

  it("keeps two identically-worded questions apart", async () => {
    const user = userEvent.setup();
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerQuestion });
    renderBlock(
      question({
        id: "q-dup",
        allowOther: false,
        questions: [
          { question: "Which file?", multiSelect: false, options: [{ label: "A" }] },
          { question: "Which file?", multiSelect: false, options: [{ label: "B" }] },
        ],
      }),
    );
    const groups = screen.getAllByTestId("block-question-options");
    // Selecting in the first must not select in the second: the state used to
    // be keyed by the question *text*, so both shared one entry.
    await user.click(within(groups[0]!).getByRole("radio", { name: /A/ }));
    expect(screen.getByTestId("block-question-submit")).toBeDisabled();
    await user.click(within(groups[1]!).getByRole("radio", { name: /B/ }));
    await user.click(screen.getByTestId("block-question-submit"));
    expect(answerQuestion).toHaveBeenCalledWith("req-q1", { "Which file?": "B" });
  });
});

describe("ElicitationCard (R32)", () => {
  function pendingElicitation(overrides: Partial<ElicitationBlock> = {}): ElicitationBlock {
    return {
      ...base,
      id: "elicit-1",
      kind: "elicitation",
      requestId: "req-e1",
      title: "Configure the release",
      schema: {
        properties: {
          branch: { type: "string", title: "Branch" },
          channel: { type: "string", enum: ["stable", "beta"], default: "stable" },
          dryRun: { type: "boolean" },
        },
        required: ["branch"],
      },
      answers: null,
      status: "pending",
      ...overrides,
    };
  }

  it("generates a control per property and gates submit on the required one", async () => {
    const user = userEvent.setup();
    const answerElicitation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerElicitation });
    renderBlock(pendingElicitation());

    expect(screen.getByTestId("elicit-field-branch")).toBeInTheDocument();
    expect(screen.getByTestId("elicit-field-channel")).toBeInTheDocument();
    expect(screen.getByTestId("elicit-field-dryRun")).toBeInTheDocument();
    expect(screen.getByTestId("elicitation-submit")).toBeDisabled();

    // The label's own accessible text includes the "*" required marker.
    await user.type(screen.getByLabelText(/Branch/), "main");
    expect(screen.getByTestId("elicitation-submit")).toBeEnabled();

    await user.click(screen.getByTestId("elicitation-submit"));
    expect(answerElicitation).toHaveBeenCalledWith("turn-1", "elicit-1", { branch: "main", channel: "stable" });
  });

  it("cancel sends null answers", async () => {
    const user = userEvent.setup();
    const answerElicitation = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerElicitation });
    renderBlock(pendingElicitation());
    await user.click(screen.getByTestId("elicitation-cancel"));
    expect(answerElicitation).toHaveBeenCalledWith("turn-1", "elicit-1", null);
  });

  it("a schema with no properties is a bare Accept/Decline prompt", () => {
    renderBlock(pendingElicitation({ schema: {} }));
    expect(screen.queryByTestId("elicitation-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("elicitation-submit")).toHaveTextContent("Accept");
    expect(screen.getByTestId("elicitation-submit")).toBeEnabled();
  });

  it("renders the accepted state with the submitted answers", () => {
    renderBlock(pendingElicitation({ status: "accepted", answers: { branch: "main" } }));
    const card = screen.getByTestId("block-elicitation");
    expect(card).toHaveAttribute("data-state", "accepted");
    expect(card).toHaveTextContent("branch");
    expect(card).toHaveTextContent("main");
  });

  it("renders the declined state", () => {
    renderBlock(pendingElicitation({ status: "declined" }));
    expect(screen.getByTestId("block-elicitation")).toHaveAttribute("data-state", "declined");
  });

  it("says an elicitation answer went nowhere when nothing was waiting", () => {
    useAppStore.setState({ staleRequests: ["elicit-1"] });
    renderBlock(pendingElicitation());
    expect(screen.getByTestId("block-elicitation")).toHaveAttribute("data-state", "stale");
  });
});

describe("ToolCallCard per family (SPEC R6 item 3)", () => {
  it("bash: shows the command as the summary and the exit status", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-bash",
      kind: "tool_call",
      name: "Bash",
      input: { command: "pnpm test" },
      output: "$ pnpm test\n(exit code 0)\n177 passed",
      status: "success",
    };
    renderBlock(block);
    const card = screen.getByTestId("block-tool-call");
    expect(card).toHaveTextContent("pnpm test");
    expect(card.getAttribute("data-family")).toBe("bash");
    await user.click(screen.getByText("Bash"));
    expect(card).toHaveTextContent("exit code 0");
  });

  it("read: shows the path and line range", () => {
    const block: ToolCallBlock = {
      ...base,
      id: "t-read",
      kind: "tool_call",
      name: "Read",
      input: { path: "README.md", offset: 1, limit: 20 },
      output: "# capygen",
      status: "success",
    };
    renderBlock(block);
    expect(screen.getByTestId("block-tool-call")).toHaveTextContent("README.md (lines 1-20)");
  });

  it("edit: renders a synthetic diff between old_string and new_string", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-edit",
      kind: "tool_call",
      name: "Edit",
      input: { file_path: "src/app.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      output: "Replaced 1 occurrence.",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("Edit"));
    const diff = screen.getByTestId("tool-call-diff");
    expect(diff).toHaveTextContent("src/app.ts");
    expect(diff).toHaveTextContent("-const x = 1;");
    expect(diff).toHaveTextContent("+const x = 2;");
  });

  it("write: renders a whole-file-addition diff", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-write",
      kind: "tool_call",
      name: "write_file",
      input: { path: "notes.md", content: "line one\nline two" },
      output: "Wrote notes.md.",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("write_file"));
    const diff = screen.getByTestId("tool-call-diff");
    expect(diff).toHaveTextContent("+line one");
    expect(diff).toHaveTextContent("+line two");
  });

  it("glob/grep: renders the output as a match list, not raw JSON/text", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-glob",
      kind: "tool_call",
      name: "Glob",
      input: { pattern: "src/**/*.ts" },
      output: "2 matches for src/**/*.ts under .\nsrc/a.ts\nsrc/b.ts",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("Glob"));
    const list = screen.getByTestId("tool-call-result-list");
    expect(within(list).getByText("src/a.ts")).toBeInTheDocument();
    expect(within(list).getByText("src/b.ts")).toBeInTheDocument();
  });

  it("web: shows the URL as the summary", () => {
    const block: ToolCallBlock = {
      ...base,
      id: "t-web",
      kind: "tool_call",
      name: "WebFetch",
      input: { url: "https://example.com/docs" },
      output: "example docs",
      status: "success",
    };
    renderBlock(block);
    expect(screen.getByTestId("block-tool-call")).toHaveTextContent("https://example.com/docs");
  });

  it("mcp: shows server · tool and renders text + image results", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-mcp",
      kind: "tool_call",
      name: "mcp__higgsfield__generate_image",
      serverName: "higgsfield",
      input: { prompt: "a bicycle" },
      output: {
        content: [
          { type: "text", text: "Generated 1 image." },
          { type: "image", data: "AAA=", mimeType: "image/png" },
        ],
      },
      status: "success",
    };
    renderBlock(block);
    const card = screen.getByTestId("block-tool-call");
    expect(card).toHaveTextContent("higgsfield");
    await user.click(screen.getByText("mcp__higgsfield__generate_image"));
    const result = screen.getByTestId("tool-call-mcp-result");
    expect(result).toHaveTextContent("Generated 1 image.");
    expect(result.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAA=");
  });

  it("task: links to its spawned sub-agent block once it exists", async () => {
    const user = userEvent.setup();
    const subagent: SubagentBlock = {
      ...base,
      id: "subagent:spawn-1",
      kind: "subagent",
      agentId: null,
      name: "reviewer",
      backend: "claude",
      model: "claude-opus-4-5",
      description: "",
      status: "running",
    };
    useAppStore.setState({ blocks: { [subagent.id]: subagent } });
    const block: ToolCallBlock = {
      ...base,
      id: "t-task",
      kind: "tool_call",
      name: "Task",
      toolUseId: "spawn-1",
      input: { description: "Review the diff" },
      output: "done",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("Task"));
    expect(screen.getByTestId("tool-call-subagent-link")).toHaveTextContent("reviewer");
  });

  it("task: renders no link when the sub-agent hasn't produced a block yet", async () => {
    const user = userEvent.setup();
    const block: ToolCallBlock = {
      ...base,
      id: "t-task-2",
      kind: "tool_call",
      name: "Task",
      toolUseId: "spawn-nope",
      input: {},
      output: "done",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("Task"));
    expect(screen.queryByTestId("tool-call-subagent-link")).not.toBeInTheDocument();
  });

  it("fetches an out-of-row truncated output on demand (R25 outputRef)", async () => {
    const user = userEvent.setup();
    ipcInvoke.mockResolvedValue({
      id: "tout_1",
      blockId: "t-ref",
      content: "THE FULL VALUE",
      createdAt: 1,
    });
    const block: ToolCallBlock = {
      ...base,
      id: "t-ref",
      kind: "tool_call",
      name: "custom_tool",
      input: {},
      output: "stub…",
      truncated: true,
      outputRef: "tout_1",
      status: "success",
    };
    renderBlock(block);
    await user.click(screen.getByText("custom_tool"));
    await user.click(screen.getByTestId("tool-output-expand"));
    expect(ipcInvoke).toHaveBeenCalledWith("blocks.getOutput", { id: "tout_1" });
    expect(await screen.findByText("THE FULL VALUE")).toBeInTheDocument();
  });
});

describe("PermissionCard ▸ a local-policy card mints a session grant", () => {
  const localBlock = (): PermissionBlock => ({
    ...base,
    id: "b-local",
    kind: "permission",
    request: {
      requestId: "req-local",
      toolName: "mcp__docs__search",
      input: { query: "capybara" },
      suggestions: [],
      localPolicy: {
        ruleId: "lpr_1",
        scope: { kind: "session", sessionId: "ses_1" },
        boundary: "api-tool",
      },
    },
    decision: null,
  });

  it("sends allow with scope session, never the historical allow_always", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    renderBlock(localBlock());

    await user.click(screen.getByTestId("block-permission-allow-always"));
    // `allow_always` is collapsed to a single-use allow by the local broker, so
    // sending it would have made this button promise a session grant and
    // deliver one use.
    expect(answerPermission).toHaveBeenCalledWith("req-local", "allow", { scope: "session" });
    expect(answerPermission).not.toHaveBeenCalledWith("req-local", "allow_always");
  });

  it("leaves an ordinary native card's answer exactly as it was", async () => {
    const user = userEvent.setup();
    const answerPermission = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ answerPermission });
    const block = localBlock();
    renderBlock({ ...block, id: "b-native", request: { ...block.request, localPolicy: undefined } });

    await user.click(screen.getByTestId("block-permission-allow-always"));
    expect(answerPermission).toHaveBeenCalledWith("req-local", "allow_always");
  });

  it("names the owning restriction and links to its editor", () => {
    renderBlock(localBlock());
    const attribution = screen.getByTestId("block-permission-local-policy");
    expect(attribution).toHaveTextContent(/restriction on this session/i);
    expect(attribution).toHaveTextContent(/an API tool call/i);
    // ADR-0007: an exception is made by editing the owning restriction.
    // The id travels, so Policies can open the restriction that actually
    // refused rather than the page in general.
    expect(screen.getByTestId("block-permission-rule-link")).toHaveAttribute(
      "href",
      "/settings/policies?rule=lpr_1",
    );
  });

  it("says when the call runs in this app's widget host rather than the backend", () => {
    const block = localBlock();
    renderBlock({
      ...block,
      id: "b-widget",
      request: {
        ...block.request,
        localPolicy: { ...block.request.localPolicy!, executionSite: "widget-host" },
      },
    });
    // Which boundary covers the call and where it actually runs are different
    // questions; without this the card reads as if the backend were running it.
    expect(screen.getByTestId("block-permission-local-policy"))
      .toHaveTextContent(/widget running in this app/i);
  });

  it("says nothing about an execution site for an ordinary backend call", () => {
    renderBlock(localBlock());
    expect(screen.getByTestId("block-permission-local-policy"))
      .not.toHaveTextContent(/widget/i);
  });

  it("shows no policy attribution on an ordinary native card", () => {
    const block = localBlock();
    renderBlock({ ...block, id: "b-native2", request: { ...block.request, localPolicy: undefined } });
    expect(screen.queryByTestId("block-permission-local-policy")).toBeNull();
  });
});
