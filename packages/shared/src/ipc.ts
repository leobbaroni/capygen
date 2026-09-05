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
  BlockSchema,
  PermissionRequestSchema,
  ProjectSchema,
  QuestionSchema,
  SessionModeSchema,
  SessionSchema,
  SettingsSchema,
  SlashCommandSchema,
  TimestampSchema,
  TurnSchema,
  TurnStatusSchema,
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
  "chat.listCommands": channel(
    z.object({ sessionId: z.string().min(1).optional() }),
    z.array(SlashCommandSchema),
  ),

  "permission.answer": channel(
    z.object({
      requestId: z.string().min(1),
      behavior: z.enum(["allow", "deny"]),
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
