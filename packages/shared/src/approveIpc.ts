/**
 * The Approve page's contract (P17, ADR-0007).
 *
 * One read channel. There is deliberately **no answer channel here**: the
 * Approve page addresses requests that already exist and answers them through
 * the existing `permission.answer` path, so a decision made from this page goes
 * through exactly the same authority checks, the same staleness handling and
 * the same grant rules as one made from the card in the conversation. A second
 * answer path would be a second place for those rules to drift.
 *
 * What crosses is bounded and descriptive. A pending row carries enough to
 * decide *whether to look*: which session and agent, which tool, why capygen is
 * asking, and a short summary of the input. It does not carry the complete tool
 * input — that is unbounded by nature, it is already rendered on the card in
 * the session, and an aggregation page that shipped every waiting request's
 * full arguments would put a great deal of tool text on one screen.
 */
import "./zodRuntime.js";
import { z } from "zod";
import { LocalPolicyAttributionSchema } from "./localPolicies.js";

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();

export const APPROVE_PAGE_DEFAULT_LIMIT = 25;
export const APPROVE_PAGE_MAX_LIMIT = 50;
/** A summary is a hint, not the argument list; the card in the session has that. */
export const APPROVE_INPUT_SUMMARY_MAX = 240;

/**
 * Why a request cannot be answered from here.
 *
 * Authority is resolved in main from the session's persisted execution subject
 * on every read, never supplied by the renderer and never cached in the page: a
 * profile demoted to viewer in another window must stop being able to approve
 * here too. A row that cannot be answered is still *listed*, because hiding it
 * would misrepresent what is waiting.
 */
export const ApproveRefusalSchema = z.enum(["viewer", "missing-member", "read-only-artifact"]);
export type ApproveRefusal = z.infer<typeof ApproveRefusalSchema>;

export const ApprovePendingRequestSchema = z.object({
  blockId: id,
  sessionId: id,
  /** The session's own title, for recognising it. Empty for an untitled one. */
  sessionTitle: z.string().max(200),
  turnId: id,
  agentId: id.nullable(),
  /** A display label, not an identity. Null when the request has no agent row. */
  agentLabel: z.string().max(120).nullable(),
  requestId: id,
  toolName: z.string().min(1).max(256),
  /** Bounded hint only. Open the session for the complete input. */
  inputSummary: z.string().max(APPROVE_INPUT_SUMMARY_MAX),
  /** Set when capygen's own restriction raised this, for attribution. */
  localPolicy: LocalPolicyAttributionSchema.optional(),
  createdAt: count,
  /** False when this machine's current execution subject may not answer. */
  answerable: z.boolean(),
  refusal: ApproveRefusalSchema.nullable(),
}).strict();
export type ApprovePendingRequest = z.infer<typeof ApprovePendingRequestSchema>;

export const ApprovePendingPageSchema = z.object({
  requests: z.array(ApprovePendingRequestSchema).max(APPROVE_PAGE_MAX_LIMIT),
  /** Everything waiting, not merely what fitted on this page. */
  total: count,
}).strict();
export type ApprovePendingPage = z.infer<typeof ApprovePendingPageSchema>;

export const ApprovePendingRequestArgsSchema = z.object({
  /** Restrict to one project; omit for every project this machine holds. */
  projectId: id.nullish().transform((value) => value ?? null),
  offset: count.default(0),
  limit: z.number().int().min(1).max(APPROVE_PAGE_MAX_LIMIT).default(APPROVE_PAGE_DEFAULT_LIMIT),
}).strict();
