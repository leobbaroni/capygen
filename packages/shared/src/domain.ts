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

/**
 * An agent's place in a round-table session (ADR-0002, SPEC R10-R13): the
 * **lead** receives an unaddressed message and is the sole top-level agent in
 * solo mode; every other top-level agent is a **member**. Exactly one agent
 * per session holds `lead` — `SessionsRepo.setLead` is the only sanctioned way
 * to move it (it demotes the previous holder in the same write), which is why
 * `agents.update` (`AgentPatchSchema`) refuses to set this field to `"lead"`.
 */
export const AgentRoleSchema = z.enum(["lead", "member"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * The `@name` an agent answers to in round-table dispatch (ADR-0002, SPEC
 * R11): lowercase, no spaces, so `"@codex reviews"` parses unambiguously.
 * Uniqueness is per-session, not global — enforced by `SessionsRepo`
 * (`uniqueMentionName`) and the partial unique index on
 * `agents(session_id, mention_name)` (migration 0003), not by this schema
 * alone, since a single agent's shape carries no notion of its siblings.
 */
export const MentionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "mentionName must be lowercase with no spaces (a-z0-9_-)");
export type MentionName = z.infer<typeof MentionNameSchema>;

/**
 * Lowercase, no-space slug derived from a free-form label — the fallback used
 * whenever an agent is created or renamed without an explicit `mentionName`
 * (`SessionsRepo.create`/`addAgent`/`updateAgent`, and `rowToAgent` for a
 * pre-migration-0003 row whose `mention_name` column is still NULL). Never
 * empty: an input with no latin/digit characters at all (e.g. all emoji)
 * falls back to `"agent"` rather than producing a string `MentionNameSchema`
 * would reject.
 */
export function deriveMentionName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

/**
 * Where a spawned sub-agent should run: a backend/model override (SPEC R12).
 * Both fields are optional independently — a route naming only a `model`
 * keeps the parent's backend, and a route that resolves to nothing at all is
 * exactly "fail open, inherit the parent's model" (ADR-0002 "advisory and
 * fails open"). Reused as both `Agent.subagentRouting` (per-agent override)
 * and `SessionSettings.routing.subagents` (session-wide default).
 */
export const RoutingTargetSchema = z
  .object({
    backend: BackendSchema.optional(),
    model: z.string().optional(),
  })
  .passthrough();
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
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

/**
 * One named participant: backend + model + role + its own config blob.
 *
 * `name` is the original free-form label (kept for the many call sites that
 * already read it — the harness's own display, sub-agent block headers);
 * `displayName` is Phase 4's explicit human-facing label and defaults to
 * `name` when a caller supplies only one of the two. `mentionName` is the
 * new, stricter slug @-mention dispatch actually parses against — never
 * free-form, always unique within the session (see `MentionNameSchema`).
 */
export const AgentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  mentionName: MentionNameSchema,
  backend: BackendSchema,
  model: z.string().min(1),
  role: AgentRoleSchema.default("member"),
  /** Shown in the agent info card and the round-table agent tree (R13). */
  description: z.string().optional(),
  /** Per-agent override of the session's default sub-agent routing (R12). */
  subagentRouting: RoutingTargetSchema.optional(),
  /** Swatch for the agent tree / round-table speaker headers; free-form. */
  color: z.string().optional(),
  /** Display/tab order among the session's top-level agents. */
  order: z.number().int().nonnegative().default(0),
  config: AgentConfigSchema.nullable().default(null),
  createdAt: TimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Fields `agents.update` may change. Deliberately excludes `id`, `sessionId`,
 * `backend` and `name` (identity, fixed after creation) and — deliberately —
 * accepts `role`, but `SessionsRepo.updateAgent` refuses a patch that sets it
 * to `"lead"` directly: promoting an agent must go through `setLead`, the
 * only path that also demotes the session's previous lead in the same write,
 * so the single-lead invariant cannot be broken by two independent patches.
 *
 * Hand-written rather than `AgentSchema.pick({...}).partial()`: three of the
 * picked fields (`role`, `order`, `config`) carry a `.default()` on
 * `AgentSchema`, and under this codebase's mandatory `z.config({jitless:
 * true})` (`zodRuntime.ts` — the CSP that also blocks the renderer forbids
 * zod's compiled fast path), `.optional()` wrapped around a `.default()`
 * field does **not** suppress the default the way it does when jitless is
 * off: an omitted key still comes back filled with the default instead of
 * staying absent (verified live against this package's own zod). A repo
 * method that does `{ ...existing, ...patch }` would then silently reset
 * `role`/`order`/`config` to their defaults on every patch that does not
 * mention them — the same latent bug `SettingsPatchSchema`'s doc comment
 * describes for `settings.set`. Every field below is spelled out
 * default-free instead.
 */
export const AgentPatchSchema = z.object({
  displayName: z.string().min(1).optional(),
  mentionName: MentionNameSchema.optional(),
  model: z.string().min(1).optional(),
  role: AgentRoleSchema.optional(),
  description: z.string().optional(),
  subagentRouting: RoutingTargetSchema.optional(),
  color: z.string().optional(),
  order: z.number().int().nonnegative().optional(),
  config: AgentConfigSchema.nullable().optional(),
});
export type AgentPatch = z.infer<typeof AgentPatchSchema>;

/**
 * Shape accepted when creating a session's agents (ids are assigned by main).
 * `displayName`/`mentionName` are optional here — `SessionsRepo.create`
 * defaults `displayName` to `name` and mints a unique `mentionName` from
 * whichever label is available (`deriveMentionName`) when the caller omits
 * them, exactly as a pre-migration-0003 row does when read back.
 */
export const AgentDraftSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  mentionName: MentionNameSchema.optional(),
  backend: BackendSchema,
  model: z.string().min(1),
  role: AgentRoleSchema.default("member"),
  description: z.string().optional(),
  subagentRouting: RoutingTargetSchema.optional(),
  color: z.string().optional(),
  /** Defaults to append-at-the-end when omitted (`SessionsRepo` assigns it). */
  order: z.number().int().nonnegative().optional(),
  config: AgentConfigSchema.nullable().default(null),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** `SessionSettings.routing` — session-wide defaults layered under a
 *  per-agent `Agent.subagentRouting` override (R12). */
export const SessionRoutingSchema = z
  .object({
    subagents: RoutingTargetSchema.optional(),
  })
  .passthrough();
export type SessionRouting = z.infer<typeof SessionRoutingSchema>;

/**
 * Per-session round-table settings (ADR-0002, SPEC R10-R13).
 * `SessionSettingsSchema.parse({})` yields the shipping defaults, the same
 * pattern `SettingsSchema`/`DEFAULT_SETTINGS` use — a session created before
 * this field existed reads back with `settings_json` still NULL and gets
 * exactly these defaults (`SessionsRepo`'s `fromJson(..., {})` fallback).
 */
export const SessionSettingsSchema = z
  .object({
    /** Agent-to-agent chain cap before the dispatcher stops and waits for the
     *  user or a `chat.continue` (R11). */
    hopCap: z.number().int().min(1).max(20).default(3),
    routing: SessionRoutingSchema.optional(),
    /** Whether @-mentioned agents may all respond concurrently instead of in
     *  mention order (R11's "delivered ... in mention order" is the default). */
    parallelAgents: z.boolean().default(false),
  })
  .passthrough();
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export const DEFAULT_SESSION_SETTINGS: SessionSettings = SessionSettingsSchema.parse({});

/**
 * `sessions.updateSettings`'s `patch` input. Hand-written, not
 * `SessionSettingsSchema.partial()` — see `SettingsPatchSchema`'s doc comment
 * for why a `.partial()` over a `.default()`-bearing field leaks that default
 * into every patch under this codebase's mandatory jitless zod config, which
 * would silently reset `hopCap`/`parallelAgents` on every settings edit that
 * does not mention them.
 */
export const SessionSettingsPatchSchema = z
  .object({
    hopCap: z.number().int().min(1).max(20).optional(),
    routing: SessionRoutingSchema.optional(),
    parallelAgents: z.boolean().optional(),
  })
  .passthrough();
export type SessionSettingsPatch = z.infer<typeof SessionSettingsPatchSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  mode: SessionModeSchema,
  /** Null only in the instant between inserting the session and its lead agent. */
  leadAgentId: z.string().min(1).nullable(),
  title: z.string(),
  status: SessionStatusSchema,
  /**
   * `.default(() => ...)`, not `.default({})`: zod's `ZodDefault` substitutes
   * a *value* default without re-running it through the inner schema, so a
   * bare `{}` would skip `SessionSettingsSchema`'s own `hopCap`/
   * `parallelAgents` defaults entirely (`session.settings` would read back as
   * literally `{}` — verified live). The factory both fills those nested
   * defaults and hands out a fresh object per parse rather than one shared,
   * mutable reference across every settings-less session.
   */
  settings: SessionSettingsSchema.default(() => SessionSettingsSchema.parse({})),
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
 *
 * Three fields added for round-table dispatch (ADR-0002, SPEC R11):
 *   - `mentions` — agent ids this turn's text @-addresses, in mention order;
 *     empty for a plain (no-mention) message, which the dispatcher routes to
 *     the lead instead.
 *   - `triggeredByTurnId` — the turn whose @-mention caused this one to be
 *     created. Distinct from `parentTurnId` (the immediate reply-to used for
 *     transcript/hop-chain ordering): in the common single-mention case the
 *     two agree, but `chat.continue` resuming a hop-capped chain sets
 *     `parentTurnId` to the chain's *last* turn while `triggeredByTurnId`
 *     keeps pointing at the mention that actually started it.
 *   - `speakerLabel` — the rendered round-table header (e.g. `"@codex"`),
 *     fixed at creation so a later agent rename never rewrites history; also
 *     what a stateful backend's replayed context prepends per SPEC R23
 *     (`"[@codex]: ..."`, see ADR-0002).
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
  mentions: z.array(z.string().min(1)).default([]),
  triggeredByTurnId: z.string().min(1).nullable().optional(),
  speakerLabel: z.string().optional(),
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
  /**
   * Set when this block was produced by a *delegated* sub-agent (SPEC R12)
   * streaming into its parent agent's own turn: the sub-agent's label. Two
   * things need it and neither can recover it afterwards — the transcript,
   * which must not present another model's answer as the lead's own, and
   * `RoundTable`'s `textOfTurn`, which must not fold a sub-agent's whole
   * output into the reply it hands the next hop (SPEC R23).
   *
   * Absent (not `null`) on every block an agent wrote itself, so an old row
   * parses unchanged and `"delegatedFrom" in block` is the whole test.
   */
  delegatedFrom: z.string().min(1).optional(),
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
  /**
   * The result carried an MCP App UI and a `widget` block rendered it (R31:
   * "Non-App tool results keep the tool-call card" — an App result does not).
   * Set by the session runner only once the widget's HTML actually resolved to
   * `ready`, so a widget that turns out to be unavailable still leaves the
   * ordinary tool card standing rather than hiding the result entirely.
   */
  hasWidget: z.boolean().optional(),
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
  /**
   * `cancelled` when the request was torn down without an answer — the turn was
   * interrupted, or the app quit while the card was open (R32). Without it an
   * interrupted question resolved with an empty answer map, and `{}` is truthy,
   * so the card flipped to a green "Submitted" with an empty list: capygen
   * telling the user their answer went through when they had just cancelled.
   * Left optional (no default) so every existing row and fixture keeps its
   * exact shape; absent means "pending or answered", read off `answers`.
   */
  status: z.enum(["pending", "answered", "cancelled"]).optional(),
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
  /** The top-level agent that spawned this sub-agent — the parent link the
   *  agent tree (R13) draws, distinct from `agentId` (which, when a routed
   *  sub-agent is itself promoted to a tracked `Agent` row, names *that*
   *  row rather than its spawner). */
  parentAgentId: z.string().nullable().optional(),
  name: z.string(),
  backend: BackendSchema.nullable().default(null),
  model: z.string().nullable().default(null),
  description: z.string().default(""),
  status: z.enum(["spawned", "running", "done", "error"]).default("spawned"),
  /** This sub-agent's own model-call cost, when the harness reports one. */
  costUsd: z.number().nonnegative().optional(),
  /** True when the routing policy (R12) re-homed this spawn onto a different
   *  backend/model via capygen's own delegation, rather than the parent
   *  backend running it natively on its own model. */
  delegated: z.boolean().optional(),
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

/**
 * `settings.set`'s input. **Not** `SettingsSchema.partial()` (a bug fixed
 * alongside the Phase 4 additions in this file): every field above carries a
 * `.default(...)`, and this codebase runs zod with `z.config({jitless:
 * true})` (`zodRuntime.ts`, required by the renderer's CSP — no `new
 * Function`). Under jitless, wrapping a `.default()` field in `.optional()`
 * — exactly what `.partial()` does — does **not** suppress the default for
 * an omitted key the way it does with zod's normal (JIT) parser: the key
 * comes back filled with the default anyway (verified live against this
 * package's own zod: `SettingsSchema.partial().parse({theme:"dark"})`
 * returned all nine fields, not one). `SettingsRepo.patch` does
 * `{ ...this.all(), ...patch }`, so every call to `settings.set` — including
 * one that only meant to flip `theme` — was silently resetting
 * `defaultModel`, `hopCap` and every other field back to the shipping
 * default. Every field is spelled out default-free here instead, the same
 * fix `AgentPatchSchema`/`SessionSettingsPatchSchema` apply for their own
 * defaulted fields.
 */
export const SettingsPatchSchema = z.object({
  theme: ThemeSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  defaultBackend: BackendSchema.optional(),
  defaultModel: z.string().optional(),
  compactionThreshold: z.number().min(0.1).max(0.95).optional(),
  hopCap: z.number().int().min(1).max(20).optional(),
  closeToTray: z.boolean().optional(),
  showThinking: z.boolean().optional(),
  uiFontSize: z.number().int().min(10).max(22).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

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

// ---------------------------------------------------------------------------
// Agent info (`agents.describe` IPC) — the Claude-Code-style usage
// description an agent's info card shows (SPEC R13).
// ---------------------------------------------------------------------------

/**
 * Token/cost summary for one agent's info card. Deliberately its own shape,
 * not `UsageTotalsSchema`: this is a compact display summary (SPEC R13's
 * "cost so far"), not the accounting row `usage_events` stores, and `cached`
 * collapses `UsageTotals`' separate `cacheReadTokens`/`cacheCreationTokens`
 * into the one number a card actually shows.
 */
export const AgentUsageSummarySchema = z.object({
  input: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cached: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});
export type AgentUsageSummary = z.infer<typeof AgentUsageSummarySchema>;

/** One row of `AgentDescribe.others` — the session's other agents, for the
 *  "who else is here" listing next to an agent's own info (SPEC R13). */
export const AgentDescribeOtherSchema = z.object({
  agentId: z.string().min(1),
  mentionName: MentionNameSchema,
  backend: BackendSchema,
  model: z.string().min(1),
});
export type AgentDescribeOther = z.infer<typeof AgentDescribeOtherSchema>;

/**
 * `agents.describe` IPC output — an agent's orchestrator role, capabilities,
 * tools, model, cost so far, and a listing of the session's other agents
 * (SPEC R13). `capabilities`/`tools` are names only (e.g. a `HarnessCapabilities`
 * flag that is true, or a live MCP tool listing); the harness that actually
 * knows them is an `@capygen/engine` concept this package does not depend on,
 * so a caller with no live harness (or one that has not reported yet) returns
 * both empty rather than guessing.
 */
export const AgentDescribeSchema = z.object({
  description: z.string().default(""),
  capabilities: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  model: z.string(),
  backend: BackendSchema,
  usage: AgentUsageSummarySchema,
  others: z.array(AgentDescribeOtherSchema).default([]),
});
export type AgentDescribe = z.infer<typeof AgentDescribeSchema>;

// ---------------------------------------------------------------------------
// Workspace panes (Phase 5, SPEC R16-R18) — dockable panes, per-project
// layout, dev servers, tasks, terminals, and the fs/git primitives the Files
// and Diff panes read. Migration 0004 (`@capygen/db`) is the physical home
// for `WorkspaceLayout`, `DevServer` and `Task`; `TerminalInfo` is a live-only
// shape (see its own doc comment for why nothing persists it).
// ---------------------------------------------------------------------------

/** A dockable workspace panel (CONTEXT.md §Pane). */
export const PaneKindSchema = z.enum([
  "files",
  "editor",
  "diff",
  "browser",
  "terminal",
  "agents",
  "tasks",
  "servers",
]);
export type PaneKind = z.infer<typeof PaneKindSchema>;
export const PANE_KINDS = PaneKindSchema.options;

/**
 * One project's saved dockview arrangement (R17: "layout is saved per
 * project"). `layoutJson` is dockview's own `SerializedDockview` — opaque to
 * capygen, round-tripped whole through `DockviewApi.fromJSON`/`toJSON()` — so
 * it is `unknown` here rather than modelled field-by-field; the workspace
 * shell (Phase 5 Build) owns its actual shape.
 *
 * Distinct from `Project.layout` (a leftover free-form slot from Phase 2,
 * unused since no pane system existed yet): this table is the one both
 * `layout.get`/`layout.set` and the workspace host actually read and write.
 */
export const WorkspaceLayoutSchema = z.object({
  projectId: z.string().min(1),
  layoutJson: z.unknown(),
  updatedAt: TimestampSchema,
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;

/** Where a dev server's definition came from (R18's four detectors, plus a
 *  user-entered one). */
export const DevServerSourceSchema = z.enum([
  "launch.json",
  "package.json",
  "python",
  "docker-compose",
  "custom",
]);
export type DevServerSource = z.infer<typeof DevServerSourceSchema>;

/**
 * A detected or hand-entered long-running dev process (CONTEXT.md §Dev
 * server). `port`/`url` are filled in once known — a freshly detected
 * `package.json` script may have neither until its first successful start
 * discovers them (stdout URL, or a port probe), at which point the detector
 * persists them back onto this row so the next `servers.list` already knows.
 */
export const DevServerSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  source: DevServerSourceSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type DevServer = z.infer<typeof DevServerSchema>;

/** Creation input for `servers.saveCustom` — `id`/`projectId` are assigned by
 *  the repo; `source` defaults to `"custom"` since every other source is
 *  minted by a detector, never typed in by hand. */
export const DevServerDraftSchema = z.object({
  name: z.string().min(1),
  source: DevServerSourceSchema.default("custom"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type DevServerDraft = z.infer<typeof DevServerDraftSchema>;

/** Merge-patch input for updating a saved `DevServer` definition (e.g. a
 *  detector filling in the `port`/`url` it just discovered). Hand-written,
 *  no defaults — see `AgentPatchSchema`'s doc comment for why a `.default()`
 *  field (`args`) must never be wrapped in `.partial()`'s `.optional()`. */
export const DevServerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  port: z.number().int().positive().nullable().optional(),
  url: z.string().min(1).nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
});
export type DevServerPatch = z.infer<typeof DevServerPatchSchema>;

/** A dev server's live process state — held in memory by the desktop's
 *  `DevServerService` (Phase 5 Build), never persisted: a `pid` from the last
 *  run is meaningless after a restart, and `dev_servers` (migration 0004)
 *  stores only the server's *definition*. `servers.status` events and
 *  `servers.list`/`.start`/`.stop` responses are this shape's only home. */
export const DevServerRunStatusSchema = z.enum(["starting", "running", "stopped", "failed"]);
export type DevServerRunStatus = z.infer<typeof DevServerRunStatusSchema>;

export const DevServerRunSchema = z.object({
  serverId: z.string().min(1),
  status: DevServerRunStatusSchema,
  pid: z.number().int().optional(),
  url: z.string().min(1).optional(),
  startedAt: TimestampSchema.optional(),
  exitCode: z.number().int().optional(),
});
export type DevServerRun = z.infer<typeof DevServerRunSchema>;

/** A `DevServer` definition paired with its current (possibly absent) live
 *  run — what the Servers pane actually renders one row from. */
export const DevServerWithRunSchema = z.object({
  server: DevServerSchema,
  run: DevServerRunSchema.nullable(),
});
export type DevServerWithRun = z.infer<typeof DevServerWithRunSchema>;

/** Where a `Task` row came from (CONTEXT.md's agent-derived plan surfaces,
 *  plus a user-typed one). */
export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSourceSchema = z.enum(["todo_write", "codex_plan", "manual"]);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/**
 * One item in the Tasks pane / Tasks page (P10): an agent's own plan item
 * (Claude `TodoWrite`, a Codex plan turn) or a manually added one.
 * `sessionId`/`agentId` are nullable, not merely optional — a manually added
 * task may belong to neither, and the derivation service that upserts one
 * from a `TodoWrite` call always has both, so the column is genuinely absent
 * rather than "not sent this time" (the same distinction `Turn.agentId`/
 * `Session.leadAgentId` already draw elsewhere in this file).
 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).nullable().default(null),
  agentId: z.string().min(1).nullable().default(null),
  title: z.string().min(1),
  status: TaskStatusSchema.default("pending"),
  source: TaskSourceSchema.default("manual"),
  /** Display order within its session/list; agent-derived tasks keep the
   *  todo list's own order. */
  order: z.number().int().nonnegative().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * `tasks.update`'s patch. Hand-written, no defaults — same jitless-defaults
 * hazard `AgentPatchSchema` documents (`status`/`source`/`order` all carry
 * `.default()` on `TaskSchema`). `source` and `sessionId` are deliberately
 * excluded: which derivation produced a task, and which session it belongs
 * to, are identity facts fixed at creation, not user-editable fields.
 */
export const TaskPatchSchema = z.object({
  title: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  agentId: z.string().min(1).nullable().optional(),
  order: z.number().int().nonnegative().optional(),
});
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/**
 * A live terminal session (CONTEXT.md, R16). **Not persisted** — migration
 * 0004 deliberately has no `terminals` table. A `node-pty` process is a live
 * OS handle: it does not survive the app closing, so a row surviving a
 * restart would describe a terminal that no longer exists, and the composer
 * would have nothing to reconnect it to (unlike a dev server, which at least
 * has a definition worth keeping). `TerminalService` (Phase 5 Build) holds
 * these in memory only; `terminal.list` answers from that registry, not SQL.
 */
export const TerminalInfoSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1).nullable().default(null),
  title: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

/** One row in the Files pane's tree (R16). */
export const FileEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative().optional(),
  mtime: TimestampSchema.optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** `fs.list`/`fs.search`'s shared shape: bounded per SPEC R23-R26 ("file
 *  watchers bounded ... depth/size caps"), so `truncated` says outright when
 *  a directory or a search hit the cap rather than the caller inferring it
 *  from a suspiciously round count. */
export const FileListResultSchema = z.object({
  entries: z.array(FileEntrySchema).default([]),
  truncated: z.boolean().default(false),
});
export type FileListResult = z.infer<typeof FileListResultSchema>;

/** `fs.read`'s result. `binary` files still return `content` (base64, per
 *  `encoding`) rather than refusing outright — the Editor pane opens them
 *  read-only instead of failing the call. */
export const FileReadResultSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  size: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  binary: z.boolean().default(false),
});
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

/** One chokidar event, batched into `fs.changed` (R23: debounced, never
 *  raw per-event noise into the model's context — this event is UI-only). */
export const FileChangeKindSchema = z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

export const FileChangeSchema = z.object({
  path: z.string().min(1),
  kind: FileChangeKindSchema,
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/** One row of `git.status`'s working tree (porcelain-style short status
 *  code, e.g. `"M"`, `"??"`, `"A"` — free-form rather than a fixed enum since
 *  the exact vocabulary is `simple-git`'s/`git`'s own). */
export const GitStatusEntrySchema = z.object({
  path: z.string().min(1),
  status: z.string().min(1),
});
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;

/** A project's git status, or `null` when it is not a repository at all
 *  (`git.status`'s IPC output is `GitStatusSchema.nullable()` — "safe on
 *  non-repos" per the Phase 5 workflow brief, not an error). */
export const GitStatusSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.array(GitStatusEntrySchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

/** One file's unified diff (Diff pane, R16). `binary` files carry an empty
 *  `unified` and the flag rather than a patch the renderer cannot show. */
export const GitDiffSchema = z.object({
  path: z.string().min(1),
  unified: z.string(),
  binary: z.boolean().optional(),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;

/** A rectangle in the renderer's own coordinate space — how the Browser
 *  pane's placeholder tells the main-process `WebContentsView` where to sit
 *  (`browser.attach`/`.setBounds`; Omnigent's own pattern, not `<webview>`). */
export const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type Bounds = z.infer<typeof BoundsSchema>;

// ---------------------------------------------------------------------------
// Phase 6: Settings hub, integrations, prerequisites (SPEC R3, R19-R21,
// R28-R30). Three families:
//
//   * GlobalSettings — one versioned object, sectioned (general, appearance,
//     git, shortcuts, notifications, updates, efficiency) plus a few
//     top-level flags and per-backend *defaults*. It is additive alongside
//     the flat `SettingsSchema` above (Phase 2's shipping settings surface —
//     still what `SessionRunner`, `appStore` and `DevWorkspacePage` read via
//     `settings.get`/`.set`; this pass does not migrate those call sites): a
//     fresh `GlobalSettingsSchema.parse({})` and `DEFAULT_SETTINGS` overlap
//     on a few concepts (theme, default backend/model, close-to-tray) by
//     design, and `GlobalSettingsRepo` (`@capygen/db`) stores the whole
//     object under one more `settings` key/value row rather than a new
//     table — see migration 0005's header for why no schema change was
//     needed for this part. Layering (R30, the same idea R12 already
//     established for sub-agent routing): **global**
//     (`GlobalSettings.backends.<backend>`) is the floor every agent on that
//     backend starts from; a **per-agent** override (`Agent.config.<backend>`,
//     shipped in Phase 3) wins field-by-field wherever both set the same key,
//     and a harness that finds neither falls back to its own hardcoded
//     default exactly as it does today. Neither layer is a full harness
//     config — `ClaudeAgentConfigSchema`/`CodexAgentConfigSchema`/
//     `ApiAgentConfigSchema` above stay the full per-agent shape;
//     `GlobalBackendDefaultsSchema` below is deliberately a narrower subset
//     (SPEC's own field list) since only fields a *global* default makes
//     sense for belong there.
//   * Integrations — `McpServerEntry`, `PluginEntry`, `SkillEntry`,
//     `ToolPolicyEntry`: what Settings ▸ Integrations lists per backend
//     (R28). The backend's own config file (or live listing) is the source
//     of truth (R29) — these are capygen's read model of it, cached in
//     `@capygen/db`'s existing `mcp_servers`/`plugins`/`skills`/`policies`
//     tables (migration 0001; migration 0005 adds the `backend` column two
//     of those four were missing).
//   * Prerequisites/diagnostics — `PrereqStep` (the setup panel, R3) and
//     `DiagnosticsInfoSchema` (Settings ▸ Diagnostics) are live-probed, not
//     persisted; no repo owns either.
// ---------------------------------------------------------------------------

export const GlobalGeneralSchema = z
  .object({
    defaultBackend: BackendSchema.default("claude"),
    defaultModel: z.string().default("claude-opus-4-5"),
    submitWithCtrlEnter: z.boolean().default(false),
    alwaysSteer: z.boolean().default(false),
    autoTitleSessions: z.boolean().default(true),
  })
  .passthrough();
export type GlobalGeneral = z.infer<typeof GlobalGeneralSchema>;

/** Hand-written, no defaults — the same jitless-defaults hazard
 *  `SettingsPatchSchema` documents: every field above carries a `.default()`,
 *  so `GlobalGeneralSchema.partial()` would fill an omitted key with its
 *  default instead of leaving it absent under this codebase's mandatory
 *  `z.config({jitless:true})`. */
export const GlobalGeneralPatchSchema = z
  .object({
    defaultBackend: BackendSchema.optional(),
    defaultModel: z.string().optional(),
    submitWithCtrlEnter: z.boolean().optional(),
    alwaysSteer: z.boolean().optional(),
    autoTitleSessions: z.boolean().optional(),
  })
  .passthrough();
export type GlobalGeneralPatch = z.infer<typeof GlobalGeneralPatchSchema>;

export const GlobalAppearanceSchema = z
  .object({
    theme: ThemeSchema.default("system"),
    /** Free-form palette id (Omnigent ships several named palettes); not
     *  enumerated here so a new palette ships without a schema change. */
    palette: z.string().min(1).default("default"),
    /** Multiplier on the base UI font size — distinct from `SettingsSchema`
     *  above's `uiFontSize`, which is an absolute pixel value. */
    fontScale: z.number().min(0.75).max(1.5).default(1),
    reducedMotion: z.boolean().default(false),
  })
  .passthrough();
export type GlobalAppearance = z.infer<typeof GlobalAppearanceSchema>;

export const GlobalAppearancePatchSchema = z
  .object({
    theme: ThemeSchema.optional(),
    palette: z.string().min(1).optional(),
    fontScale: z.number().min(0.75).max(1.5).optional(),
    reducedMotion: z.boolean().optional(),
  })
  .passthrough();
export type GlobalAppearancePatch = z.infer<typeof GlobalAppearancePatchSchema>;

export const GlobalGitSchema = z
  .object({
    /** Auto-generate a commit message from the diff when an agent commits.
     *  Unset (not merely `false`) means "ask each time" rather than a fixed
     *  policy — the only field in this file that stays genuinely optional in
     *  its *full* shape, per SPEC's own `autoCommitMessages?`. */
    autoCommitMessages: z.boolean().optional(),
    /** Whether a new session defaults to running in its own worktree (P8). */
    worktreeDefault: z.boolean().default(false),
  })
  .passthrough();
export type GlobalGit = z.infer<typeof GlobalGitSchema>;

export const GlobalGitPatchSchema = z
  .object({
    autoCommitMessages: z.boolean().optional(),
    worktreeDefault: z.boolean().optional(),
  })
  .passthrough();
export type GlobalGitPatch = z.infer<typeof GlobalGitPatchSchema>;

export const GlobalShortcutsSchema = z
  .object({
    /** Keybinding id → key combo string, overriding the shipped default. */
    overrides: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
export type GlobalShortcuts = z.infer<typeof GlobalShortcutsSchema>;

/** Whole-map replace, not a per-key merge: the Shortcuts settings page always
 *  submits its full table, and there is no way to express "delete this
 *  override" inside a record that gets merged key-by-key. See
 *  `mergeGlobalSettingsPatch`, the one place this distinction matters. */
export const GlobalShortcutsPatchSchema = z
  .object({
    overrides: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export type GlobalShortcutsPatch = z.infer<typeof GlobalShortcutsPatchSchema>;

export const GlobalNotificationsSchema = z
  .object({
    enabled: z.boolean().default(true),
    onFinish: z.boolean().default(true),
    onNeedsInput: z.boolean().default(true),
    onRunnerDisconnect: z.boolean().default(true),
  })
  .passthrough();
export type GlobalNotifications = z.infer<typeof GlobalNotificationsSchema>;

export const GlobalNotificationsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    onFinish: z.boolean().optional(),
    onNeedsInput: z.boolean().optional(),
    onRunnerDisconnect: z.boolean().optional(),
  })
  .passthrough();
export type GlobalNotificationsPatch = z.infer<typeof GlobalNotificationsPatchSchema>;

export const UpdateModeSchema = z.enum(["automatic", "at-launch", "manual", "never"]);
export type UpdateMode = z.infer<typeof UpdateModeSchema>;

export const GlobalUpdatesSchema = z
  .object({
    mode: UpdateModeSchema.default("at-launch"),
    /** Install a downloaded update on quit rather than immediately (R4:
     *  "never install without an explicit click" — quitting is that click
     *  when this is on). */
    installOnQuit: z.boolean().default(false),
  })
  .passthrough();
export type GlobalUpdates = z.infer<typeof GlobalUpdatesSchema>;

export const GlobalUpdatesPatchSchema = z
  .object({
    mode: UpdateModeSchema.optional(),
    installOnQuit: z.boolean().optional(),
  })
  .passthrough();
export type GlobalUpdatesPatch = z.infer<typeof GlobalUpdatesPatchSchema>;

export const GlobalEfficiencySchema = z
  .object({
    /** Percent (not the 0-1 fraction `SettingsSchema.compactionThreshold`
     *  above uses) at which compaction is offered/auto-run (R25). */
    compactionThresholdPct: z.number().int().min(10).max(95).default(70),
    /** KB above which a tool output is stored whole but sent to the model
     *  truncated with an expandable stub (R25, SPEC §Edge Cases). */
    toolOutputCapKb: z.number().int().positive().default(64),
    /** Load MCP tool schemas on first listing rather than eagerly (R26). */
    lazyMcpSchemas: z.boolean().default(true),
  })
  .passthrough();
export type GlobalEfficiency = z.infer<typeof GlobalEfficiencySchema>;

export const GlobalEfficiencyPatchSchema = z
  .object({
    compactionThresholdPct: z.number().int().min(10).max(95).optional(),
    toolOutputCapKb: z.number().int().positive().optional(),
    lazyMcpSchemas: z.boolean().optional(),
  })
  .passthrough();
export type GlobalEfficiencyPatch = z.infer<typeof GlobalEfficiencyPatchSchema>;

export const GlobalClaudeDefaultsSchema = z
  .object({
    permissionMode: PermissionModeSchema.optional(),
    /** Free-form preset name for the `/effort` built-in, same vocabulary as
     *  `ClaudeAgentConfig.effort`. */
    effort: z.string().optional(),
  })
  .passthrough();
export type GlobalClaudeDefaults = z.infer<typeof GlobalClaudeDefaultsSchema>;

export const GlobalCodexDefaultsSchema = z
  .object({
    approvalPolicy: CodexApprovalPolicySchema.optional(),
    sandbox: CodexSandboxModeSchema.optional(),
    reasoningEffort: z.string().optional(),
  })
  .passthrough();
export type GlobalCodexDefaults = z.infer<typeof GlobalCodexDefaultsSchema>;

export const GlobalApiDefaultsSchema = z
  .object({
    provider: ApiProviderSchema.optional(),
    model: z.string().optional(),
  })
  .passthrough();
export type GlobalApiDefaults = z.infer<typeof GlobalApiDefaultsSchema>;

/**
 * Per-backend *global* defaults (R30) — the middle layer of "global →
 * backend default → agent override". Every field is independently optional:
 * an unset one means "no global opinion", the same way an absent
 * `Agent.config.<backend>` field already falls back to the harness's own
 * hardcoded default. None of the three inner schemas carries a `.default()`
 * on any field, so — unlike every section above — wrapping them in
 * `.optional()` for a patch (below) needs no hand-written twin; there is no
 * default for `.optional()` to accidentally unmask.
 */
export const GlobalBackendDefaultsSchema = z
  .object({
    claude: GlobalClaudeDefaultsSchema.default(() => GlobalClaudeDefaultsSchema.parse({})),
    codex: GlobalCodexDefaultsSchema.default(() => GlobalCodexDefaultsSchema.parse({})),
    api: GlobalApiDefaultsSchema.default(() => GlobalApiDefaultsSchema.parse({})),
  })
  .passthrough();
export type GlobalBackendDefaults = z.infer<typeof GlobalBackendDefaultsSchema>;

export const GlobalBackendDefaultsPatchSchema = z
  .object({
    claude: GlobalClaudeDefaultsSchema.optional(),
    codex: GlobalCodexDefaultsSchema.optional(),
    api: GlobalApiDefaultsSchema.optional(),
  })
  .passthrough();
export type GlobalBackendDefaultsPatch = z.infer<typeof GlobalBackendDefaultsPatchSchema>;

export const GlobalSettingsSectionSchema = z.enum([
  "general",
  "appearance",
  "git",
  "shortcuts",
  "notifications",
  "updates",
  "efficiency",
  "backends",
  "all",
]);
export type GlobalSettingsSection = z.infer<typeof GlobalSettingsSectionSchema>;

export const GlobalSettingsSchema = z
  .object({
    /** Bumped whenever this shape changes incompatibly; lets
     *  `GlobalSettingsRepo` tell a stale stored blob apart from a
     *  merely-partial one without a new SQL migration — the whole object
     *  lives in one `settings` key/value row (migration 0005's header). */
    version: z.number().int().positive().default(1),
    general: GlobalGeneralSchema.default(() => GlobalGeneralSchema.parse({})),
    appearance: GlobalAppearanceSchema.default(() => GlobalAppearanceSchema.parse({})),
    git: GlobalGitSchema.default(() => GlobalGitSchema.parse({})),
    shortcuts: GlobalShortcutsSchema.default(() => GlobalShortcutsSchema.parse({})),
    notifications: GlobalNotificationsSchema.default(() => GlobalNotificationsSchema.parse({})),
    updates: GlobalUpdatesSchema.default(() => GlobalUpdatesSchema.parse({})),
    efficiency: GlobalEfficiencySchema.default(() => GlobalEfficiencySchema.parse({})),
    backends: GlobalBackendDefaultsSchema.default(() => GlobalBackendDefaultsSchema.parse({})),
    closeToTray: z.boolean().default(true),
    startWithWindows: z.boolean().default(false),
    /** Always false — capygen sends no telemetry (local-only app, SPEC
     *  scope). A fixed literal, not a plain boolean, so nothing can flip it
     *  by accident; `GlobalSettingsPatchSchema` does not even accept this
     *  key (see its doc comment) so there is no patch path that could try. */
    telemetry: z.literal(false).default(false),
  })
  .passthrough();
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = GlobalSettingsSchema.parse({});

/**
 * `settings.patch`'s input. Hand-written and section-shaped rather than a
 * deep `.partial()`, for the same jitless-defaults reason `SettingsPatchSchema`
 * documents, one level deeper: every leaf in every section above carries a
 * `.default()`, so naively wrapping the whole tree in `.optional()` would
 * make an omitted leaf come back filled with its default instead of staying
 * absent — and `mergeGlobalSettingsPatch` below would then "merge" that
 * default straight over whatever the user had actually set. `version` and
 * `telemetry` are deliberately absent: the shape version is not something a
 * settings page edits, and telemetry is fixed off.
 */
export const GlobalSettingsPatchSchema = z
  .object({
    general: GlobalGeneralPatchSchema.optional(),
    appearance: GlobalAppearancePatchSchema.optional(),
    git: GlobalGitPatchSchema.optional(),
    shortcuts: GlobalShortcutsPatchSchema.optional(),
    notifications: GlobalNotificationsPatchSchema.optional(),
    updates: GlobalUpdatesPatchSchema.optional(),
    efficiency: GlobalEfficiencyPatchSchema.optional(),
    backends: GlobalBackendDefaultsPatchSchema.optional(),
    closeToTray: z.boolean().optional(),
    startWithWindows: z.boolean().optional(),
  })
  .passthrough();
export type GlobalSettingsPatch = z.infer<typeof GlobalSettingsPatchSchema>;

/**
 * Deep-merge a patch into a full `GlobalSettings` (SPEC's `settings.patch`:
 * "deep-merge, validated"). Each section is merged field-by-field against its
 * existing values rather than replaced wholesale — `{ ...existing, ...patch }`
 * alone would let a patch naming only `general.defaultModel` wipe out
 * `general.defaultBackend` by re-running that section through
 * `GlobalGeneralSchema`'s own defaults, the same hazard
 * `SessionsRepo.updateSettings` already avoids for `SessionSettings`.
 * `shortcuts.overrides` is the one deliberate exception — see
 * `GlobalShortcutsPatchSchema`'s doc comment for why it replaces instead of
 * merging key-by-key.
 */
export function mergeGlobalSettingsPatch(
  existing: GlobalSettings,
  patch: GlobalSettingsPatch,
): GlobalSettings {
  return GlobalSettingsSchema.parse({
    ...existing,
    ...patch,
    general: { ...existing.general, ...patch.general },
    appearance: { ...existing.appearance, ...patch.appearance },
    git: { ...existing.git, ...patch.git },
    shortcuts: patch.shortcuts
      ? { overrides: patch.shortcuts.overrides ?? existing.shortcuts.overrides }
      : existing.shortcuts,
    notifications: { ...existing.notifications, ...patch.notifications },
    updates: { ...existing.updates, ...patch.updates },
    efficiency: { ...existing.efficiency, ...patch.efficiency },
    backends: {
      claude: { ...existing.backends.claude, ...patch.backends?.claude },
      codex: { ...existing.backends.codex, ...patch.backends?.codex },
      api: { ...existing.backends.api, ...patch.backends?.api },
    },
  });
}

/** `settings.reset`'s section → the shipping default for just that slice, or
 *  the whole object for `"all"`. */
export function resetGlobalSettingsSection(
  existing: GlobalSettings,
  section: GlobalSettingsSection,
): GlobalSettings {
  if (section === "all") return DEFAULT_GLOBAL_SETTINGS;
  return GlobalSettingsSchema.parse({ ...existing, [section]: DEFAULT_GLOBAL_SETTINGS[section] });
}

// ---------------------------------------------------------------------------
// Integrations (Phase 6, SPEC R28-R29) — MCP servers, plugins, skills, and
// per-tool policies, for every backend.
// ---------------------------------------------------------------------------

export const McpTransportSchema = z.enum(["stdio", "http", "sse", "claudeai-proxy"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerScopeSchema = z.enum(["user", "project", "local", "plugin"]);
export type McpServerScope = z.infer<typeof McpServerScopeSchema>;

export const McpServerStatusSchema = z.enum(["connected", "failed", "needs-auth", "unknown"]);
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/**
 * One MCP server as Settings ▸ Integrations lists it (R28). `source` is
 * either the config file this entry was read from (`.mcp.json`,
 * `~/.claude/settings.json`, `~/.codex/config.toml` — COMPAT.md's config
 * sources table) or the literal `"live"` when the backend only reported it at
 * runtime (`system/init.mcp_servers`, `mcpServerStatus/list`) with no file to
 * point the user at. No `id` field: `backend`+`scope`+`name` is the natural
 * key — `.update`/`.remove`/`.test` all address one entry by those fields
 * rather than a synthetic id, and `McpServersRepo` mints its row id from
 * exactly that triple.
 */
export const McpServerEntrySchema = z
  .object({
    backend: BackendSchema,
    name: z.string().min(1),
    transport: McpTransportSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    scope: McpServerScopeSchema,
    source: z.string().min(1),
    enabled: z.boolean().default(true),
    status: McpServerStatusSchema.optional(),
    tools: z.array(z.string()).optional(),
    /** True when this row is only *visible* to `backend` because another
     *  backend's config declares it (`ApiConfigStore.inheritedServers`) — the
     *  store that owns it refuses every write, so the settings page offers no
     *  Edit/Remove for one. */
    inherited: z.boolean().optional(),
  })
  .passthrough();
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/** `integrations.mcp.add`'s `entry` — `backend`/`scope` travel as the call's
 *  own top-level fields (matching `.update`/`.remove`/`.test`, which all
 *  address an entry the same way) rather than being duplicated inside it. */
export const McpServerEntryDraftSchema = z
  .object({
    name: z.string().min(1),
    transport: McpTransportSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    source: z.string().min(1),
    enabled: z.boolean().optional(),
    status: McpServerStatusSchema.optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();
export type McpServerEntryDraft = z.infer<typeof McpServerEntryDraftSchema>;

/** `integrations.mcp.update`'s patch. `name`/`transport`/`source` stay
 *  patchable — nothing here is an identity field the way `backend`/`scope`
 *  are for `McpServerEntry` (those two are the call's own top-level fields,
 *  same as `.add`). */
export const McpServerEntryPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    transport: McpTransportSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    source: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    status: McpServerStatusSchema.optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();
export type McpServerEntryPatch = z.infer<typeof McpServerEntryPatchSchema>;

export const PluginEntrySchema = z
  .object({
    backend: BackendSchema,
    name: z.string().min(1),
    version: z.string().optional(),
    marketplace: z.string().optional(),
    enabled: z.boolean().default(true),
    installed: z.boolean().default(true),
    path: z.string().optional(),
    commands: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    source: z.string().min(1),
  })
  .passthrough();
export type PluginEntry = z.infer<typeof PluginEntrySchema>;

/** One row of `integrations.plugin.marketplaces` — a registered marketplace
 *  source (`claude plugin marketplace list`/`add` and Codex's equivalent). */
export const PluginMarketplaceEntrySchema = z
  .object({
    name: z.string().min(1),
    url: z.string().optional(),
    source: z.string().min(1),
  })
  .passthrough();
export type PluginMarketplaceEntry = z.infer<typeof PluginMarketplaceEntrySchema>;

export const SkillScopeSchema = z.enum(["user", "project", "plugin"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillEntrySchema = z
  .object({
    backend: BackendSchema,
    name: z.string().min(1),
    scope: SkillScopeSchema,
    path: z.string().min(1),
    pluginName: z.string().optional(),
    enabled: z.boolean().default(true),
    description: z.string().optional(),
  })
  .passthrough();
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const ToolPolicyDecisionSchema = z.enum(["allow", "deny", "ask"]);
export type ToolPolicyDecision = z.infer<typeof ToolPolicyDecisionSchema>;

/** Where a tool policy applies. Distinct from `McpServerScopeSchema`: a tool
 *  permission is either the app-wide default for a backend, narrowed to one
 *  project, or narrowed to one running session — it is not tied to a config
 *  file's location the way an MCP server/skill scope is. Phase 9's fuller
 *  Policies page (P17) may grow a `sessionId`/`projectId` alongside this
 *  value; this pass only needs the enum SPEC's own field list names. */
export const ToolPolicyScopeSchema = z.enum(["global", "project", "session"]);
export type ToolPolicyScope = z.infer<typeof ToolPolicyScopeSchema>;

export const ToolPolicyEntrySchema = z
  .object({
    backend: BackendSchema,
    pattern: z.string().min(1),
    decision: ToolPolicyDecisionSchema,
    scope: ToolPolicyScopeSchema,
  })
  .passthrough();
export type ToolPolicyEntry = z.infer<typeof ToolPolicyEntrySchema>;

// ---------------------------------------------------------------------------
// Prerequisites and diagnostics (Phase 6, SPEC R3) — both live-probed, never
// persisted: a cached "detected" bit would be stale the moment the user
// installs the thing capygen is telling them to install.
// ---------------------------------------------------------------------------

export const PrereqStepKindSchema = z.enum(["cli", "runtime", "tool"]);
export type PrereqStepKind = z.infer<typeof PrereqStepKindSchema>;

/**
 * One row of the setup panel (R3): "one button per step that confirms the
 * exact command and runs it in a visible console; nothing is ever installed
 * silently" (CLAUDE.md). `prereqs.status` re-detects on every call, the same
 * way `harness.list` re-probes the CLIs rather than trusting a stale row.
 */
export const PrereqStepSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    detected: z.boolean(),
    version: z.string().optional(),
    command: z.string().min(1),
    description: z.string().default(""),
    /** Ids of other steps that must be `detected` first (e.g. Codex before a
     *  Codex-only step) — `prereqs.run` refuses a step whose `blockedBy` is
     *  not yet all satisfied rather than running commands out of order. */
    blockedBy: z.array(z.string()).optional(),
    kind: PrereqStepKindSchema,
  })
  .passthrough();
export type PrereqStep = z.infer<typeof PrereqStepSchema>;

export const HarnessAvailabilitySchema = z
  .object({
    backend: BackendSchema,
    available: z.boolean(),
    reason: z.string().optional(),
  })
  .passthrough();
export type HarnessAvailability = z.infer<typeof HarnessAvailabilitySchema>;

/** Settings ▸ Diagnostics' whole page (R19). `versions`/`paths` are free-form
 *  label→value maps (e.g. `{app, electron, node, claude, codex}` /
 *  `{userData, logFile, dbFile, claudeHome, codexHome}`) rather than fixed
 *  fields, so a new probe is an extra map entry, not a schema change. */
export const DiagnosticsInfoSchema = z
  .object({
    versions: z.record(z.string(), z.string()),
    paths: z.record(z.string(), z.string()),
    harnessAvailability: z.array(HarnessAvailabilitySchema),
    dbSizeBytes: z.number().int().nonnegative(),
    logDir: z.string().min(1),
  })
  .passthrough();
export type DiagnosticsInfo = z.infer<typeof DiagnosticsInfoSchema>;
