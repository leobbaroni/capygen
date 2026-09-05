/**
 * capygen domain model — the single definition of every entity that crosses a
 * process boundary or hits SQLite. Zod schemas are the source of truth; the
 * TypeScript types are inferred from them, so a schema change is a type error
 * everywhere, not a silent drift.
 *
 * Field naming is camelCase in TypeScript and snake_case in SQL; the
 * repositories in `@capygen/db` do the mapping in one place.
 */
// Side-effect import: must run before the first schema below is constructed.
import "./zodRuntime.js";
import { z } from "zod";

/** Milliseconds since the epoch. Every timestamp in capygen is this. */
export const TimestampSchema = z.number().int().nonnegative();

/** Where an agent's model actually runs (CONTEXT.md §Backend). */
export const BackendSchema = z.enum(["claude", "codex", "api"]);
export type Backend = z.infer<typeof BackendSchema>;

/** How the agents in a session relate to each other (CONTEXT.md §Session). */
export const SessionModeSchema = z.enum(["solo", "round-table"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionStatusSchema = z.enum(["idle", "running", "waiting", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const TurnRoleSchema = z.enum(["user", "agent", "system"]);
export type TurnRole = z.infer<typeof TurnRoleSchema>;

export const TurnStatusSchema = z.enum([
  "pending",
  "streaming",
  "done",
  "error",
  "interrupted",
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * A working directory the user has opened. `layout` is the dockview arrangement
 * (Phase 5) and `devServers` the detected/configured runners (Phase 5); both are
 * carried as opaque JSON now so the schema does not have to change later.
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  layout: z.unknown().nullable().default(null),
  devServers: z.unknown().nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** One named participant: backend + model + role + its own config blob. */
export const AgentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  backend: BackendSchema,
  model: z.string().min(1),
  role: z.string().default("agent"),
  config: z.unknown().nullable().default(null),
  createdAt: TimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

/** Shape accepted when creating a session's agents (ids are assigned by main). */
export const AgentDraftSchema = z.object({
  name: z.string().min(1),
  backend: BackendSchema,
  model: z.string().min(1),
  role: z.string().default("agent"),
  config: z.unknown().nullable().default(null),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  mode: SessionModeSchema,
  /** Null only in the instant between inserting the session and its lead agent. */
  leadAgentId: z.string().min(1).nullable(),
  title: z.string(),
  status: SessionStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archived: z.boolean(),
});
export type Session = z.infer<typeof SessionSchema>;

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

/**
 * One message. `agentId` is null for user and system turns. `parentTurnId` +
 * `hopIndex` carry the round-table chain so the dispatcher's hop cap (R11) can
 * be enforced and displayed.
 */
export const TurnSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  role: TurnRoleSchema,
  status: TurnStatusSchema.default("done"),
  createdAt: TimestampSchema,
  parentTurnId: z.string().min(1).nullable().optional(),
  hopIndex: z.number().int().nonnegative().default(0),
});
export type Turn = z.infer<typeof TurnSchema>;

// ---------------------------------------------------------------------------
// Blocks — the rendered units inside a turn (CONTEXT.md §Block)
// ---------------------------------------------------------------------------

const blockBase = {
  id: z.string().min(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Position inside the turn; blocks are upserted by `id` and ordered by this. */
  index: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

export const ToolCallStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
  "denied",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const TextBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("text"),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(),
});

export const ToolCallBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("tool_call"),
  name: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: ToolCallStatusSchema,
  /** The backend's own id for the call, so streamed results can find the block. */
  toolUseId: z.string().optional(),
  /** Set when `output` is the truncated stub of a larger result (R25). */
  truncated: z.boolean().optional(),
});

export const DiffBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("diff"),
  path: z.string(),
  patch: z.string(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});

/** What a backend asks permission for, before the tool runs. */
export const PermissionRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string(),
  input: z.unknown(),
  /** Free-form reason string from the backend, when it supplies one. */
  reason: z.string().optional(),
  /** Backend-suggested alternatives (e.g. a narrowed command). */
  suggestions: z.array(z.string()).default([]),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionDecisionSchema = z.object({
  behavior: z.enum(["allow", "deny"]),
  /** Edited input when the user narrowed the call before allowing it. */
  updatedInput: z.unknown().optional(),
  message: z.string().optional(),
  scope: z.enum(["once", "session", "always"]).default("once"),
  decidedAt: TimestampSchema,
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("permission"),
  request: PermissionRequestSchema,
  decision: PermissionDecisionSchema.nullable().default(null),
});

/**
 * One question from `AskUserQuestion`. Proven Phase 1 shape: the answer travels
 * back as `answers[question] = optionLabel` (docs/spikes/claude-sdk-shapes.md).
 */
export const QuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().default(false),
  options: z.array(
    z.object({ label: z.string(), description: z.string().optional() }),
  ),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("question"),
  requestId: z.string().min(1),
  questions: z.array(QuestionSchema),
  /** question text → chosen option label; null until the user answers. */
  answers: z.record(z.string(), z.string()).nullable().default(null),
});

export const SubagentBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("subagent"),
  agentId: z.string().nullable().default(null),
  name: z.string(),
  backend: BackendSchema.nullable().default(null),
  model: z.string().nullable().default(null),
  description: z.string().default(""),
  status: z.enum(["spawned", "running", "done", "error"]).default("spawned"),
});

export const ErrorBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("error"),
  message: z.string(),
  detail: z.string().optional(),
});

/** Token/cost totals as a block, so a turn can render its own meter (R23). */
export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("usage"),
  model: z.string().default(""),
  usage: UsageTotalsSchema,
});

export const BlockSchema = z.discriminatedUnion("kind", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
  DiffBlockSchema,
  PermissionBlockSchema,
  QuestionBlockSchema,
  SubagentBlockSchema,
  ErrorBlockSchema,
  UsageBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;
export type BlockKind = Block["kind"];

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type DiffBlock = z.infer<typeof DiffBlockSchema>;
export type PermissionBlock = z.infer<typeof PermissionBlockSchema>;
export type QuestionBlock = z.infer<typeof QuestionBlockSchema>;
export type SubagentBlock = z.infer<typeof SubagentBlockSchema>;
export type ErrorBlock = z.infer<typeof ErrorBlockSchema>;
export type UsageBlock = z.infer<typeof UsageBlockSchema>;

export const BLOCK_KINDS = [
  "text",
  "thinking",
  "tool_call",
  "diff",
  "permission",
  "question",
  "subagent",
  "error",
  "usage",
] as const satisfies readonly BlockKind[];

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

/** One accounting row per model call — the Usage page aggregates these (R23). */
export const UsageEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  backend: BackendSchema,
  model: z.string(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  ts: TimestampSchema,
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Every user-visible preference, with a default. `SettingsSchema.parse({})`
 * yields the shipping defaults, so a fresh install and a partially written
 * settings row take the same code path.
 */
export const SettingsSchema = z.object({
  theme: ThemeSchema.default("system"),
  /** Never install anything silently (CLAUDE.md); this only picks the mode. */
  permissionMode: PermissionModeSchema.default("default"),
  defaultBackend: BackendSchema.default("claude"),
  defaultModel: z.string().default("claude-opus-4-5"),
  /** Fraction of the model window at which compaction is offered (R25). */
  compactionThreshold: z.number().min(0.1).max(0.95).default(0.7),
  /** Round-table agent-to-agent chain cap (R11). */
  hopCap: z.number().int().min(1).max(20).default(3),
  closeToTray: z.boolean().default(true),
  showThinking: z.boolean().default(true),
  uiFontSize: z.number().int().min(10).max(22).default(13),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Persisted window geometry (main process only; not part of user Settings). */
export const WindowStateSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(860),
  maximized: z.boolean().default(false),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

// ---------------------------------------------------------------------------
// Slash commands (R14) — listed per session by the active backend
// ---------------------------------------------------------------------------

export const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  source: z.enum(["builtin", "backend", "skill", "plugin"]).default("builtin"),
  argumentHint: z.string().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;
