/**
 * Which block kinds each backend can actually produce — the "block parity"
 * table (PLAN.md Phase 3, SPEC R6).
 *
 * Every backend renders into the *same* transcript, so the interesting fact is
 * not "what blocks exist" (that is `BLOCK_KINDS`) but "which of them this
 * backend is on the hook for". Two tests read this table:
 *
 *   - `apps/desktop/test/blockParity.test.ts` — a recorded `EngineEvent`
 *     stream per backend, run through the real session runner, must persist a
 *     row of every applicable kind;
 *   - `apps/renderer/src/components/blocks/blockParity.test.tsx` — the same
 *     kinds, rendered through `BlockRenderer`.
 *
 * Because both derive their expectation from here rather than from their own
 * fixture, adding a kind to `BLOCK_KINDS` fails both suites until the table
 * says, for every backend, either "produce it" or "here is why it cannot".
 * That is the whole point: an inapplicable kind must be a written-down reason,
 * never an omission nobody noticed.
 *
 * This lives in `@capygen/shared` and not in a test folder because the two
 * suites sit in different vitest projects with different tsconfig roots, and
 * because it is a claim about the product, not about a fixture.
 */
import { BLOCK_KINDS, type Backend, type BlockKind } from "./domain.js";

export interface BackendBlockParity {
  /** Kinds this backend must be able to emit; the tests assert all of them. */
  applicable: readonly BlockKind[];
  /** Kind → why this backend can never produce it. Keys are the complement. */
  inapplicable: Readonly<Partial<Record<BlockKind, string>>>;
}

/**
 * Reasons, backend by backend (all of them verified against the harness that
 * would have to emit the kind):
 *
 * - **claude** — `elicitation` is the one gap: the Claude Agent SDK surfaces an
 *   MCP `elicitation/create` as a `canUseTool` permission prompt, never as a
 *   separate request, so `ClaudeHarness` has nothing to turn into the block
 *   (docs/spikes/claude-sdk-shapes.md).
 * - **api** — capygen's own loop has no Task tool yet (so no `subagent`), and
 *   nothing in the built-in tool set raises an elicitation; its MCP clients are
 *   constructed with `capabilities: {}`
 *   (`packages/engine/src/mcp/client/McpClientPool.ts`), so a server is told
 *   capygen cannot be elicited and never sends `elicitation/create`.
 */
export const BACKEND_BLOCK_PARITY: Readonly<Record<Backend, BackendBlockParity>> = {
  claude: {
    applicable: [
      "text",
      "thinking",
      "tool_call",
      "diff",
      "permission",
      "question",
      "subagent",
      "error",
      "usage",
      "widget",
    ],
    inapplicable: {
      elicitation:
        "the Claude Agent SDK relays an MCP elicitation as a canUseTool permission prompt, " +
        "so it arrives as a permission block, never as its own request",
    },
  },
  codex: {
    // Phase 4 (SPEC R12): `collabAgentToolCall`/`subAgentActivity` items map to
    // `subagent` blocks (`CodexHarness.emitCollabAgentToolCall` /
    // `.emitSubAgentActivity`), and `capabilities().subagents` is `true`.
    applicable: [
      "text",
      "thinking",
      "tool_call",
      "diff",
      "permission",
      "question",
      "subagent",
      "error",
      "usage",
      "widget",
      "elicitation",
    ],
    inapplicable: {},
  },
  api: {
    applicable: [
      "text",
      "thinking",
      "tool_call",
      "diff",
      "permission",
      "question",
      "error",
      "usage",
      "widget",
    ],
    inapplicable: {
      subagent: "capygen's own tool runtime has no Task tool yet (Phase 4)",
      elicitation:
        "no built-in tool raises one, and McpClientPool connects with capabilities:{} so a " +
        "server is told capygen cannot be elicited",
    },
  },
};

/** Every kind is either applicable or has a written reason — no third option. */
export function missingBlockParityKinds(backend: Backend): BlockKind[] {
  const entry = BACKEND_BLOCK_PARITY[backend];
  const covered = new Set<BlockKind>([
    ...entry.applicable,
    ...(Object.keys(entry.inapplicable) as BlockKind[]),
  ]);
  return BLOCK_KINDS.filter((kind) => !covered.has(kind));
}
