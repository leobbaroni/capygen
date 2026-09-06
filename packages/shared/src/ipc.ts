/**
 * The IPC contract. Two typed maps — `INVOKE_CHANNELS` (renderer → main,
 * request/response) and `EVENT_CHANNELS` (main → renderer, push) — are the only
 * way the two processes talk. Everything is a zod schema, so:
 *
 *   - preload validates what it sends and what comes back,
 *   - main validates what it receives from a renderer it must not trust,
 *   - the renderer gets full inference from the same declarations.
 *
 * Adding a channel means adding one line here; `defineIpc` and the main-process
 * registry both derive their types from these objects, so a missing handler is a
 * compile error rather than a runtime "no handler registered".
 */
import { z } from "zod";
import {
  AgentDraftSchema,
  AgentSchema,
  ApiProviderSchema,
  BlockSchema,
  HarnessInfoSchema,
  PermissionRequestSchema,
  ProjectSchema,
  QuestionSchema,
  SessionModeSchema,
  SessionSchema,
  SettingsSchema,
  SlashCommandSchema,
  TimestampSchema,
  ToolOutputSchema,
  TurnSchema,
  TurnStatusSchema,
  UsageEventSchema,
} from "./domain.js";

/** One request/response pair. */
export interface ChannelDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input: I;
  output: O;
}

function channel<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  input: I,
  output: O,
): ChannelDef<I, O> {
  return { input, output };
}

/**
 * Nothing to send. Modelled as an object so JSON survives the bridge; callers
 * pass `{}`. Not `.default({})` — zod 4 types a default by the schema's OUTPUT,
 * which for a schema whose fields carry their own defaults is not `{}`.
 */
const Empty = z.object({});

const OkSchema = z.object({ ok: z.boolean() });

// ---------------------------------------------------------------------------
// renderer → main (invoke)
// ---------------------------------------------------------------------------

export const INVOKE_CHANNELS = {
  /** Native folder picker; resolves to null when the user cancels. */
  "projects.pick": channel(Empty, ProjectSchema.nullable()),
  "projects.list": channel(Empty, z.array(ProjectSchema)),

  "sessions.create": channel(
    z.object({
      projectId: z.string().min(1),
      mode: SessionModeSchema.default("solo"),
      title: z.string().default(""),
      agents: z.array(AgentDraftSchema).default([]),
    }),
    z.object({ session: SessionSchema, agents: z.array(AgentSchema) }),
  ),
  "sessions.list": channel(
    z.object({
      projectId: z.string().min(1).optional(),
      includeArchived: z.boolean().default(false),
    }),
    z.array(SessionSchema),
  ),
  "sessions.get": channel(
    z.object({ sessionId: z.string().min(1) }),
    z
      .object({
        session: SessionSchema,
        agents: z.array(AgentSchema),
        turns: z.array(TurnSchema),
        blocks: z.array(BlockSchema),
      })
      .nullable(),
  ),
  "sessions.archive": channel(
    z.object({ sessionId: z.string().min(1), archived: z.boolean().default(true) }),
    SessionSchema,
  ),

  "turns.list": channel(
    z.object({ sessionId: z.string().min(1) }),
    z.object({ turns: z.array(TurnSchema), blocks: z.array(BlockSchema) }),
  ),

  /**
   * The whole value behind a truncated tool_call block's `outputRef` (R25's
   * "expandable" stub, for the case a harness moved the full value into
   * `tool_outputs` instead of keeping it on the block row as `fullOutput`).
   * `null` when the id is unknown (a relaunch against a different profile, or
   * a row a migration dropped) — the card says the full output is gone rather
   * than throwing.
   */
  "blocks.getOutput": channel(
    z.object({ id: z.string().min(1) }),
    ToolOutputSchema.nullable(),
  ),

  /**
   * Raw `usage_events` rows for a session (R23) — the session header meter
   * sums them, and a turn's `UsageLine` groups the ones matching its own
   * `turnId` for the per-model breakdown tooltip. Kept as the raw rows rather
   * than a pre-aggregated shape so both call sites can slice it differently
   * without two channels.
   */
  "turns.usage": channel(
    z.object({ sessionId: z.string().min(1) }),
    z.object({ events: z.array(UsageEventSchema) }),
  ),

  /** Submit a user message. Returns the user turn and the agent turn it started. */
  "chat.send": channel(
    z.object({
      sessionId: z.string().min(1),
      text: z.string(),
      /** Target agent in round-table mode; the lead when omitted. */
      agentId: z.string().min(1).nullable().default(null),
    }),
    z.object({ userTurnId: z.string(), agentTurnId: z.string() }),
  ),
  "chat.interrupt": channel(z.object({ sessionId: z.string().min(1) }), OkSchema),
  /**
   * Built-ins plus the backend's own commands/skills/plugins (R14). Scoped to
   * the agent that will receive the message — the session's lead unless
   * `agentId` names another — because in a round-table session two agents on
   * different backends offer different menus.
   */
  "chat.listCommands": channel(
    z.object({
      sessionId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
    }),
    z.array(SlashCommandSchema),
  ),

  /**
   * `decision` replaces the Phase 2 `behavior` field: `allow_always` (R28/R32
   * "remember this choice") is a third button alongside Allow/Deny, not a
   * variant of `scope`. A handler collapses it to `{behavior:"allow"}` for the
   * harness (which only ever needs to unblock the call) and `scope:"always"`
   * for the persisted decision — `PermissionDecisionSchema.behavior` in
   * `@capygen/shared` carries the full three-way value.
   */
  "permission.answer": channel(
    z.object({
      requestId: z.string().min(1),
      decision: z.enum(["allow", "allow_always", "deny"]),
      updatedInput: z.unknown().optional(),
      message: z.string().optional(),
      scope: z.enum(["once", "session", "always"]).default("once"),
    }),
    OkSchema,
  ),
  "question.answer": channel(
    z.object({
      requestId: z.string().min(1),
      /** question text → chosen option label (Phase 1 proven shape). */
      answers: z.record(z.string(), z.string()),
    }),
    OkSchema,
  ),

  /**
   * A backend's structured input request that is neither a permission prompt
   * nor `AskUserQuestion` — MCP `elicitation/create`, or a Codex user-input
   * request (R32). `null` answers means the user cancelled/declined.
   */
  "elicitation.answer": channel(
    z.object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      blockId: z.string().min(1),
      answers: z.record(z.string(), z.unknown()).nullable(),
    }),
    OkSchema,
  ),

  /** Backend/model availability for the New Session picker and Settings ▸ Harnesses. */
  "harness.list": channel(Empty, z.array(HarnessInfoSchema)),

  /**
   * API keys via Electron `safeStorage` (R21) — `secrets.has` is the only read
   * path; the value itself never crosses this bridge again once set.
   */
  "secrets.set": channel(
    z.object({ provider: ApiProviderSchema, value: z.string().min(1) }),
    OkSchema,
  ),
  /**
   * `source` says *where* the key came from, because "not set" was misleading:
   * the harness list treats `ANTHROPIC_API_KEY` & co. as a key too, so the
   * composer offered API models while Settings ▸ API keys said "Not set".
   * `stored` = the safeStorage file, `environment` = the documented env var.
   */
  "secrets.has": channel(
    z.object({ provider: ApiProviderSchema }),
    z.object({
      has: z.boolean(),
      source: z.enum(["stored", "environment", "none"]).default("none"),
    }),
  ),
  "secrets.delete": channel(z.object({ provider: ApiProviderSchema }), OkSchema),

  /** Read one MCP resource — how a widget's `ui://` HTML is fetched (R31, A13). */
  "mcp.readResource": channel(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1),
      serverName: z.string().min(1),
      uri: z.string().min(1),
    }),
    z.object({
      mimeType: z.string().optional(),
      text: z.string().optional(),
      /** Base64, when the resource is not text. */
      blob: z.string().optional(),
    }),
  ),

  /** A widget calls a tool through the host (ext-apps `ui/callTool` bridge, R31). */
  "widget.callTool": channel(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1),
      blockId: z.string().min(1),
      name: z.string().min(1),
      args: z.unknown(),
    }),
    z.unknown(),
  ),
  /**
   * Any other `ui/*` message a widget sends the host (size negotiation,
   * host-side actions such as Higgsfield's Animate/Edit/Download) — renderer
   * to main, for host-side handling. Widget *state* changes the other
   * direction ride the existing `chat.block` upsert event, same as any other
   * block; there is no separate `widget.update` event (see EVENT_CHANNELS).
   */
  "widget.event": channel(
    z.object({ blockId: z.string().min(1), type: z.string().min(1), payload: z.unknown() }),
    OkSchema,
  ),

  "settings.get": channel(Empty, SettingsSchema),
  "settings.set": channel(SettingsSchema.partial(), SettingsSchema),

  "app.version": channel(
    Empty,
    z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      userDataDir: z.string(),
      logFile: z.string(),
      dbFile: z.string(),
    }),
  ),
} as const satisfies Record<string, ChannelDef>;

export type InvokeChannels = typeof INVOKE_CHANNELS;
export type InvokeChannel = keyof InvokeChannels;
/** What the caller passes (pre-defaults). */
export type InvokeInput<C extends InvokeChannel> = z.input<InvokeChannels[C]["input"]>;
/** What a handler receives (post-defaults). */
export type InvokeArgs<C extends InvokeChannel> = z.output<InvokeChannels[C]["input"]>;
export type InvokeResult<C extends InvokeChannel> = z.output<InvokeChannels[C]["output"]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(INVOKE_CHANNELS) as InvokeChannel[];

// ---------------------------------------------------------------------------
// main → renderer (events)
// ---------------------------------------------------------------------------

export const EVENT_CHANNELS = {
  /** Upsert by `block.id` — the same block is re-sent as it streams and settles. */
  "chat.block": BlockSchema,
  "chat.turnStatus": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    status: TurnStatusSchema,
    error: z.string().optional(),
  }),
  "session.updated": SessionSchema,
  "permission.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    request: PermissionRequestSchema,
  }),
  "question.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    requestId: z.string(),
    questions: z.array(QuestionSchema),
  }),
  /** MCP `elicitation/create` or a Codex user-input request (R32). */
  "elicitation.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    requestId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    schema: z.unknown(),
  }),
  /** Shell-level notices: engine readiness, update state, backend errors. */
  "app.status": z.object({
    level: z.enum(["info", "warn", "error"]).default("info"),
    kind: z.string(),
    message: z.string(),
    ts: TimestampSchema,
  }),
} as const satisfies Record<string, z.ZodTypeAny>;

export type EventChannels = typeof EVENT_CHANNELS;
export type EventChannel = keyof EventChannels;
export type EventPayload<E extends EventChannel> = z.output<EventChannels[E]>;
export type EventInput<E extends EventChannel> = z.input<EventChannels[E]>;

export const EVENT_CHANNEL_NAMES = Object.keys(EVENT_CHANNELS) as EventChannel[];

/** True when `name` is a channel this build knows — used to gate the bridge. */
export function isInvokeChannel(name: string): name is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(INVOKE_CHANNELS, name);
}

export function isEventChannel(name: string): name is EventChannel {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, name);
}

/** The name the preload puts on `window`. One place, both sides. */
export const IPC_BRIDGE_KEY = "capygen" as const;
