import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TextBlock } from "@capygen/shared";
import { TextBlockView } from "./TextBlockView";
import { useAppStore } from "@/store/appStore";

const block = (text: string): TextBlock => ({ id: "block", turnId: "turn", kind: "text", text, sessionId: "s", index: 0, createdAt: 0, updatedAt: 0 });
describe("TextBlockView history highlights", () => {
  it("highlights recognized mentions/commands while preserving case and ignoring paths/code/links", () => {
    useAppStore.setState({ agents: [{ id: "a", sessionId: "s", name: "Alice", displayName: "Alice", mentionName: "alice", backend: "claude", model: "m", role: "lead", order: 0, config: null, createdAt: 0 }] });
    render(<TextBlockView block={block("@Alice /HeLp /help/file [@Alice](https://example.test/@Alice)\n\n`/help`")} isUser />);
    const highlighted = screen.getAllByText("@Alice")[0]!;
    expect(highlighted).toHaveClass("text-primary");
    expect(screen.getByText("/HeLp")).toHaveClass("text-primary");
    expect(screen.getByText("/help/file")).not.toHaveClass("text-primary");
    expect(screen.getByText("/help")).not.toHaveClass("text-primary");
  });
});
