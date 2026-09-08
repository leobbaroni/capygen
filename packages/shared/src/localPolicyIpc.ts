/**
 * The management IPC contract for local execution policy (ADR-0007, Phase 9).
 *
 * A self-contained channel map, declared here so the main handlers and the
 * renderer can both derive from one source before it is merged into the central
 * `INVOKE_CHANNELS` object. `LOCAL_POLICY_INVOKE_CHANNELS` has the same
 * `{ input, output }` shape that map uses, so merging it is a spread and
 * nothing here has to change.
 *
 * Two rules shape every schema below.
 *
 * *Nobody names their own authority.* These channels manage **local execution
 * profiles**, not logins, and ADR-0007 binds the session subject in main. So no
 * request carries an actor, a member id acting as an actor, or a role claiming
 * permission; the operator behind the desktop is main's to resolve, and a
 * `.strict()` object rejects the field rather than ignoring it.
 *
 * *No matching material crosses the bridge.* A grant matches on the canonical
 * input, the execution cwd and the opaque lifecycle token; none of the three
 * has a field in any DTO here, and the same goes for the audit. What a listing
 * carries is what a person needs to recognise and revoke a grant: an opaque
 * handle plus metadata.
 */
import "./zodRuntime.js";
import { z } from "zod";
import { BackendSchema, TimestampSchema } from "./domain.js";
import {
  LocalMemberRoleSchema,
  LocalMemberSchema,
  LocalPolicyDecisionSchema,
  LocalPolicyRuleDraftSchema,
  LocalPolicyRuleSchema,
  LocalPolicyScopeSchema,
  LocalToolPatternSchema,
  PolicyBoundaryAvailabilitySchema,
  PolicyBoundarySchema,
} from "./localPolicies.js";

const id = z.string().min(1).max(256);
const optionalId = id.nullish().transform((value) => value ?? null);
const toolName = z.string().min(1).max(256);
const label = z.string().min(1).max(120);
const scopeKind = z.enum(["global", "project", "session"]);

/** Same shape as the central map's entries, so merging is a spread. */
export interface LocalPolicyChannelDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input: I;
  output: O;
}

function channel<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  input: I,
  output: O,
): LocalPolicyChannelDef<I, O> {
  return { input, output };
}

const Empty = z.object({}).strict();
const Removed = z.object({ removed: z.boolean() }).strict();

// -- Members ------------------------------------------------------------------

export const LocalPolicyMemberCreateSchema = z
  .object({ label, role: LocalMemberRoleSchema })
  .strict();
export type LocalPolicyMemberCreate = z.infer<typeof LocalPolicyMemberCreateSchema>;

/** A patch, not a whole record: `builtIn`, ids and timestamps are not editable. */
export const LocalPolicyMemberUpdateSchema = z
  .object({ memberId: id, label: label.optional(), role: LocalMemberRoleSchema.optional() })
  .strict();
export type LocalPolicyMemberUpdate = z.infer<typeof LocalPolicyMemberUpdateSchema>;

export const LocalPolicyMemberListSchema = z
  .object({ members: z.array(LocalMemberSchema).max(500) })
  .strict();

const MemberEnvelope = z.object({ member: LocalMemberSchema }).strict();

// -- Session subject ----------------------------------------------------------

/**
 * `explicit: false` means the session never chose a profile and runs as the
 * built-in owner. A `null` subject means the assigned profile is gone — a state
 * the UI must show as a refusal, never as a silent fall back to owner.
 */
export const LocalPolicySubjectSchema = z
  .object({ sessionId: id, member: LocalMemberSchema, explicit: z.boolean() })
  .strict();
export type LocalPolicySubject = z.infer<typeof LocalPolicySubjectSchema>;

export const LocalPolicySubjectGetSchema = z.object({ sessionId: id }).strict();
export const LocalPolicySubjectAssignSchema = z
  .object({ sessionId: id, memberId: id })
  .strict();
export type LocalPolicySubjectAssign = z.infer<typeof LocalPolicySubjectAssignSchema>;

const SubjectEnvelope = z.object({ subject: LocalPolicySubjectSchema.nullable() }).strict();

// -- Rules --------------------------------------------------------------------

export const LocalPolicyRuleCreateSchema = LocalPolicyRuleDraftSchema;
export const LocalPolicyRuleUpdateSchema = z
  .object({
    ruleId: id,
    scope: LocalPolicyScopeSchema.optional(),
    boundary: PolicyBoundarySchema.optional(),
    pattern: LocalToolPatternSchema.optional(),
    decision: LocalPolicyDecisionSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type LocalPolicyRuleUpdate = z.infer<typeof LocalPolicyRuleUpdateSchema>;

export const LocalPolicyRuleListRequestSchema = z
  .object({ scope: LocalPolicyScopeSchema.nullish() })
  .strict();

const RuleEnvelope = z.object({ rule: LocalPolicyRuleSchema }).strict();

/**
 * A dry run of the *existing* evaluator for one prospective call.
 *
 * `source: "default"` means no local rule applied — never that anything was
 * natively allowed. `boundaryAvailable` is this agent's own capability, so a
 * preview at a boundary the agent cannot enforce says so instead of reading as
 * a permission.
 */
export const LocalPolicyEvaluationSchema = z
  .object({
    decision: LocalPolicyDecisionSchema,
    source: z.enum(["rule", "default"]),
    ruleId: id.nullable(),
    scopeKind: scopeKind.nullable(),
    scopeId: id.nullable(),
    matchedRuleIds: z.array(id).max(200),
    boundaryAvailable: z.boolean(),
  })
  .strict();
export type LocalPolicyEvaluation = z.infer<typeof LocalPolicyEvaluationSchema>;

export const LocalPolicyPreviewRequestSchema = z
  .object({
    sessionId: id,
    agentId: optionalId,
    boundary: PolicyBoundarySchema,
    toolName,
  })
  .strict();

// -- Grants -------------------------------------------------------------------

/**
 * Everything a person needs to recognise and revoke a grant, and nothing a
 * grant matches on: no canonical input, no cwd, no lifecycle token, no
 * signature. `grantId` is an opaque handle minted per grant.
 */
export const LocalPolicyGrantSummarySchema = z
  .object({
    grantId: id,
    sessionId: id,
    agentId: id.nullable(),
    backend: BackendSchema,
    boundary: PolicyBoundarySchema,
    toolName,
    grantedAt: TimestampSchema,
  })
  .strict();
export type LocalPolicyGrantSummary = z.infer<typeof LocalPolicyGrantSummarySchema>;

export const LocalPolicyGrantListSchema = z
  .object({ grants: z.array(LocalPolicyGrantSummarySchema).max(1000) })
  .strict();
export const LocalPolicyGrantRevokeSchema = z.object({ grantId: id }).strict();

// -- Audit --------------------------------------------------------------------

/** Bounded decision metadata. No arguments, hashes, credentials or output. */
/**
 * Where a *recorded* decision was enforced.
 *
 * Three-valued where a capture's own `PolicyExecutionSite` is two-valued, and
 * deliberately a separate enum: a live capture always has a real site, but an
 * audit row may describe a request that never matched one. `"unknown"` says so
 * instead of inventing `"backend"`, which would read as a claim about where the
 * call ran. Historical rows written before the column existed keep defaulting
 * to `"backend"`, which is what they truthfully were.
 */
export const PolicyAuditSiteSchema = z.enum(["backend", "widget-host", "unknown"]);
export type PolicyAuditSite = z.infer<typeof PolicyAuditSiteSchema>;

export const LocalPolicyAuditRecordSchema = z
  .object({
    id,
    ts: TimestampSchema,
    requestId: id.nullable(),
    sessionId: id.nullable(),
    agentId: id.nullable(),
    backend: BackendSchema,
    boundary: PolicyBoundarySchema,
    boundaryAvailable: z.boolean(),
    toolName,
    decision: LocalPolicyDecisionSchema,
    source: z.enum(["rule", "grant", "default", "approval", "subject", "error"]),
    ruleId: id.nullable(),
    scopeKind: scopeKind.nullable(),
    scopeId: id.nullable(),
    memberId: id.nullable(),
    /** An unauthenticated display label, as it read at decision time. */
    memberLabel: label.nullable(),
    memberRole: LocalMemberRoleSchema.nullable(),
    /**
     * Which capygen surface executed the call, captured by main.
     *
     * Additive and always present on the wire: historical rows report
     * `"backend"`, which is what they were. `backend`/`boundary` above keep
     * naming the origin agent and the protocol boundary, so a widget refusal
     * can still be attributed to the agent and rule that caused it.
     */
    executionSite: PolicyAuditSiteSchema,
  })
  .strict();
export type LocalPolicyAuditRecordDto = z.infer<typeof LocalPolicyAuditRecordSchema>;

export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 200;

export const LocalPolicyAuditPageRequestSchema = z
  .object({
    sessionId: optionalId,
    limit: z.number().int().min(1).max(AUDIT_PAGE_MAX_LIMIT).default(AUDIT_PAGE_DEFAULT_LIMIT),
    /** The `nextCursor` of the previous page; opaque to the renderer. */
    cursor: z.string().min(1).max(256).nullish().transform((value) => value ?? null),
  })
  .strict();
export type LocalPolicyAuditPageRequest = z.infer<typeof LocalPolicyAuditPageRequestSchema>;

export const LocalPolicyAuditPageSchema = z
  .object({
    records: z.array(LocalPolicyAuditRecordSchema).max(AUDIT_PAGE_MAX_LIMIT),
    nextCursor: z.string().min(1).max(256).nullable(),
    /** True when the bounded window ended before the history did. */
    truncated: z.boolean(),
  })
  .strict();

// -- Capability ---------------------------------------------------------------

/**
 * One agent's enforceable boundaries, with the reason for each unavailable one.
 * Per agent and per captured lifecycle: nothing here unions two agents'
 * capabilities, because that is how an unenforceable restriction ends up
 * looking satisfied (ADR-0007).
 */
export const LocalPolicyBoundaryReportSchema = z
  .object({
    sessionId: id,
    agentId: id.nullable(),
    backend: BackendSchema,
    boundaries: z.array(PolicyBoundaryAvailabilitySchema).max(32),
  })
  .strict();
export type LocalPolicyBoundaryReport = z.infer<typeof LocalPolicyBoundaryReportSchema>;

export const LocalPolicyBoundaryRequestSchema = z
  .object({ sessionId: id, agentId: optionalId })
  .strict();

// -- Failures -----------------------------------------------------------------

/**
 * Codes, not sentences: a failure must never echo the caller's own payload —
 * a rule pattern, a profile label or a tool name would otherwise travel back
 * into a UI string. The renderer renders its own message per code.
 */
export const LocalPolicyIpcErrorCodeSchema = z.enum([
  "invalid-request",
  "unknown-session",
  "unknown-project",
  "unknown-member",
  "unknown-rule",
  "member-assigned",
  "session-busy",
  "read-only-artifact",
  "not-permitted",
  "unavailable",
]);
export type LocalPolicyIpcErrorCode = z.infer<typeof LocalPolicyIpcErrorCodeSchema>;

// -- The map ------------------------------------------------------------------

export const LOCAL_POLICY_INVOKE_CHANNELS = {
  "policy.members.list": channel(Empty, LocalPolicyMemberListSchema),
  "policy.members.create": channel(LocalPolicyMemberCreateSchema, MemberEnvelope),
  "policy.members.update": channel(LocalPolicyMemberUpdateSchema, MemberEnvelope),
  "policy.members.remove": channel(z.object({ memberId: id }).strict(), Removed),

  "policy.session.subject.get": channel(LocalPolicySubjectGetSchema, SubjectEnvelope),
  "policy.session.subject.assign": channel(LocalPolicySubjectAssignSchema, SubjectEnvelope),

  "policy.rules.list": channel(
    LocalPolicyRuleListRequestSchema,
    z.object({ rules: z.array(LocalPolicyRuleSchema).max(2000) }).strict(),
  ),
  "policy.rules.create": channel(LocalPolicyRuleCreateSchema, RuleEnvelope),
  "policy.rules.update": channel(LocalPolicyRuleUpdateSchema, RuleEnvelope),
  "policy.rules.remove": channel(z.object({ ruleId: id }).strict(), Removed),
  "policy.rules.preview": channel(LocalPolicyPreviewRequestSchema, LocalPolicyEvaluationSchema),

  "policy.grants.list": channel(Empty, LocalPolicyGrantListSchema),
  "policy.grants.revoke": channel(
    LocalPolicyGrantRevokeSchema,
    z.object({ revoked: z.boolean() }).strict(),
  ),

  "policy.audit.list": channel(LocalPolicyAuditPageRequestSchema, LocalPolicyAuditPageSchema),

  "policy.boundaries.availability": channel(
    LocalPolicyBoundaryRequestSchema,
    LocalPolicyBoundaryReportSchema,
  ),
} as const satisfies Record<string, LocalPolicyChannelDef>;

export type LocalPolicyChannel = keyof typeof LOCAL_POLICY_INVOKE_CHANNELS;

export type LocalPolicyArgs<C extends LocalPolicyChannel> = z.input<
  (typeof LOCAL_POLICY_INVOKE_CHANNELS)[C]["input"]
>;
export type LocalPolicyParsedArgs<C extends LocalPolicyChannel> = z.output<
  (typeof LOCAL_POLICY_INVOKE_CHANNELS)[C]["input"]
>;
export type LocalPolicyResult<C extends LocalPolicyChannel> = z.output<
  (typeof LOCAL_POLICY_INVOKE_CHANNELS)[C]["output"]
>;

export const LOCAL_POLICY_CHANNEL_NAMES = Object.keys(
  LOCAL_POLICY_INVOKE_CHANNELS,
) as readonly LocalPolicyChannel[];
