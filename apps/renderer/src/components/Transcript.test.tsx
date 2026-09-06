/**
 * What the transcript attributes (SPEC R11/R12, ADR-0002): who a user message
 * was addressed to, an `@name` that answered to nobody, and a block a
 * delegated sub-agent wrote inside its parent's turn.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Agent, Block, Turn } from "@capygen/shared";
import { Transcript } from "./Transcript";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a-alice",
    sessionId: "s1",
    name: "alice",
    displayName: "Alice",
    mentionName: "alice",
    backend: "claude",
    model: "claude-opus-4-5",
    role: "lead",
    order: 0,
    config: null,
    createdAt: 0,
    ...overrides,
  };
}

const AGENTS: Agent[] = [
  agent({}),
  agent({
    id: "a-codex",
    name: "codex",
    displayName: "Codex",
    mentionName: "codex",
    backend: "codex",
    model: "gpt-5.5",
    role: "member",
    order: 1,
  }),
];

function turn(overrides: Partial<Turn>): Turn {
  return {
    id: "t1",
    sessionId: "s1",
    agentId: null,
    role: "user",
    status: "done",
    createdAt: 0,
    hopIndex: 0,
    mentions: [],
    ...overrides,
  };
}

function textBlock(overrides: Partial<Block> & { id: string; turnId: string }): Block {
  return {
    sessionId: "s1",
    index: 0,
    createdAt: 0,
    updatedAt: 0,
    kind: "text",
    text: "",
    ...overrides,
  } as Block;
}

describe("who a user message went to (SPEC R11)", () => {
  it("shows the addressed agents as chips", () => {
    const user = turn({ id: "t1", mentions: ["a-codex"] });
    render(
      <Transcript
        turns={[user]}
        agents={AGENTS}
        blocksOfTurn={() => [textBlock({ id: "b1", turnId: "t1", text: "@codex look" })]}
      />,
    );
    const chips = screen.getByTestId("turn-recipients");
    expect(within(chips).getByTestId("turn-recipient")).toHaveTextContent("@codex");
    expect(screen.queryByTestId("turn-unknown-mention")).not.toBeInTheDocument();
  });

  it("warns about an @name no agent answers to, instead of looking routed", () => {
    // `resolveTargets` documents unknown names as "never silently dropped";
    // before this the lead just answered and nothing said the mention missed.
    const user = turn({ id: "t1" });
    render(
      <Transcript
        turns={[user]}
        agents={AGENTS}
        unknownMentions={{ turnId: "t1", names: ["claud"] }}
        blocksOfTurn={() => [textBlock({ id: "b1", turnId: "t1", text: "@claud review" })]}
      />,
    );
    expect(screen.getByTestId("turn-unknown-mention")).toHaveTextContent("@claud");
  });
});

describe("a delegated sub-agent's blocks (SPEC R12)", () => {
  it("are nested under their own label, not shown as the parent's own words", () => {
    const agentTurn = turn({ id: "t2", role: "agent", agentId: "a-alice", hopIndex: 1 });
    render(
      <Transcript
        turns={[agentTurn]}
        agents={AGENTS}
        blocksOfTurn={() => [
          textBlock({
            id: "b1",
            turnId: "t2",
            text: "pong",
            delegatedFrom: "Reply with pong",
          } as Partial<Block> & { id: string; turnId: string }),
          textBlock({ id: "b2", turnId: "t2", index: 1, text: "Done." }),
        ]}
      />,
    );
    const delegated = screen.getByTestId("delegated-block");
    expect(delegated).toHaveAttribute("data-delegated-from", "Reply with pong");
    expect(delegated).toHaveTextContent("pong");
    // The parent's own reply is not inside it.
    expect(delegated).not.toHaveTextContent("Done.");
  });
});
