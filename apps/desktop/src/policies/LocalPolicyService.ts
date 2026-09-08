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
import { randomUUID } from "node:crypto";
import {
  policyBoundaryBackend,
  type Backend,
  type LocalMember,
  type LocalMemberDraft,
  type LocalPolicyRule,
  type LocalPolicyRuleDraft,
  type PolicyBoundary,
  type PolicyAuditSite,
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
 * The boundary a backend's own tool calls are restricted at.
 *
 * A widget's call is evaluated against *this* — the boundary the user already
 * writes rules at for that agent — so a restriction on the agent's tools also
 * governs a widget its result opened, and a widget is never a way around it.
 *
 * Codex is the deliberate one. `codex-dynamic-tool` is capygen's
 * **client-hosted** tool channel; Codex's *native* MCP servers come from the
 * user's own `config.toml`, run inside the Codex runtime, and capygen cannot
 * intercept them at all. The command and file approval categories are a
 * different thing again — a native approval prompt, not a tool call — and are
 * deliberately **not** reachable from an app host.
 */
export function originToolBoundary(backend: Backend): PolicyBoundary {
  switch (backend) {
    case "api": return "api-tool";
    case "claude": return "claude-pre-tool";
    case "codex": return "codex-dynamic-tool";
    default: return "api-tool";
  }
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
  /**
   * Where calls against this capture are actually intercepted.
   *
   * A property of the **capture**, never of the request: main sets it when it
   * records the capture, so a caller cannot name a site to reach a rule set it
   * was not captured for. A request still states its own site, and the two must
   * agree — that is what makes naming one useless as a bypass.
   */
  executionSite?: "backend" | "widget-host";
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
  /**
   * The turn this call belongs to, as main resolved it.
   *
   * Carried rather than derived: a delegated child and a widget both run under
   * ids that have no turn row of their own, so anything that tried to look a
   * turn up from the agent id would find none and publish a card nobody could
   * answer. Null when main could not resolve one, which refuses the ask.
   */
  originTurnId: string | null;
  /** Where this call is intercepted, for the card's own honesty. */
  executionSite: "backend" | "widget-host";
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
  /** The turn a card for this call belongs to; main resolves it, never this. */
  originTurnId?: string | null;
  /**
   * Where this call is actually intercepted.
   *
   * `backend` (the default) means the boundary is one the agent's captured
   * backend offers, and the usual capability check applies.
   *
   * `widget-host` means capygen's **own** MCP client executes the call, for an
   * app widget the backend has already finished with. That is a different
   * execution site, not a different authority: the session, the agent, the
   * execution subject and the applicable rules are still the origin's, and the
   * origin's own restrictions still govern — a widget must not be a way around
   * a rule the user wrote for the agent whose result opened it. What the site
   * *does* decide is availability: the interception is capygen's, so it does
   * not depend on what the origin backend can offer.
   */
  executionSite?: "backend" | "widget-host";
  /**
   * Where in one call's life this check sits (engine `LocalAuthorizationRequest`).
   *
   * A Claude call is checked twice: `pre` at the PreToolUse hook, `final`
   * immediately before execution. Both re-evaluate the *current* restrictions;
   * `stage` only decides whether an answer already given for this exact call
   * may stand in for asking the user a second time.
   */
  stage?: "pre" | "final";
  /** The backend's own id for this call; stable across both checks. */
  callId?: string;
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

/**
 * What a `pre` check decided, waiting for the `final` check of the same call.
 *
 * This is **not** a cached authorization. It is a receipt for one answer the
 * user already gave, and it can only ever save asking them the same question
 * twice: `final` re-evaluates the current rules, member and grants from
 * scratch, and consults this only when that evaluation lands on `ask` again.
 * It is invalidated by anything that could change the answer — a policy edit, a
 * demotion, a revocation, a lifecycle ending — because its epoch is compared
 * against the live one, and it is consumed on first use.
 */
interface PreauthorizationReceipt {
  /** Every part of the call's identity, so it cannot stand in for another. */
  sessionId: string;
  agentId: string | null;
  lifecycleToken: string;
  boundary: PolicyBoundary;
  toolName: string;
  cwd: string;
  /** The canonical form of the input that was actually approved. */
  canonicalInput: string;
  /** Authority as it stood when the answer was given. */
  epoch: AuthorizationEpoch;
  /** The user's answer — never an authorization in itself. */
  kind: "allow-once" | "allow-session";
  approvedInput: unknown;
}

/** Receipts held at once; a bound, so an abandoned call cannot grow this. */
const MAX_RECEIPTS = 256;

export class LocalPolicyService {
  readonly grants: SessionGrantRegistry;
  /** callId → the one receipt awaiting its `final` check. */
  private readonly receipts = new Map<string, PreauthorizationReceipt>();
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
  /**
   * One admitted authorization's execution site, keyed by the request object.
   *
   * Weak on purpose: the entry lives exactly as long as the caller's own
   * request, so a long-lived service accumulates nothing and two concurrent
   * authorizations cannot read each other's snapshot.
   */
  private readonly admissionSites = new WeakMap<AuthorizeRequest, PolicyAuditSite>();

  async authorize(incoming: AuthorizeRequest): Promise<Authorization> {
    /**
     * [review] One invocation, one identity.
     *
     * The admission snapshot is keyed by the request object, and a caller may
     * legitimately hand the *same* object to two overlapping authorizations —
     * a retry, a queued pair. Sharing one key would let the second admission
     * overwrite the first, and both rows would then report the later site.
     *
     * A shallow clone is the whole fix: it is unique per invocation while
     * `signal` and `input` stay the very same references, so cancellation still
     * works and the existing input snapshot is unchanged. Nothing about
     * authority moves — this only separates two bookkeeping entries.
     */
    const request: AuthorizeRequest = { ...incoming };
    const backend = policyBoundaryBackend(request.boundary);
    // [review] Snapshotted **at admission**, before anything awaits.
    //
    // The audit site used to be re-resolved when the row was written, which is
    // after an approval may have been waited on. A widget connection can end
    // while its card is open: by the time a cancellation was recorded the
    // capture was gone, and the row claimed `backend` for a call that ran at
    // the widget host — attribution silently rewritten by a disposal. A capture
    // replaced mid-flight would have moved it the other way.
    //
    // This is a *record* of what was admitted, never authority: the live
    // authorization checks below still re-resolve the capture on every path, so
    // nothing here can make a stale capture permit anything.
    this.admissionSites.set(request, this.siteAtAdmission(request));
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
      const capability = this.capabilityProblem(
        request.boundary, backend, context, request.executionSite);
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

      // A `final` check for a call whose `pre` check the user already answered
      // reuses **that answer**, not an authorization: everything above has just
      // been re-evaluated against the current rules, member, grants and
      // lifecycle, and only the question is skipped. Anything that could change
      // the answer has already invalidated the receipt through its epoch.
      const reused = this.takeReceipt(request, snapshot.canonical, epoch);
      // Deliberately without an `input` property: the receipt only survives when
      // the canonical input still matches, so the value below is already the
      // one that was approved. Synthesising an `input` here would look like a
      // fresh operator edit and be sent back through edit validation.
      const asked = reused
        ? { cancelled: false as const, value: { kind: reused.kind } }
        : await this.race(this.deps.ask(
        {
          // Unique per prompt, never derived from the clock: two parallel
          // calls to one tool inside a single millisecond produced the same id
          // under the old scheme, and the second card silently replaced the
          // first's waiter — leaving one call unanswerable for ever.
          requestId: request.requestId ?? `ask_${randomUUID()}`,
          sessionId: request.sessionId,
          agentId: request.agentId,
          backend,
          boundary: request.boundary,
          toolName: request.toolName,
          input: snapshot.value,
          cwd: request.cwd,
          rule: outcome.rule,
          member: subject.member,
          originTurnId: request.originTurnId ?? null,
          executionSite: request.executionSite ?? "backend",
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

      if (request.stage === "pre" && request.callId !== undefined && !reused) {
        // The user answered a `pre` check. Record *the answer*, with the exact
        // identity it was given for and the authority it was given under, so
        // the `final` check for this same call need not ask again. This is not
        // an authorization: `final` re-evaluates everything above from scratch
        // and only reaches here if it lands on `ask` all over again.
        this.putReceipt(request.callId, {
          sessionId: request.sessionId,
          agentId: request.agentId,
          lifecycleToken: request.lifecycleToken,
          boundary: request.boundary,
          toolName: request.toolName,
          cwd: request.cwd,
          canonicalInput: approved.canonical,
          epoch,
          kind,
          approvedInput: approved.value,
        });
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
    if (this.capabilityProblem(request.boundary, backend, context, request.executionSite)) {
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
    requestSite: "backend" | "widget-host" = "backend",
  ): string | null {
    // Backend equality is checked **always**, at every site. With the origin
    // tool family it holds naturally for a widget too (a Claude widget is
    // judged at `claude-pre-tool`, whose backend is claude), so there was never
    // anything for a site to excuse — and skipping it would have let a call
    // name any backend's boundary.
    if (backend !== context.backend) {
      return `This agent targets ${context.backend}; a ${boundary} request cannot be authorized for it.`;
    }
    // The site is the capture's. A request that claims a different one is
    // refused rather than believed: it is the only thing a caller supplies
    // here, so it may narrow nothing and unlock nothing.
    const capturedSite = context.executionSite ?? "backend";
    if (requestSite !== capturedSite) {
      return `This request claims to run at capygen's ${requestSite}, but this agent was captured at its ${capturedSite}.`;
    }
    if (capturedSite === "widget-host") {
      // An app host executes *tool calls*, so only the origin's tool family is
      // reachable from one. A native approval category — Codex's command or
      // file prompts — is not a tool call and must not become addressable by
      // opening a widget.
      const family = originToolBoundary(context.backend);
      if (boundary !== family) {
        return `An app widget can only be authorized against the ${family} boundary.`;
      }
      // Availability is the site's: capygen's own MCP client intercepts this,
      // so it does not depend on what the origin backend offers.
      return null;
    }
    if (!context.availableBoundaries.includes(boundary)) {
      return `This agent's captured backend cannot enforce the ${boundary} boundary.`;
    }
    return null;
  }

  /**
   * Take the receipt for this call, if it is still valid for *this* request.
   *
   * Every part of the call's identity has to match — session, agent, lifecycle,
   * boundary, tool, cwd and the canonical input — and so does the authority it
   * was given under. A policy edit, a demotion, a revocation or a lifecycle
   * ending all move an epoch, and a moved epoch discards the receipt: the user
   * is asked again rather than carried by an answer that predates the change.
   *
   * Consumed on first use, and consumed even when it does not match, so a
   * receipt can never be replayed.
   */
  private takeReceipt(
    request: AuthorizeRequest,
    canonicalInput: string,
    epoch: AuthorizationEpoch,
  ): PreauthorizationReceipt | null {
    if (request.stage !== "final" || request.callId === undefined) return null;
    const receipt = this.receipts.get(request.callId);
    if (!receipt) return null;
    this.receipts.delete(request.callId);
    if (request.signal?.aborted) return null;
    const sameCall =
      receipt.sessionId === request.sessionId
      && receipt.agentId === request.agentId
      && receipt.lifecycleToken === request.lifecycleToken
      && receipt.boundary === request.boundary
      && receipt.toolName === request.toolName
      && receipt.cwd === request.cwd
      && receipt.canonicalInput === canonicalInput;
    if (!sameCall) return null;
    const sameAuthority =
      receipt.epoch.session === epoch.session
      && receipt.epoch.lifecycle === epoch.lifecycle
      && receipt.epoch.revocation === epoch.revocation
      && receipt.epoch.fingerprint === epoch.fingerprint;
    return sameAuthority ? receipt : null;
  }

  private putReceipt(callId: string, receipt: PreauthorizationReceipt): void {
    if (this.receipts.size >= MAX_RECEIPTS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
    this.receipts.set(callId, receipt);
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
        executionSite: this.capturedSite(request),
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

  /**
   * The site this authorization was admitted at, for its audit rows.
   *
   * Falls back to the admission-time reading only when there is none — a
   * `failClosed` that fired before `authorize` recorded one.
   */
  private capturedSite(request: AuthorizeRequest): PolicyAuditSite {
    return this.admissionSites.get(request) ?? this.siteAtAdmission(request);
  }

  /**
   * Read once, from main's captured context — never from `request.executionSite`.
   *
   * The request's copy is caller-supplied, and `capabilityProblem` already
   * refuses any request whose claim disagrees with its capture; reading the
   * captured value keeps that true of the log as well, so an audit row can
   * never report a site a caller merely asserted.
   *
   * No capture at all is `"unknown"`, not `"backend"`: a decision recorded for
   * an agent main knows nothing about did not run at a backend site — nothing
   * is known about where it would have run, and the row should say so.
   *
   * [review] The same applies to a capture that exists but is not *this*
   * request's. A stale or mistaken `lifecycleToken` is refused by the
   * authorization path; the log must not meanwhile borrow the site of whatever
   * lifecycle happens to be current, which would attribute the decision to a
   * connection it had nothing to do with.
   */
  private siteAtAdmission(request: AuthorizeRequest): PolicyAuditSite {
    try {
      const context = this.deps.resolveContext(request.sessionId, request.agentId ?? null);
      if (!context) return "unknown";
      if (context.lifecycleToken !== request.lifecycleToken) return "unknown";
      return context.executionSite ?? "backend";
    } catch {
      return "unknown";
    }
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
        executionSite: this.capturedSite(request),
      });
    } catch {
      // Same reasoning as failClosed: a failed audit never upgrades a refusal
      // into a thrown error, and never turns a denial into an allow.
      return null;
    }
  }
}
