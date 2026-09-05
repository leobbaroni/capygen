/**
 * One test per block kind (SPEC R6): the fixture round-trips through
 * `BlockRenderer` and lands the `data-testid="block-<kind>"` card the rest
 * of the app (and the e2e suite) keys off. Interactive cards (permission,
 * question) also exercise the click → store-action wiring.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Block,
  DiffBlock,
  ErrorBlock,
  PermissionBlock,
  QuestionBlock,
  SubagentBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  UsageBlock,
} from "@capygen/shared";
import { BlockRenderer } from "./BlockRenderer";
import { useAppStore } from "@/store/appStore";

const base = {
  turnId: "turn-1",
  sessionId: "session-1",
  index: 0,
  createdAt: 1,
  updatedAt: 1,
};

function renderBlock(block: Block, isUser = false) {
  return render(<BlockRenderer block={block} isUser={isUser} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
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

  it("renders an error block's message", () => {
    const block: ErrorBlock = { ...base, id: "b8", kind: "error", message: "boom" };
    renderBlock(block);
    expect(screen.getByTestId("block-error")).toHaveTextContent("boom");
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
});
