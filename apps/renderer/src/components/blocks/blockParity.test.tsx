/**
 * **Block parity, renderer half** (PLAN.md Phase 3, SPEC R6).
 *
 * `BlockRenderer.test.tsx` next door proves each card renders its own content.
 * This file proves something the per-card tests structurally cannot: that for
 * every backend, *every* block kind that backend can produce has a card — and
 * that no kind in the `Block` union is missing a fixture here.
 *
 * The expectation comes from `BACKEND_BLOCK_PARITY` in `@capygen/shared`, the
 * same table `apps/desktop/test/blockParity.test.ts` reads for the persistence
 * half, so the two halves can never drift: adding a kind to `BLOCK_KINDS` fails
 * this suite until it has both a fixture and a card.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_BLOCK_PARITY,
  BLOCK_KINDS,
  type Backend,
  type Block,
  type BlockKind,
} from "@capygen/shared";
import { BlockRenderer } from "./BlockRenderer";
import { useAppStore } from "@/store/appStore";

vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke: vi.fn(), on: () => () => {} }),
  hasBridge: () => true,
}));

const base = { turnId: "t1", sessionId: "s1", index: 0, createdAt: 1, updatedAt: 1 };

/**
 * The card each kind renders into. `tool_call` is the one that is not simply
 * `block-<kind>` — the card has been `block-tool-call` since Phase 2 and the
 * e2e specs key off it, so the mapping is written down rather than the testid
 * being churned.
 */
const TESTID: Record<BlockKind, string> = {
  text: "block-text",
  thinking: "block-thinking",
  tool_call: "block-tool-call",
  diff: "block-diff",
  permission: "block-permission",
  question: "block-question",
  subagent: "block-subagent",
  error: "block-error",
  usage: "block-usage",
  widget: "block-widget",
  elicitation: "block-elicitation",
};

/** One representative block per kind, as a backend would emit it. */
const FIXTURES: Record<BlockKind, Block> = {
  text: { ...base, id: "b-text", kind: "text", text: "hello world" },
  thinking: { ...base, id: "b-think", kind: "thinking", text: "let me think" },
  tool_call: {
    ...base,
    id: "b-tool",
    kind: "tool_call",
    name: "Bash",
    family: "bash",
    input: { command: "echo capy" },
    output: "capy",
    status: "success",
    toolUseId: "call_1",
  },
  diff: {
    ...base,
    id: "b-diff",
    kind: "diff",
    path: "notes.md",
    patch: "--- a/notes.md\n+++ b/notes.md\n@@\n-old\n+new\n",
    additions: 1,
    deletions: 1,
  },
  permission: {
    ...base,
    id: "b-perm",
    kind: "permission",
    request: {
      requestId: "req_perm",
      toolName: "Bash",
      input: { command: "rm -rf build" },
      suggestions: [],
    },
    decision: null,
  },
  question: {
    ...base,
    id: "b-question",
    kind: "question",
    requestId: "req_q",
    questions: [
      {
        question: "Which one?",
        header: "Pick",
        multiSelect: false,
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
    answers: null,
  },
  subagent: {
    ...base,
    id: "b-sub",
    kind: "subagent",
    agentId: null,
    name: "explorer",
    backend: "claude",
    model: "claude-sonnet-4-5",
    description: "read the tree",
    status: "done",
  },
  error: { ...base, id: "b-err", kind: "error", message: "the tool refused" },
  usage: {
    ...base,
    id: "b-usage",
    kind: "usage",
    model: "claude-sonnet-4-5",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    },
  },
  widget: {
    ...base,
    id: "b-widget",
    kind: "widget",
    toolCallId: "call_mcp",
    serverName: "capyfixture",
    toolName: "show_card",
    resourceUri: "ui://capyfixture/card.html",
    html: "<p>hi</p>",
    htmlStatus: "ready",
    toolInput: { title: "Hello" },
    toolResult: { content: [{ type: "text", text: "shown" }] },
    meta: null,
  },
  elicitation: {
    ...base,
    id: "b-elicit",
    kind: "elicitation",
    requestId: "req_elicit",
    title: "capyfixture",
    description: "Which workspace?",
    schema: { type: "object", properties: { workspace: { type: "string" } } },
    answers: null,
    status: "pending",
  },
};

beforeEach(() => {
  useAppStore.setState({ staleRequests: [], usageEvents: [], blocks: {} });
});

describe("block parity — every kind has a fixture and a card", () => {
  it("covers the whole Block union", () => {
    // Not a tautology: `FIXTURES`/`TESTID` are hand-written maps, and TS's
    // `Record<BlockKind, …>` catches a *missing* key at compile time but says
    // nothing at runtime about a kind added to the union after this file was
    // last built against it.
    expect(Object.keys(FIXTURES).sort()).toEqual([...BLOCK_KINDS].sort());
    expect(Object.keys(TESTID).sort()).toEqual([...BLOCK_KINDS].sort());
  });

  for (const kind of BLOCK_KINDS) {
    it(`renders a ${kind} block`, () => {
      render(<BlockRenderer block={FIXTURES[kind]} isUser={false} />);
      expect(screen.getByTestId(TESTID[kind])).toBeInTheDocument();
    });
  }
});

describe("block parity — per backend", () => {
  for (const backend of ["claude", "codex", "api"] as const satisfies readonly Backend[]) {
    const parity = BACKEND_BLOCK_PARITY[backend];

    it(`${backend}: every applicable kind renders a card`, () => {
      for (const kind of parity.applicable) {
        const { unmount } = render(
          <BlockRenderer block={FIXTURES[kind]} isUser={false} />,
        );
        expect(
          screen.getByTestId(TESTID[kind]),
          `${backend} can emit a ${kind} block but nothing rendered it`,
        ).toBeInTheDocument();
        unmount();
      }
    });

    it(`${backend}: the kinds it cannot emit are documented, not forgotten`, () => {
      const excused = Object.keys(parity.inapplicable) as BlockKind[];
      expect([...parity.applicable, ...excused].sort()).toEqual([...BLOCK_KINDS].sort());
      // A card still exists for every excused kind — another backend emits it,
      // and a stored transcript from that backend renders in the same view.
      for (const kind of excused) {
        const { unmount } = render(
          <BlockRenderer block={FIXTURES[kind]} isUser={false} />,
        );
        expect(screen.getByTestId(TESTID[kind])).toBeInTheDocument();
        unmount();
      }
    });
  }
});
