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

/**
 * How a Claude Code agent (SDK `Options.permissionMode`) treats tool calls.
 * Moved up from the Settings section (still used there) because the
 * per-backend agent config schemas below need it too.
 */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Which API an `api`-backend agent talks to directly (CONTEXT.md §Backend). */
export const ApiProviderSchema = z.enum(["anthropic", "openai", "openrouter"]);
export type ApiProvider = z.infer<typeof ApiProviderSchema>;
/** Iteration order for anything that must visit every provider (Settings ▸ API
 *  keys, the `harness.list` key probe). Derived from the enum, so a fourth
 *  provider cannot be added without appearing here. */
export const API_PROVIDERS = ApiProviderSchema.options;

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
// Agent config — one namespaced bag per backend (Phase 3)
// ---------------------------------------------------------------------------
//
// `Agent.config` has always been `{ claude?: {...}, codex?: {...}, api?: {...} }`
// in practice — `ClaudeHarness.readClaudeConfig` already reads `config.claude`
// — this just gives that convention a validated shape instead of `unknown`.
// Every sub-schema uses `.passthrough()` so a field a harness knows about but
// this file does not enumerate (yet) survives a round trip through SQLite
// instead of being silently stripped by `AgentSchema.parse`.

export const ClaudeAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    /** Free-form preset name for the `/effort` built-in (no fixed vocabulary yet). */
    effort: z.string().optional(),
    /** `Options.settingSources` — see ClaudeHarnessDeps in @capygen/engine. */
    settingSources: z.array(z.enum(["user", "project", "local"])).optional(),
    strictMcpConfig: z.boolean().optional(),
    allowedTools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  })
  .passthrough();
export type ClaudeAgentConfig = z.infer<typeof ClaudeAgentConfigSchema>;

export const CodexApprovalPolicySchema = z.enum([
  "untrusted",
  "on-request",
  "on-failure",
  "never",
]);
export type CodexApprovalPolicy = z.infer<typeof CodexApprovalPolicySchema>;

export const CodexSandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

export const CodexAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    approvalPolicy: CodexApprovalPolicySchema.optional(),
    sandbox: CodexSandboxModeSchema.optional(),
    reasoningEffort: z.string().optional(),
  })
  .passthrough();
export type CodexAgentConfig = z.infer<typeof CodexAgentConfigSchema>;

export const ApiAgentConfigSchema = z
  .object({
    provider: ApiProviderSchema,
    model: z.string().min(1),
    baseUrl: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    /** Provider-specific extended-thinking config; shape varies by provider. */
    thinking: z.unknown().optional(),
    permissionMode: PermissionModeSchema.optional(),
  })
  .passthrough();
export type ApiAgentConfig = z.infer<typeof ApiAgentConfigSchema>;

/** The full namespaced bag. Every key is optional: a claude-backend agent only
 * ever fills in `.claude`, but nothing stops a config from carrying more than
 * one backend's settings (e.g. a routing policy that might re-home an agent). */
export const AgentConfigSchema = z
  .object({
    claude: ClaudeAgentConfigSchema.optional(),
    codex: CodexAgentConfigSchema.optional(),
    api: ApiAgentConfigSchema.optional(),
  })
  .passthrough();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

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
  config: AgentConfigSchema.nullable().default(null),
  createdAt: TimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

/** Shape accepted when creating a session's agents (ids are assigned by main). */
export const AgentDraftSchema = z.object({
  name: z.string().min(1),
  backend: BackendSchema,
  model: z.string().min(1),
  role: z.string().default("agent"),
  config: AgentConfigSchema.nullable().default(null),
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

/**
 * Coarse tool grouping for filtering/iconography — computed by the harness
 * from the tool's name (e.g. Claude's `Bash` → `bash`, an MCP server's own
 * tool → `mcp`). Optional and defaulted to `other` rather than required: the
 * classifier is harness-specific and a block predating this field (or from a
 * harness that has not been taught to classify yet) must still parse.
 */
export const ToolCallFamilySchema = z.enum([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web",
  "mcp",
  "task",
  "other",
]);
export type ToolCallFamily = z.infer<typeof ToolCallFamilySchema>;

export const ToolCallBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("tool_call"),
  name: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: ToolCallStatusSchema,
  /** The backend's own id for the call, so streamed results can find the block. */
  toolUseId: z.string().optional(),
  /** Coarse grouping (R6 iconography/filtering); see `ToolCallFamilySchema`. */
  family: ToolCallFamilySchema.optional(),
  /** Which MCP server owns this tool, when `family` is `"mcp"`. */
  serverName: z.string().optional(),
  /** Set when `output` is the truncated stub of a larger result (R25). */
  truncated: z.boolean().optional(),
  /**
   * The whole result when `output` is only its stub. SPEC §Edge Cases requires
   * a big tool output to be "stored whole, sent to the model truncated with a
   * stub", and R25's stub is "expandable" — neither is possible if the rest of
   * the value is dropped at the harness boundary.
   */
  fullOutput: z.unknown().optional(),
  /**
   * `tool_outputs.id` when the full result was big enough to move out of the
   * block row entirely instead of riding along as `fullOutput` (Phase 3+:
   * whichever harness/handler decides a value is worth the extra table).
   */
  outputRef: z.string().optional(),
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
  /** `allow_always` added for R32/R28: a persisted "always allow" choice,
   * distinct from `scope: "always"` which is *this call's* granularity —
   * `permission.answer` collapses it to `{behavior:"allow", scope:"always"}`
   * for the harness and records the full three-way choice here. */
  behavior: z.enum(["allow", "allow_always", "deny"]),
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
  /**
   * Display metadata lifted onto the block from the tool's own
   * `_meta['anthropic/permissionDisplay']` (R32), so the card can render a
   * human title without the renderer reaching into backend-specific `_meta`.
   */
  title: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  /**
   * Raw `updatedPermissions` rule candidates from the SDK's `PermissionResult`
   * (R32's permission-suggestion UI) — opaque objects, not the backend's own
   * `request.suggestions` (which are plain alternative-input strings).
   */
  suggestions: z.array(z.unknown()).optional(),
  /** The decision's own reason (e.g. why denied); `request.reason` is the
   * backend's reason for asking in the first place. */
  reason: z.string().optional(),
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
  /**
   * Whether a free-text "Other" answer is offered for this card (R32). Left
   * optional rather than required-with-default on purpose: every existing
   * `QuestionBlock` in code and tests predates this field, and `QuestionCard`
   * already renders an Other row unconditionally today — treat an absent
   * value as "yes" (`allowOther !== false`) until a harness starts setting it
   * explicitly (e.g. a Codex user-input field that forbids free text).
   */
  allowOther: z.boolean().optional(),
  /** The free-text answer, when the user picked "Other" instead of an option. */
  otherText: z.string().nullable().optional(),
});

/** `_meta`/tool-call linkage every MCP-hosted widget carries (R31). */
export const WidgetHtmlStatusSchema = z.enum(["pending", "ready", "unavailable"]);
export type WidgetHtmlStatus = z.infer<typeof WidgetHtmlStatusSchema>;

/** MCP's `CallToolResult` shape, kept loose — content blocks vary by server. */
export const WidgetToolResultSchema = z.object({
  content: z.array(z.unknown()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
export type WidgetToolResult = z.infer<typeof WidgetToolResultSchema>;

/**
 * An MCP Apps widget card (R31): a tool result carrying a `ui://` resource in
 * its `_meta`. `html` is fetched separately (own MCP client connection, or the
 * backend's resource read — Phase 3 spike, A13) and arrives after the block
 * itself, hence `htmlStatus` — the card renders a loading state until it does.
 */
export const WidgetBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("widget"),
  /** The tool_use id this widget renders for; links it to any tool_call block. */
  toolCallId: z.string().min(1),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  /** The `ui://…` resource URI from the tool/result `_meta` (ext-apps). */
  resourceUri: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("ui://"), { message: "widget resourceUri must start with ui://" }),
  /** The resource's own HTML, once fetched; null while `htmlStatus` is pending. */
  html: z.string().nullable().default(null),
  htmlStatus: WidgetHtmlStatusSchema.default("pending"),
  toolInput: z.unknown(),
  toolResult: WidgetToolResultSchema.nullable().default(null),
  /** The tool call's and/or result's own `_meta`, verbatim (ext-apps bridge). */
  meta: z.unknown().nullable().default(null),
  /** Size negotiated with the host over the ext-apps bridge (`ui/size`). */
  size: z
    .object({ width: z.number().positive().optional(), height: z.number().positive().optional() })
    .optional(),
});

/** States an elicitation request moves through (mirrors MCP's accept/decline/cancel). */
export const ElicitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);
export type ElicitationStatus = z.infer<typeof ElicitationStatusSchema>;

/**
 * A backend's structured input request that is not a permission prompt or an
 * `AskUserQuestion` — MCP `elicitation/create`, or a Codex user-input request
 * (R32). `schema` is deliberately `unknown`: it is either a JSON Schema object
 * (MCP) or Codex's own user-input field list, and the form is rendered from
 * whichever shape it turns out to be, not validated against it here.
 */
export const ElicitationBlockSchema = z.object({
  ...blockBase,
  kind: z.literal("elicitation"),
  requestId: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  schema: z.unknown(),
  answers: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ElicitationStatusSchema.default("pending"),
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
  WidgetBlockSchema,
  ElicitationBlockSchema,
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
export type WidgetBlock = z.infer<typeof WidgetBlockSchema>;
export type ElicitationBlock = z.infer<typeof ElicitationBlockSchema>;

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
  "widget",
  "elicitation",
] as const satisfies readonly BlockKind[];

// ---------------------------------------------------------------------------
// Tool outputs — full values kept out of a block row (R25, migration 0002)
// ---------------------------------------------------------------------------

/** One `tool_outputs` row: the whole value a block's `outputRef` points at. */
export const ToolOutputSchema = z.object({
  id: z.string().min(1),
  blockId: z.string().min(1),
  content: z.unknown(),
  createdAt: TimestampSchema,
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

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

// ---------------------------------------------------------------------------
// Harness listing (`harness.list` IPC) — what Settings ▸ Harnesses and the
// New Session backend picker both need per backend.
// ---------------------------------------------------------------------------

export const HarnessModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type HarnessModelOption = z.infer<typeof HarnessModelOptionSchema>;

export const HarnessInfoSchema = z.object({
  backend: BackendSchema,
  label: z.string(),
  available: z.boolean(),
  /** Why `available` is false (missing CLI, not signed in, no key). */
  reason: z.string().optional(),
  models: z.array(HarnessModelOptionSchema),
  defaultModel: z.string(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;
