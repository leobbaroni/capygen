/**
 * The local policy service (ADR-0007) — main-process authority for capygen's
 * own execution restrictions, the session execution subject and session grants.
 *
 * This is a pure service API: it evaluates, authorizes and records, and it never
 * calls a backend, spawns anything or touches a harness. Everything that must
 * reach outside is injected — the approval prompt, the edited-input validator,
 * the interrupt used by a restrictive reassignment, the quiescence check, and
 * the per-agent context. That is what lets the precedence, subject, capability
 * and revocation rules be tested as rules instead of as an integration, and it
 * is why this task does not claim harness enforcement: the boundaries
 * themselves are wired elsewhere.
 *
 * Four things it will not do, all from ADR-0007:
 *   * an `allow` result is never an unconditional native allow — it says only
 *     that capygen adds no local restriction, and the caller still applies the
 *     backend's own rules and native hard denials;
 *   * a subject is resolved from the persisted session assignment here in main.
 *     A role supplied by a renderer is never authority, so no method accepts one;
 *   * capability and backend belong to *one* agent and its captured lifecycle.
 *     Nothing unions one agent's supported boundaries into another's;
 *   * an approval authorizes the request it was asked about, and only while
 *     that request's session, lifecycle, capabilities, subject and rules are
 *     still the ones it was asked under.
 */
import {
  policyBoundaryBackend,
  type Backend,
  type LocalMember,
  type LocalMemberDraft,
  type LocalPolicyRule,
  type LocalPolicyRuleDraft,
  type PolicyBoundary,
} from "@capygen/shared";
import type {
  LocalMembersRepo,
  LocalPolicyAuditRecord,
  LocalPolicyAuditRepo,
  LocalPolicyAuditSource,
  LocalPolicyRulesRepo,
  ResolvedSubject,
  SessionMembersRepo,
} from "@capygen/db";
import {
  attributionFingerprint,
  evaluateLocalPolicy,
  matchesToolPattern,
  unavailableBoundaryRefusals,
  type BoundaryRefusal,
  type LocalPolicyOutcome,
} from "./evaluate.js";
import { snapshotToolInput, type InputSnapshotLimits } from "./inputSnapshot.js";
import { SessionGrantRegistry, type GrantIdentity, type GrantSummary } from "./grants.js";

/** The repositories this service owns. `CapygenStore` satisfies it structurally. */
export interface LocalPolicyStore {
  localMembers: LocalMembersRepo;
  sessionMembers: SessionMembersRepo;
  localPolicyRules: LocalPolicyRulesRepo;
  localPolicyAudit: LocalPolicyAuditRepo;
}

/**
 * What main knows about one agent in one session, at this instant.
 *
 * Per agent, not per session: two Codex agents in the same round table may have
 * different captured lifecycles and therefore different enforceable boundaries,
 * and an API agent has none of Codex's at all.
 */
export interface AgentPolicyContext {
  projectId: string | null;
  /** A read-only imported or shared artifact: it dispatches nothing, ever. */
  readOnly: boolean;
  /** The backend this agent actually targets. */
  backend: Backend;
  /** Opaque token for this agent's captured harness/connection lifecycle. */
  lifecycleToken: string;
  /** The boundaries this agent's captured lifecycle can enforce right now. */
  availableBoundaries: readonly PolicyBoundary[];
}

/** Resolves live per-agent facts main owns; null for anything it does not know. */
export type PolicyContextResolver = (
  sessionId: string,
  agentId: string | null,
) => AgentPolicyContext | null;

export interface ApprovalPrompt {
  requestId: string;
  sessionId: string;
  agentId: string | null;
  backend: Backend;
  boundary: PolicyBoundary;
  toolName: string;
  /** The frozen snapshot of the input, not the caller's live object. */
  input: unknown;
  cwd: string;
  /** The `ask` rule this prompt came from, for the card's rule link. */
  rule: LocalPolicyRule | null;
  /** The session execution profile, an unauthenticated display label. */
  member: LocalMember;
}

/**
 * The answer, as an explicit typed response.
 *
 * There is no "always" member. A permanent allow is a policy edit, and the
 * historical `allow_always` records are not migrated into authority.
 *
 * `input` carries an operator's edit of the request. It is never trusted: it
 * goes through the injected validator and a fresh bounded snapshot before it can
 * authorize anything, and a rejected edit refuses the call outright — the
 * original input is never what runs instead.
 */
export type ApprovalAnswer =
  | { kind: "allow-once"; input?: unknown }
  | { kind: "allow-session"; input?: unknown }
  | { kind: "deny" }
  | { kind: "cancelled" };

export type AskCallback = (
  prompt: ApprovalPrompt,
  signal: AbortSignal | undefined,
) => Promise<ApprovalAnswer>;

export type EditedInputValidation =
  | { ok: true; input: unknown }
  | { ok: false; message: string };

/** Validates an operator's replacement input before it can authorize anything. */
export type EditedInputValidator = (
  request: AuthorizeRequest,
  replacement: unknown,
) => EditedInputValidation | Promise<EditedInputValidation>;

export interface LocalPolicyServiceDeps {
  store: LocalPolicyStore;
  resolveContext: PolicyContextResolver;
  ask: AskCallback;
  /** Required before any edited input may be accepted; absent means no edits. */
  validateEditedInput?: EditedInputValidator;
  /**
   * Interrupt execution and deny waiting approvals for a session. Called
   * synchronously by a restrictive reassignment, before it returns.
   */
  interruptAndDeny: (sessionId: string, reason: string) => void;
  /** Whether a session is quiescent; an ordinary reassignment requires it. */
  isQuiescent: (sessionId: string) => boolean;
  grants?: SessionGrantRegistry;
  inputLimits?: InputSnapshotLimits;
  now?: () => number;
}

export type PolicyErrorCode =
  | "not-owner"
  | "unknown-member"
  | "unknown-session"
  | "member-assigned"
  | "session-busy"
  | "built-in-member";

export class LocalPolicyError extends Error {
  constructor(readonly code: PolicyErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "LocalPolicyError";
  }
}

export type AuthorizationRefusal =
  | "rule"
  | "viewer"
  | "missing-member"
  | "read-only-artifact"
  | "unknown-session"
  | "boundary-unavailable"
  | "lifecycle-mismatch"
  | "invalid-input"
  | "invalid-edit"
  | "invalid-answer"
  | "stale"
  | "policy-changed"
  | "user-denied"
  | "cancelled"
  | "error";

export interface Authorization {
  allowed: boolean;
  /** Always "local": this verdict never speaks for a backend's own rules. */
  scope: "local";
  source: LocalPolicyAuditSource;
  reason: AuthorizationRefusal | null;
  rule: LocalPolicyRule | null;
  message: string | null;
  /**
   * The frozen input this authorization is for — the caller must execute this
   * value, not its own object, which may have been edited by the operator or
   * mutated since. Undefined on every refusal.
   */
  approvedInput?: unknown;
  grantCreated: boolean;
  /** Opaque handle when this call minted a session grant. */
  grantId: string | null;
  audit: LocalPolicyAuditRecord | null;
}

export interface AuthorizeRequest {
  requestId?: string;
  sessionId: string;
  agentId: string | null;
  boundary: PolicyBoundary;
  toolName: string;
  /** The complete input that will execute; snapshotted before anything else. */
  input: unknown;
  cwd: string;
  /**
   * Opaque lifecycle token from main. It is *verified* against the agent's
   * captured context, never taken on trust: a caller cannot widen its own
   * authorization by naming a token, and a stale token refuses.
   */
  lifecycleToken: string;
  signal?: AbortSignal;
}

export type DispatchDecision =
  | { allowed: true; member: LocalMember }
  | {
      allowed: false;
      reason:
        | "unknown-session" | "read-only-artifact" | "missing-member"
        | "viewer" | "boundary-unavailable";
      message: string;
      /** Populated for `boundary-unavailable`: each names its owning rule. */
      refusals: BoundaryRefusal[];
    };

/** The actor a management call runs as, always resolved from persisted rows. */
export type PolicyActor = { sessionId: string } | { memberId: string };

export type AutomationSubjectCopy =
  | { ok: true; member: LocalMember }
  | { ok: false; reason: "unknown-session" | "missing-member" | "viewer"; message: string };

const MAX_LIFECYCLE_TOKEN_LENGTH = 256;

/**
 * Classify an approval response.
 *
 * Only the four typed answers exist. Anything else — a different `kind`, a
 * string, `null`, a missing response — is not a denial *and* not an approval,
 * and returns null so the caller refuses. An approval path that ends in a
 * permit by default would let any malformed value authorize a tool call.
 */
export function classifyApprovalAnswer(
  answer: unknown,
): "allow-once" | "allow-session" | "deny" | "cancelled" | null {
  if (typeof answer !== "object" || answer === null) return null;
  const kind = (answer as { kind?: unknown }).kind;
  return kind === "allow-once" || kind === "allow-session" || kind === "deny" || kind === "cancelled"
    ? kind
    : null;
}

/**
 * Whether the answer carries an edited input.
 *
 * Own-property presence, not `!== undefined`: an answer that explicitly sets
 * `input: undefined` has replaced the request with something unrepresentable,
 * and must be refused. Reading it as "no edit" would run the original input the
 * operator had just chosen to replace.
 */
function hasEditedInput(answer: ApprovalAnswer): answer is ApprovalAnswer & { input?: unknown } {
  return Object.prototype.hasOwnProperty.call(answer, "input");
}

/** Everything a pending approval must still be true about when it comes back. */
interface AuthorizationEpoch {
  session: number;
  lifecycle: number;
  revocation: number;
  fingerprint: string;
}

export class LocalPolicyService {
  readonly grants: SessionGrantRegistry;
  private readonly store: LocalPolicyStore;
  private readonly now: () => number;
  /**
   * Monotonic counters, bumped by anything that ends or revokes authorization.
   * A pending approval carries the values it was asked under; a change to any
   * of them means the answer is about a world that no longer exists, so it is
   * refused rather than re-interpreted — and, crucially, mints no grant.
   */
  private readonly sessionEpochs = new Map<string, number>();
  private readonly lifecycleEpochs = new Map<string, number>();
  private revocationEpoch = 0;

  constructor(private readonly deps: LocalPolicyServiceDeps) {
    this.store = deps.store;
    this.grants = deps.grants ?? new SessionGrantRegistry();
    this.now = deps.now ?? (() => Date.now());
  }

  // -- Evaluation ------------------------------------------------------------

  /**
   * The current outcome for one prospective call, with no side effects.
   *
   * API tools consult this per call at dequeue, immediately before execution;
   * admitting a batch never authorizes the calls queued behind it.
   */
  evaluate(request: {
    sessionId: string;
    agentId?: string | null;
    boundary: PolicyBoundary;
    toolName: string;
  }): LocalPolicyOutcome {
    const context = this.deps.resolveContext(request.sessionId, request.agentId ?? null);
    return this.outcomeFor({
      sessionId: request.sessionId,
      projectId: context?.projectId ?? null,
      agentId: request.agentId ?? null,
      boundary: request.boundary,
      toolName: request.toolName,
    });
  }

  /**
   * Authorize one call, asking the injected approval callback when the outcome
   * is `ask` and no exact grant already satisfies it.
   *
   * Fail closed: any storage or evaluation error refuses. R12's routing
   * fail-open does not apply to this path.
   */
  async authorize(request: AuthorizeRequest): Promise<Authorization> {
    const backend = policyBoundaryBackend(request.boundary);
    try {
      // 1. Cancellation, before anything can succeed — including the paths
      //    where no rule applies and where an exact grant already exists.
      if (request.signal?.aborted) {
        return this.refuse(request, backend, false, "cancelled", "approval", null,
          "The request was cancelled before it was evaluated.");
      }

      // 2. Who and what this agent actually is.
      const context = this.deps.resolveContext(request.sessionId, request.agentId);
      if (!context) {
        return this.refuse(request, backend, false, "unknown-session", "subject", null,
          "This session or agent is not known to the policy service.");
      }
      if (context.readOnly) {
        // An imported transcript or received bundle executes nothing, so it
        // never reaches an approval and never mints a grant.
        return this.refuse(request, backend, false, "read-only-artifact", "subject", null,
          "This is a read-only imported artifact; it cannot execute tools.");
      }

      const tokenProblem = this.lifecycleProblem(request.lifecycleToken, context);
      if (tokenProblem) {
        return this.refuse(request, backend, false, "lifecycle-mismatch", "subject", null, tokenProblem);
      }

      // 3. Capability, per agent. A request at a boundary this agent's captured
      //    lifecycle cannot enforce is refused: an allow there would be an
      //    authorization nothing is able to police.
      const capability = this.capabilityProblem(request.boundary, backend, context);
      if (capability) {
        return this.refuse(request, backend, false, "boundary-unavailable", "subject", null, capability);
      }

      // 4. Execution subject.
      const subject = this.store.sessionMembers.resolve(request.sessionId);
      if (!subject) {
        return this.refuse(request, backend, true, "missing-member", "subject", null,
          "The profile assigned to this session no longer exists; reassign it before running.");
      }
      if (subject.member.role === "viewer") {
        return this.refuse(request, backend, true, "viewer", "subject", null,
          `"${subject.member.label}" is a viewer profile and cannot approve or run tools.`,
          subject);
      }

      // 5. The exact request, frozen. Anything not representable as bounded
      //    JSON refuses here: an identity that elides part of the input cannot
      //    be the identity of the input.
      const snapshot = snapshotToolInput(request.input, this.deps.inputLimits);
      if (!snapshot.ok) {
        return this.refuse(request, backend, true, "invalid-input", "subject", null,
          `This tool input cannot be authorized exactly (${snapshot.reason} at ${snapshot.path}).`,
          subject);
      }

      const outcome = this.outcomeFor({
        sessionId: request.sessionId, projectId: context.projectId,
        agentId: request.agentId, boundary: request.boundary, toolName: request.toolName,
      });
      const epoch = this.epochOf(request, context, outcome);

      if (outcome.decision === "deny") {
        return this.refuse(request, backend, true, "rule", "rule", outcome,
          this.denyMessage(outcome), subject);
      }
      if (outcome.decision === "allow") {
        if (request.signal?.aborted) {
          return this.refuse(request, backend, true, "cancelled", "approval", outcome,
            "The request was cancelled before it was allowed.", subject);
        }
        return this.permit(request, backend, outcome.source, outcome, subject, snapshot.value, null);
      }

      // -- ask -----------------------------------------------------------------
      const identity = (inputCanonical: string): GrantIdentity => ({
        sessionId: request.sessionId,
        agentId: request.agentId,
        backend,
        boundary: request.boundary,
        toolName: request.toolName,
        inputCanonical,
        cwd: request.cwd,
        lifecycleToken: context.lifecycleToken,
      });
      // Only after the deny check above: a grant satisfies an `ask`, never a deny.
      if (this.grants.has(identity(snapshot.canonical))) {
        if (request.signal?.aborted) {
          return this.refuse(request, backend, true, "cancelled", "approval", outcome,
            "The request was cancelled before its grant was applied.", subject);
        }
        return this.permit(request, backend, "grant", outcome, subject, snapshot.value, null);
      }

      const asked = await this.race(this.deps.ask(
        {
          requestId: request.requestId ?? `${request.sessionId}:${request.toolName}:${this.now()}`,
          sessionId: request.sessionId,
          agentId: request.agentId,
          backend,
          boundary: request.boundary,
          toolName: request.toolName,
          input: snapshot.value,
          cwd: request.cwd,
          rule: outcome.rule,
          member: subject.member,
        },
        request.signal,
      ), request.signal);

      // -- after the answer ----------------------------------------------------
      // The world may have moved while the card was open. Nothing below may
      // succeed on the strength of what was true when the card opened.
      if (asked.cancelled) {
        return this.refuse(request, backend, true, "cancelled", "approval", outcome,
          "The request was cancelled while the approval was open.", subject);
      }
      const answer = asked.value;
      const kind = classifyApprovalAnswer(answer);
      if (kind === "cancelled") {
        return this.refuse(request, backend, true, "cancelled", "approval", outcome,
          "The request was cancelled while the approval was open.", subject);
      }
      if (kind === null) {
        // Not a denial and not an approval: a response that is not one of the
        // four typed answers authorizes nothing. Falling through to a permit
        // would let any malformed value stand in for "allow".
        return this.refuse(request, backend, true, "invalid-answer", "approval", outcome,
          "The approval response was not a valid answer, so nothing was authorized.", subject);
      }

      const rechecked = this.recheckAuthority(request, backend, epoch, outcome, subject,
        "while the approval was open");
      if (!rechecked.ok) return rechecked.refusal;
      if (kind === "deny") {
        return this.refuse(request, backend, true, "user-denied", "approval", rechecked.outcome,
          "The request was denied.", rechecked.subject);
      }

      // 6. An edited input authorizes only itself, and only once validated.
      //    `input` is detected as an own property, so an explicit `undefined`
      //    is an edit that fails validation — never a silent approval of the
      //    original the operator chose to replace.
      let approved: { value: unknown; canonical: string } =
        { value: snapshot.value, canonical: snapshot.canonical };
      let authority = rechecked;
      if (hasEditedInput(answer)) {
        const edited = await this.acceptEditedInput(request, answer.input);
        if (edited.status === "cancelled") {
          return this.refuse(request, backend, true, "cancelled", "approval", authority.outcome,
            "The request was cancelled while the edited input was validated.", authority.subject);
        }
        if (edited.status === "rejected") {
          return this.refuse(request, backend, true, "invalid-edit", "approval", authority.outcome,
            edited.message, authority.subject);
        }
        // Validation is a second await, and therefore a second window: the
        // rules, capabilities, lifecycle, artifact flag and subject are all
        // resolved again rather than reusing what was read before it.
        const after = this.recheckAuthority(request, backend, epoch, authority.outcome,
          authority.subject, "while the edited input was validated");
        if (!after.ok) return after.refusal;
        authority = after;
        approved = edited.snapshot;
      }

      if (kind === "allow-session") {
        const record = this.grants.grant(identity(approved.canonical), {
          projectId: authority.context.projectId, now: this.now,
        });
        return this.permit(request, backend, "approval", authority.outcome, authority.subject,
          approved.value, record.grantId);
      }
      return this.permit(request, backend, "approval", authority.outcome, authority.subject,
        approved.value, null);
    } catch (error) {
      return this.failClosed(request, backend, error);
    }
  }

  // -- Dispatch and approval gating -----------------------------------------

  /**
   * Whether this agent may dispatch a turn at all.
   *
   * A viewer may inspect history but never dispatches. A restriction whose
   * enforcement boundary *this agent's target backend* cannot provide refuses
   * the dispatch and names that boundary and its owning rule. A rule for another
   * backend is not this target's problem, and another agent's capabilities are
   * not this agent's coverage.
   */
  checkDispatch(sessionId: string, agentId: string | null): DispatchDecision {
    const context = this.deps.resolveContext(sessionId, agentId);
    if (!context) {
      return {
        allowed: false, reason: "unknown-session", refusals: [],
        message: "Unknown session or agent.",
      };
    }
    if (context.readOnly) {
      return {
        allowed: false, reason: "read-only-artifact", refusals: [],
        message: "This is a read-only imported artifact; start a fresh session to continue it.",
      };
    }
    const subject = this.store.sessionMembers.resolve(sessionId);
    if (!subject) {
      return {
        allowed: false, reason: "missing-member", refusals: [],
        message: "The profile assigned to this session no longer exists; reassign it before running.",
      };
    }
    if (subject.member.role === "viewer") {
      return {
        allowed: false, reason: "viewer", refusals: [],
        message: `"${subject.member.label}" is a viewer profile and cannot run turns.`,
      };
    }
    const rules = this.store.localPolicyRules.applicable({
      projectId: context.projectId, sessionId, enabledOnly: true,
    });
    const refusals = unavailableBoundaryRefusals(
      rules, { sessionId, projectId: context.projectId },
      context.availableBoundaries, context.backend,
    );
    const first = refusals[0];
    if (first) {
      return { allowed: false, reason: "boundary-unavailable", refusals, message: first.message };
    }
    return { allowed: true, member: subject.member };
  }

  /**
   * A viewer cannot answer an approval; neither can an unknown agent or a
   * read-only artifact, which have no live request to answer in the first place.
   */
  canAnswerApproval(sessionId: string, agentId: string | null): boolean {
    const context = this.deps.resolveContext(sessionId, agentId);
    if (!context || context.readOnly) return false;
    const subject = this.store.sessionMembers.resolve(sessionId);
    return subject !== null && subject.member.role !== "viewer";
  }

  // -- Subject resolution ----------------------------------------------------

  /**
   * The session's execution subject.
   *
   * No row means the built-in owner — the consistent default for every session
   * that predates migration 0010. A row naming a member that is gone resolves
   * to null; that is a refusal, never a silent fall back to owner.
   */
  resolveSubject(sessionId: string): ResolvedSubject | null {
    return this.store.sessionMembers.resolve(sessionId);
  }

  /**
   * Copy a source session's current subject onto a fresh automation run.
   *
   * Automations resolve the source session's member at fire time; a viewer or a
   * removed member produces a visible refusal with no model call, and never an
   * owner fallback. Wiring the automation itself is separate work; this is the
   * API it will call. The fresh run gets its own dispatch and per-call checks.
   */
  copySubjectForRun(sourceSessionId: string, targetSessionId: string): AutomationSubjectCopy {
    const subject = this.store.sessionMembers.resolve(sourceSessionId);
    if (!subject) {
      return {
        ok: false, reason: "missing-member",
        message: "The source session's profile no longer exists; the run is refused.",
      };
    }
    if (subject.member.role === "viewer") {
      return {
        ok: false, reason: "viewer",
        message: `"${subject.member.label}" is a viewer profile; the run is refused.`,
      };
    }
    // Written explicitly, so the run keeps this subject even if the source
    // session is later reassigned.
    this.store.sessionMembers.set(targetSessionId, subject.member.id);
    return { ok: true, member: subject.member };
  }

  // -- Management (owner only) ----------------------------------------------

  listMembers(): LocalMember[] {
    return this.store.localMembers.list();
  }

  listRules(): LocalPolicyRule[] {
    return this.store.localPolicyRules.list();
  }

  /** Safe metadata only — no input, cwd, lifecycle token or signature. */
  listGrants(): GrantSummary[] {
    return this.grants.describe();
  }

  createRule(actor: PolicyActor, draft: LocalPolicyRuleDraft): LocalPolicyRule {
    this.requireOwner(actor);
    const rule = this.store.localPolicyRules.create(draft);
    this.invalidateGrantsForRule(rule);
    return rule;
  }

  updateRule(actor: PolicyActor, id: string, patch: Partial<LocalPolicyRuleDraft>): LocalPolicyRule {
    this.requireOwner(actor);
    const before = this.store.localPolicyRules.get(id);
    const after = this.store.localPolicyRules.update(id, patch);
    // Both shapes: an edit can move a rule off the tools it used to cover.
    if (before) this.invalidateGrantsForRule(before);
    this.invalidateGrantsForRule(after);
    return after;
  }

  removeRule(actor: PolicyActor, id: string): boolean {
    this.requireOwner(actor);
    const before = this.store.localPolicyRules.get(id);
    const removed = this.store.localPolicyRules.remove(id);
    if (before) this.invalidateGrantsForRule(before);
    return removed;
  }

  createMember(actor: PolicyActor, draft: LocalMemberDraft): LocalMember {
    this.requireOwner(actor);
    return this.store.localMembers.create(draft);
  }

  /** A demotion to viewer interrupts every session that profile is running. */
  updateMember(actor: PolicyActor, id: string, patch: Partial<LocalMemberDraft>): LocalMember {
    this.requireOwner(actor);
    const before = this.store.localMembers.get(id);
    if (!before) throw new LocalPolicyError("unknown-member", `Unknown profile: ${id}`);
    const after = this.store.localMembers.update(id, patch);
    if (before.role !== "viewer" && after.role === "viewer") {
      for (const sessionId of this.store.localMembers.assignedSessionIds(id)) {
        this.revokeSessionExecution(sessionId, `"${after.label}" is now a viewer profile.`);
      }
    }
    return after;
  }

  /** Refused while any session still names this profile. */
  removeMember(actor: PolicyActor, id: string): boolean {
    this.requireOwner(actor);
    const member = this.store.localMembers.get(id);
    if (!member) return false;
    if (member.builtIn) {
      throw new LocalPolicyError("built-in-member", "The built-in owner profile cannot be deleted.");
    }
    const assigned = this.store.localMembers.assignedSessionIds(id);
    if (assigned.length > 0) {
      throw new LocalPolicyError(
        "member-assigned",
        `"${member.label}" is still assigned to ${assigned.length} session(s). Reassign them first.`,
        { sessionIds: assigned },
      );
    }
    return this.store.localMembers.remove(id);
  }

  /**
   * Assign a profile to a session.
   *
   * Ordinary reassignment requires a quiescent session — swapping the subject
   * mid-turn would leave a running turn attributed to a profile that did not
   * start it. Restrictive reassignment to viewer is the explicit exception: it
   * applies immediately and interrupts execution, because waiting for quiet is
   * exactly what a revocation must not do.
   */
  assignMember(actor: PolicyActor, sessionId: string, memberId: string): LocalMember {
    this.requireOwner(actor);
    const next = this.store.localMembers.get(memberId);
    if (!next) throw new LocalPolicyError("unknown-member", `Unknown profile: ${memberId}`);
    const current = this.store.sessionMembers.resolve(sessionId);
    const restrictive = next.role === "viewer" && current?.member.role !== "viewer";
    if (!restrictive && !this.deps.isQuiescent(sessionId)) {
      throw new LocalPolicyError(
        "session-busy",
        "Finish or stop the current turn before changing this session's execution profile.",
      );
    }
    this.store.sessionMembers.set(sessionId, memberId);
    if (restrictive) {
      this.revokeSessionExecution(sessionId, `"${next.label}" is a viewer profile.`);
    } else {
      // A new subject never inherits the previous subject's grants, and any
      // approval asked under the old subject is now stale.
      this.grants.revokeSession(sessionId);
      this.bumpSession(sessionId);
    }
    return next;
  }

  /** Session shutdown: its grants die with it, and so do its pending answers. */
  endSession(sessionId: string): number {
    const revoked = this.grants.revokeSession(sessionId);
    this.bumpSession(sessionId);
    return revoked;
  }

  /** A restarted harness or replaced connection invalidates its own grants. */
  endLifecycle(lifecycleToken: string): number {
    const revoked = this.grants.revokeLifecycle(lifecycleToken);
    this.lifecycleEpochs.set(lifecycleToken, (this.lifecycleEpochs.get(lifecycleToken) ?? 0) + 1);
    return revoked;
  }

  revokeGrants(actor: PolicyActor, predicate?: (sessionId: string) => boolean): number {
    this.requireOwner(actor);
    this.revocationEpoch += 1;
    return predicate
      ? this.grants.revokeMatching((record) => predicate(record.sessionId))
      : this.grants.revokeAll();
  }

  /** Revoke one grant by the opaque handle a listing carries. */
  revokeGrantById(actor: PolicyActor, grantId: string): boolean {
    this.requireOwner(actor);
    this.revocationEpoch += 1;
    return this.grants.revokeById(grantId);
  }

  recentAudit(limit = 100): LocalPolicyAuditRecord[] {
    return this.store.localPolicyAudit.recent(limit);
  }

  // -- Internals -------------------------------------------------------------

  /**
   * Wait for an injected callback, but never *only* for it.
   *
   * Both awaited callbacks — the approval prompt and the edited-input
   * validator — are supplied by the caller, and either could ignore its signal
   * and hold a tool call open forever. The race resolves on whichever comes
   * first; a late completion or a late rejection is dropped, so it can neither
   * authorize anything nor surface as an unhandled rejection.
   */
  private race<T>(
    pending: Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<{ cancelled: false; value: T } | { cancelled: true }> {
    if (!signal) return pending.then((value) => ({ cancelled: false as const, value }));
    if (signal.aborted) {
      pending.then(() => undefined, () => undefined);
      return Promise.resolve({ cancelled: true as const });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => settle(() => resolve({ cancelled: true as const }));
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => settle(() => resolve({ cancelled: false as const, value })),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Re-resolve every authority this request depends on, from scratch.
   *
   * Called after each await, and each time it reads live state rather than
   * anything captured earlier: cancellation, the agent's context (artifact
   * flag, lifecycle token, target backend, capabilities), the persisted
   * subject, the current rules, and the epochs the request was admitted under.
   * A refusal here carries the same attribution and message shape as any other.
   */
  private recheckAuthority(
    request: AuthorizeRequest,
    backend: Backend,
    baseline: AuthorizationEpoch,
    priorOutcome: LocalPolicyOutcome,
    priorSubject: ResolvedSubject,
    when: string,
  ):
    | { ok: true; context: AgentPolicyContext; subject: ResolvedSubject; outcome: LocalPolicyOutcome }
    | { ok: false; refusal: Authorization } {
    const deny = (
      boundaryAvailable: boolean,
      reason: AuthorizationRefusal,
      source: LocalPolicyAuditSource,
      outcome: LocalPolicyOutcome | null,
      message: string,
      subject: ResolvedSubject | null,
    ) => ({
      ok: false as const,
      refusal: this.refuse(request, backend, boundaryAvailable, reason, source, outcome, message, subject),
    });

    if (request.signal?.aborted) {
      return deny(true, "cancelled", "approval", priorOutcome,
        `The request was cancelled ${when}.`, priorSubject);
    }
    const context = this.deps.resolveContext(request.sessionId, request.agentId);
    if (!context || context.readOnly) {
      return deny(true, "unknown-session", "subject", priorOutcome,
        `The session ended ${when}.`, priorSubject);
    }
    if (this.lifecycleProblem(request.lifecycleToken, context)) {
      return deny(true, "lifecycle-mismatch", "subject", priorOutcome,
        `The backend lifecycle was replaced ${when}.`, priorSubject);
    }
    if (this.capabilityProblem(request.boundary, backend, context)) {
      return deny(false, "boundary-unavailable", "subject", priorOutcome,
        `This agent can no longer enforce that boundary, so the request cannot be authorized.`,
        priorSubject);
    }
    const subject = this.store.sessionMembers.resolve(request.sessionId);
    if (!subject) {
      return deny(true, "missing-member", "subject", priorOutcome,
        `The profile assigned to this session was removed ${when}.`, null);
    }
    if (subject.member.role === "viewer") {
      return deny(true, "viewer", "subject", priorOutcome,
        `This session became a viewer ${when}.`, subject);
    }
    const outcome = this.outcomeFor({
      sessionId: request.sessionId, projectId: context.projectId,
      agentId: request.agentId, boundary: request.boundary, toolName: request.toolName,
    });
    if (outcome.decision === "deny") {
      return deny(true, "rule", "rule", outcome, this.denyMessage(outcome), subject);
    }
    const epoch = this.epochOf(request, context, outcome);
    // Ended, revoked or reassigned while waiting: the answer is about an
    // authorization that no longer exists, and must not resurrect it.
    if (epoch.session !== baseline.session
      || epoch.lifecycle !== baseline.lifecycle
      || epoch.revocation !== baseline.revocation) {
      return deny(true, "stale", "approval", outcome,
        `This approval was answered after the session or backend authorization ended ${when}; ask again.`,
        subject);
    }
    // The restriction the operator answered about changed — including one `ask`
    // rule replaced by a different `ask` rule, where the decision is identical
    // but the rule, its text and its editor link are not.
    if (epoch.fingerprint !== baseline.fingerprint) {
      return deny(true, "policy-changed", "approval", outcome,
        `The restrictions changed ${when}; ask again.`, subject);
    }
    return { ok: true, context, subject, outcome };
  }

  /**
   * Validate and snapshot an operator's replacement input.
   *
   * The validator is injected, so it is raced against cancellation exactly like
   * the approval prompt: one that never settles cannot hold the call open, and
   * its late verdict is discarded rather than applied to a request that has
   * already been refused.
   */
  private async acceptEditedInput(
    request: AuthorizeRequest,
    replacement: unknown,
  ): Promise<
    | { status: "ok"; snapshot: { value: unknown; canonical: string } }
    | { status: "rejected"; message: string }
    | { status: "cancelled" }
  > {
    const validator = this.deps.validateEditedInput;
    if (!validator) {
      // No validator injected means edits are not supported here. Refusing is
      // the only safe reading: running the original input would execute
      // something the operator explicitly chose not to approve.
      return { status: "rejected", message: "Edited tool input is not accepted for this request." };
    }
    const raced = await this.race(
      Promise.resolve(validator(request, replacement)),
      request.signal,
    );
    if (raced.cancelled) return { status: "cancelled" };
    const verdict = raced.value;
    if (!verdict.ok) return { status: "rejected", message: verdict.message };
    const snapshot = snapshotToolInput(verdict.input, this.deps.inputLimits);
    if (!snapshot.ok) {
      return {
        status: "rejected",
        message: `The edited input cannot be authorized exactly (${snapshot.reason} at ${snapshot.path}).`,
      };
    }
    return { status: "ok", snapshot: { value: snapshot.value, canonical: snapshot.canonical } };
  }

  private lifecycleProblem(token: unknown, context: AgentPolicyContext): string | null {
    if (typeof token !== "string" || token.trim().length === 0) {
      return "This request carries no authorization lifecycle token.";
    }
    if (token.length > MAX_LIFECYCLE_TOKEN_LENGTH) {
      return "This request's authorization lifecycle token is not a valid token.";
    }
    if (token !== context.lifecycleToken) {
      return "This request's authorization lifecycle token does not match the agent's captured backend.";
    }
    return null;
  }

  private capabilityProblem(
    boundary: PolicyBoundary,
    backend: Backend,
    context: AgentPolicyContext,
  ): string | null {
    if (backend !== context.backend) {
      return `This agent targets ${context.backend}; a ${boundary} request cannot be authorized for it.`;
    }
    if (!context.availableBoundaries.includes(boundary)) {
      return `This agent's captured backend cannot enforce the ${boundary} boundary.`;
    }
    return null;
  }

  private epochOf(
    request: AuthorizeRequest,
    context: AgentPolicyContext,
    outcome: LocalPolicyOutcome,
  ): AuthorizationEpoch {
    return {
      session: this.sessionEpochs.get(request.sessionId) ?? 0,
      lifecycle: this.lifecycleEpochs.get(context.lifecycleToken) ?? 0,
      revocation: this.revocationEpoch,
      fingerprint: attributionFingerprint(outcome),
    };
  }

  private bumpSession(sessionId: string): void {
    this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
  }

  private outcomeFor(request: {
    sessionId: string;
    projectId: string | null;
    agentId: string | null;
    boundary: PolicyBoundary;
    toolName: string;
  }): LocalPolicyOutcome {
    const rules = this.store.localPolicyRules.applicable({
      projectId: request.projectId, sessionId: request.sessionId, enabledOnly: true,
    });
    return evaluateLocalPolicy(rules, request);
  }

  private denyMessage(outcome: LocalPolicyOutcome): string {
    const rule = outcome.rule;
    if (!rule) return "A local restriction refused this tool.";
    return (
      `The ${rule.scope.kind} restriction "${rule.pattern}" (${rule.boundary}) denies this tool. ` +
      "Edit that restriction to allow it."
    );
  }

  private requireOwner(actor: PolicyActor): LocalMember {
    const member =
      "memberId" in actor
        ? this.store.localMembers.get(actor.memberId)
        : this.store.sessionMembers.resolve(actor.sessionId)?.member ?? null;
    if (!member) {
      throw new LocalPolicyError("unknown-member", "No local profile resolves for this action.");
    }
    if (member.role !== "owner") {
      throw new LocalPolicyError(
        "not-owner",
        `"${member.label}" is a ${member.role} profile and cannot manage restrictions or grants.`,
      );
    }
    return member;
  }

  /** Interrupt, deny what is waiting, and drop the session's grants. */
  private revokeSessionExecution(sessionId: string, reason: string): void {
    this.grants.revokeSession(sessionId);
    this.bumpSession(sessionId);
    this.deps.interruptAndDeny(sessionId, reason);
  }

  /** Every grant a changed rule could have covered stops being valid. */
  private invalidateGrantsForRule(rule: LocalPolicyRule): number {
    return this.grants.revokeMatching((record) => {
      if (record.boundary !== rule.boundary) return false;
      if (!matchesToolPattern(rule.pattern, record.toolName)) return false;
      if (rule.scope.kind === "project") return record.projectId === rule.scope.projectId;
      if (rule.scope.kind === "session") return record.sessionId === rule.scope.sessionId;
      return true;
    });
  }

  private permit(
    request: AuthorizeRequest,
    backend: Backend,
    source: LocalPolicyAuditSource,
    outcome: LocalPolicyOutcome | null,
    subject: ResolvedSubject | null,
    approvedInput: unknown,
    grantId: string | null,
  ): Authorization {
    return {
      allowed: true,
      scope: "local",
      source,
      reason: null,
      rule: outcome?.rule ?? null,
      message: null,
      approvedInput,
      grantCreated: grantId !== null,
      grantId,
      audit: this.audit(request, backend, true, "allow", source, outcome, subject),
    };
  }

  private refuse(
    request: AuthorizeRequest,
    backend: Backend,
    boundaryAvailable: boolean,
    reason: AuthorizationRefusal,
    source: LocalPolicyAuditSource,
    outcome: LocalPolicyOutcome | null,
    message: string,
    subject: ResolvedSubject | null = null,
  ): Authorization {
    return {
      allowed: false,
      scope: "local",
      source,
      reason,
      rule: outcome?.rule ?? null,
      message,
      grantCreated: false,
      grantId: null,
      audit: this.audit(request, backend, boundaryAvailable, "deny", source, outcome, subject),
    };
  }

  /**
   * Storage or evaluation failure refuses execution.
   *
   * The audit write is itself attempted and itself allowed to fail: a database
   * that cannot record the refusal must not turn the refusal into an exception
   * the caller might treat as something other than a denial. Nothing from the
   * exception is copied into the record — ADR-0007 keeps raw exception text out.
   */
  private failClosed(request: AuthorizeRequest, backend: Backend, error: unknown): Authorization {
    let audit: LocalPolicyAuditRecord | null = null;
    try {
      audit = this.store.localPolicyAudit.record({
        requestId: request.requestId ?? null,
        sessionId: request.sessionId,
        agentId: request.agentId,
        backend,
        boundary: request.boundary,
        boundaryAvailable: false,
        toolName: request.toolName,
        decision: "deny",
        source: "error",
      });
    } catch {
      audit = null;
    }
    return {
      allowed: false,
      scope: "local",
      source: "error",
      reason: "error",
      rule: null,
      message:
        "Local policy could not be evaluated, so the tool was refused. " +
        (error instanceof Error ? "See the application log for the failure." : ""),
      grantCreated: false,
      grantId: null,
      audit,
    };
  }

  private audit(
    request: AuthorizeRequest,
    backend: Backend,
    boundaryAvailable: boolean,
    decision: "allow" | "deny",
    source: LocalPolicyAuditSource,
    outcome: LocalPolicyOutcome | null,
    subject: ResolvedSubject | null,
  ): LocalPolicyAuditRecord | null {
    try {
      return this.store.localPolicyAudit.record({
        requestId: request.requestId ?? null,
        sessionId: request.sessionId,
        agentId: request.agentId,
        backend,
        boundary: request.boundary,
        boundaryAvailable,
        toolName: request.toolName,
        decision,
        source,
        ruleId: outcome?.rule?.id ?? null,
        scopeKind: outcome?.scopeKind ?? null,
        scopeId: outcome?.scopeId ?? null,
        memberId: subject?.member.id ?? null,
        memberLabel: subject?.member.label ?? null,
        memberRole: subject?.member.role ?? null,
      });
    } catch {
      // Same reasoning as failClosed: a failed audit never upgrades a refusal
      // into a thrown error, and never turns a denial into an allow.
      return null;
    }
  }
}
