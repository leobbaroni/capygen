/**
 * The harness contract — one adapter per backend (CONTEXT.md §Harness).
 *
 * A harness knows how to drive its backend and nothing else: it never sees the
 * database, the IPC bridge or a block id. It emits `EngineEvent`s, and the
 * session runner in the desktop app turns those into row writes and renderer
 * events. That split is what keeps the harness unit-testable against a fake SDK
 * and keeps the app's IPC chatter out of the model's context (SPEC R26).
 *
 * Every event maps 1:1 onto something the rest of the app already models:
 *
 *   `block`      → one `Block` upsert (`@capygen/shared` domain union)
 *   `turn`       → `chat.turnStatus`
 *   `permission` → `permission.request` + the pending `canUseTool` promise
 *   `question`   → `question.request` (AskUserQuestion)
 *   `usage`      → one `usage_events` row (+ a `usage` block)
 *   `session`    → backend session id / model / command list for the caches
 */
import type {
  Backend,
  Block,
  PermissionMode,
  PermissionRequest,
  Question,
  SlashCommand,
  TurnStatus,
  UsageTotals,
} from "@capygen/shared";

/** Fields the store owns; a harness supplies everything else about a block. */
type BlockEnvelope = "id" | "turnId" | "sessionId" | "index" | "createdAt" | "updatedAt";

/**
 * A block as the harness sees it. Distributes over the domain union, so adding a
 * block kind in `@capygen/shared` immediately widens this type instead of
 * silently drifting from it.
 */
export type BlockPatch = Block extends infer B
  ? B extends Block
    ? Omit<B, BlockEnvelope>
    : never
  : never;

/**
 * Stable, harness-scoped identity for a block inside one turn (e.g.
 * `msg:msg_017…:0`, `tool:toolu_01…`). The runner maps a key to a block id once
 * and re-upserts the same row as the block grows — the incremental persistence
 * SPEC R23–R26 asks for, with no re-render of the whole turn.
 */
export type BlockKey = string;

export type EngineEvent =
  /** Upsert the block identified by `key` inside the current turn. */
  | { type: "block"; key: BlockKey; patch: BlockPatch }
  /** The turn moved: `streaming` → `done` | `error` | `interrupted`. */
  | { type: "turn"; status: TurnStatus; error?: string }
  /** A tool call is waiting for the user. Answer with `Harness.answerPermission`. */
  | {
      type: "permission";
      requestId: string;
      key: BlockKey;
      request: PermissionRequest;
    }
  /** AskUserQuestion. Answer with `Harness.answerQuestion`. */
  | {
      type: "question";
      requestId: string;
      key: BlockKey;
      questions: Question[];
    }
  /** One accounting row. `byModel` includes sub-agent models (spike §6). */
  | {
      type: "usage";
      backend: Backend;
      model: string;
      usage: UsageTotals;
      byModel: Record<string, UsageTotals>;
    }
  /** Backend session facts, emitted as soon as the backend reports them. */
  | {
      type: "session";
      backendSessionId: string;
      model?: string;
      commands?: SlashCommand[];
    };

/** The conversation a harness is attached to. */
export interface HarnessSession {
  sessionId: string;
  /** Working directory for the backend process. */
  projectPath: string;
}

/** The agent this harness instance speaks for (one harness per agent). */
export interface HarnessAgent {
  agentId: string;
  name: string;
  backend: Backend;
  /** Passed to the backend explicitly — never left to its own default (spike §6.4). */
  model: string;
  permissionMode?: PermissionMode;
  /**
   * Backend session id from an earlier run of this agent. When set the harness
   * resumes that conversation instead of starting a new one.
   */
  resumeSessionId?: string | null;
  /** Free-form per-agent config (routing policy, skills, …). */
  config?: unknown;
}

/** One user (or agent-to-agent) message being handed to the backend. */
export interface TurnInput {
  /** The turn row this send fills in; carried through for logging only. */
  turnId: string;
  /** Sent verbatim — slash commands are ordinary prompt text (spike §3). */
  text: string;
}

export interface TurnContext {
  /** Aborts the turn without tearing the backend session down. */
  signal?: AbortSignal;
}

/** What the UI may offer for this backend (R14, R23, R27). */
export interface HarnessCapabilities {
  streamingDeltas: boolean;
  permissions: boolean;
  questions: boolean;
  subagents: boolean;
  resume: boolean;
  interrupt: boolean;
  slashCommands: boolean;
}

export interface PermissionAnswer {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

/**
 * One backend adapter. `send` is the only long-running call: it returns an async
 * iterable that ends when the backend finishes the turn (or it is interrupted).
 */
export interface Harness {
  readonly backend: Backend;
  /** Bind the harness to a session+agent. Cheap: no process starts here. */
  start(session: HarnessSession, agent: HarnessAgent): Promise<void>;
  send(input: TurnInput, ctx?: TurnContext): AsyncIterable<EngineEvent>;
  /** True when a turn was actually cancelled. */
  interrupt(): Promise<boolean>;
  /** Cached from the backend's own listing; empty until it reports one. */
  listCommands(): SlashCommand[];
  capabilities(): HarnessCapabilities;
  /** Resolve a pending `permission` event. False when the id is unknown. */
  answerPermission(requestId: string, answer: PermissionAnswer): boolean;
  /** Resolve a pending `question` event with `question text → option label`. */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean;
  /** The backend session id to store for `resume`, once known. */
  backendSessionId(): string | null;
  dispose(): Promise<void>;
}

/** Builds a harness for one agent — the seam the session runner is given. */
export type HarnessFactory = (agent: HarnessAgent) => Harness;

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}
