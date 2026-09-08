/**
 * Turning a local `ask` rule into the permission card the user already knows.
 *
 * capygen has one permission surface, and a local restriction must not invent a
 * second one: this broker persists a normal permission block, broadcasts the
 * normal `permission.request`, and takes its answer back through the normal
 * `permission.answer` path. What it adds is attribution — which rule, at which
 * scope, at which boundary — so the card can say why it appeared and link to
 * the rule that caused it.
 *
 * Everything here is about *not* letting an approval mean more than it said:
 *
 *   - **Allow once and Allow for session are different answers.** Once
 *     authorizes this call; for-session mints a grant bound to the agent, the
 *     tool, the exact input and the captured lifecycle. The historical
 *     `allow_always` behaviour is deliberately collapsed to *once* — a
 *     permanent allow is a policy edit, and a card must never mint standing
 *     authority (ADR-0007).
 *   - **A stale answer fails.** An answer for a request that already settled,
 *     was cancelled, or never existed returns failure and authorizes nothing.
 *   - **Cancellation settles.** An aborted call, a session interrupt or a
 *     restrictive reassignment resolves every waiting request as cancelled or
 *     denied, so nothing is left pending against a subject that lost the right
 *     to answer.
 */
import type {
  LocalPolicyAttribution,
  PermissionDecision,
  PermissionRequest,
} from "@capygen/shared";
import type { ApprovalAnswer, ApprovalPrompt } from "./LocalPolicyService.js";

/**
 * Where a published card actually lives.
 *
 * Both ids are required, because the `permission.request` event contract
 * requires both: an event missing one is refused by the event parser *before*
 * any renderer sees it, which is how every local ask came to fail silently
 * while the card sat in the transcript with a null decision.
 */
export interface PublishedCard {
  blockId: string;
  turnId: string;
}

/** How a card reaches the user and how its answer comes back. */
export interface AskBrokerDeps {
  /**
   * Persist the permission block and publish it.
   *
   * Returns null when no card could be shown — there is no turn to attach it
   * to, or persisting or publishing failed. A null answer is **not** a
   * technicality: a prompt nobody can see is a prompt nobody can answer, so
   * the ask refuses rather than waiting for ever on a card that does not
   * exist.
   */
  publish: (card: {
    sessionId: string;
    agentId: string | null;
    originTurnId: string | null;
    request: PermissionRequest;
  }) => PublishedCard | null;
  /** Record the answer on the persisted card, once it is known. */
  settleCard: (info: {
    blockId: string;
    sessionId: string;
    requestId: string;
    decision: PermissionDecision;
  }) => void;
  now?: () => number;
}

/** What `permission.answer` reports back to the renderer. */
export type AnswerOutcome =
  | { ok: true }
  /** The request is not waiting any more: answered, cancelled, or never known. */
  | { ok: false; reason: "stale" };

interface Waiting {
  sessionId: string;
  agentId: string | null;
  requestId: string;
  blockId: string;
  settled: boolean;
  resolve: (answer: ApprovalAnswer) => void;
  detach: () => void;
}

/**
 * Map the renderer's permission vocabulary onto the local one.
 *
 * `allow_always` and `scope: "always"` both arrive from the existing card, and
 * both mean *once* here. That is not a downgrade by accident: a card cannot
 * create standing authority, so the only honest reading of "always" at this
 * boundary is "allow this call, and go edit a rule if you meant more".
 */
export function localAnswerFor(decision: {
  behavior: "allow" | "allow_always" | "deny";
  scope?: "once" | "session" | "always";
  updatedInput?: unknown;
  hasUpdatedInput?: boolean;
}): ApprovalAnswer {
  if (decision.behavior === "deny") return { kind: "deny" };
  const edited = decision.hasUpdatedInput === true;
  const kind = decision.behavior === "allow" && decision.scope === "session"
    ? "allow-session"
    : "allow-once";
  return edited ? { kind, input: decision.updatedInput } : { kind };
}

export class AskBroker {
  private readonly waiting = new Map<string, Waiting>();
  private readonly now: () => number;

  constructor(private readonly deps: AskBrokerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The `AskCallback` the policy service calls.
   *
   * The prompt's frozen input is what the card shows and what an unedited
   * approval authorizes — never the caller's live object.
   */
  ask = async (prompt: ApprovalPrompt, signal: AbortSignal | undefined): Promise<ApprovalAnswer> => {
    if (signal?.aborted) return { kind: "cancelled" };

    const attribution: LocalPolicyAttribution = {
      ruleId: prompt.rule?.id ?? null,
      scope: prompt.rule?.scope ?? null,
      boundary: prompt.boundary,
      // Only when it is not the ordinary one, so an existing card is unchanged.
      ...(prompt.executionSite === "widget-host" ? { executionSite: "widget-host" as const } : {}),
    };
    const request: PermissionRequest = {
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      // The card explains itself: this is capygen's own restriction, not the
      // backend's, and the member label is an unauthenticated display name.
      reason: prompt.executionSite === "widget-host"
        ? `capygen's local policy asks before this ${prompt.toolName} call from an app widget `
          + `(session profile: ${prompt.member.label}).`
        : `capygen's local policy asks before this ${prompt.toolName} call `
          + `(session profile: ${prompt.member.label}).`,
      suggestions: [],
      localPolicy: attribution,
    };

    // One live request per id. A duplicate is refused *before* anything is
    // published, because publishing would put a second card on screen for a
    // request that already has one, and registering would replace the waiter
    // the first call is still blocked on — stranding it permanently.
    if (this.waiting.has(prompt.requestId)) return { kind: "deny" };

    // Published *before* a waiter exists, and only a real card creates one.
    // A failure here — no turn to attach to, a rejected event payload, a
    // storage error — must refuse rather than leave the call waiting on a
    // prompt that was never shown.
    let card: PublishedCard | null = null;
    try {
      card = this.deps.publish({
        sessionId: prompt.sessionId,
        agentId: prompt.agentId,
        originTurnId: prompt.originTurnId,
        request,
      });
    } catch {
      card = null;
    }
    if (!card) return { kind: "deny" };

    return new Promise<ApprovalAnswer>((resolve) => {
      const entry: Waiting = {
        sessionId: prompt.sessionId,
        agentId: prompt.agentId,
        requestId: prompt.requestId,
        blockId: card.blockId,
        settled: false,
        resolve,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = (): void => {
        this.finalize(entry, { kind: "cancelled" }, {
          behavior: "deny",
          scope: "once",
          message: "This call was cancelled before it was answered.",
        });
      };
      this.waiting.set(prompt.requestId, entry);
      // Registered after the entry exists, so an abort that fires immediately
      // finds something to settle.
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };

  /**
   * The one place a waiting request ends.
   *
   * Every exit — an answer, an abort, a reassignment, a released capture,
   * shutdown — comes through here, and every one of them **settles the card**.
   * An earlier version resolved the waiting promise on abort and cancellation
   * without touching the persisted block, which left a permission card sitting
   * in the transcript and the Inbox for ever, waiting on a call that no longer
   * existed. Settling once, with a decision that says what happened, is what
   * keeps the UI honest.
   */
  private finalize(
    entry: Waiting,
    answer: ApprovalAnswer,
    decision: {
      behavior: "allow" | "allow_always" | "deny";
      scope: "once" | "session" | "always";
      updatedInput?: unknown;
      hasUpdatedInput?: boolean;
      message?: string;
    },
  ): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    this.waiting.delete(entry.requestId);
    entry.detach();

    // What was actually applied, not what the button was called. A card
    // authorizes this one call, so neither the legacy `allow_always` behavior
    // nor an explicit `always` scope may be recorded as standing authority —
    // both are the same effective answer, and both must display as once.
    const legacyAlways = decision.behavior === "allow_always" || decision.scope === "always";
    let recorded = answer;
    try {
      this.deps.settleCard({
        blockId: entry.blockId,
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        decision: {
          behavior: decision.behavior === "allow_always" ? "allow" : decision.behavior,
          scope: legacyAlways ? "once" : decision.scope,
          ...(decision.hasUpdatedInput === true ? { updatedInput: decision.updatedInput } : {}),
          ...(decision.message !== undefined ? { message: decision.message } : {}),
          decidedAt: this.now(),
        },
      });
    } catch {
      // The answer could not be persisted. The waiter is already detached and
      // removed, so it must still be resolved — and it must resolve *denied*:
      // an approval nobody could record must never become an executable allow.
      recorded = { kind: "deny" };
    }
    entry.resolve(recorded);
    return true;
  }

  /**
   * Deliver an answer from the existing permission path.
   *
   * Returns `stale` rather than throwing for an unknown request: by the time a
   * click reaches main the call may already have been cancelled, denied by a
   * reassignment, or answered in another window, and none of those is an error
   * the user needs to see as a failure.
   */
  answer(requestId: string, decision: {
    behavior: "allow" | "allow_always" | "deny";
    scope?: "once" | "session" | "always";
    updatedInput?: unknown;
    hasUpdatedInput?: boolean;
  }): AnswerOutcome {
    const entry = this.waiting.get(requestId);
    if (!entry) return { ok: false, reason: "stale" };
    const settled = this.finalize(entry, localAnswerFor(decision), {
      behavior: decision.behavior,
      scope: decision.scope ?? "once",
      ...(decision.hasUpdatedInput === true
        ? { updatedInput: decision.updatedInput, hasUpdatedInput: true }
        : {}),
    });
    return settled ? { ok: true } : { ok: false, reason: "stale" };
  }

  /** True when this broker owns the request; the caller keeps its own path otherwise. */
  owns(requestId: string): boolean {
    return this.waiting.has(requestId);
  }

  /**
   * Settle everything waiting in a session as denied.
   *
   * This is what a restrictive reassignment and an interrupt call: a member who
   * has just lost the right to approve must not have a card still open that
   * would authorize a call if someone clicked it.
   */
  denySession(sessionId: string, reason: string): number {
    let denied = 0;
    for (const entry of [...this.waiting.values()]) {
      if (entry.sessionId !== sessionId) continue;
      if (this.finalize(entry, { kind: "deny" },
        { behavior: "deny", scope: "once", message: reason })) denied += 1;
    }
    return denied;
  }

  /** Settle one agent's waiting requests — a delegated child going away. */
  cancelAgent(sessionId: string, agentId: string | null): number {
    let cancelled = 0;
    for (const entry of [...this.waiting.values()]) {
      if (entry.sessionId !== sessionId || entry.agentId !== agentId) continue;
      if (this.finalize(entry, { kind: "cancelled" }, {
        behavior: "deny", scope: "once",
        message: "The agent this call belonged to is no longer running.",
      })) cancelled += 1;
    }
    return cancelled;
  }

  /** Every waiting request, for the Approve page's aggregation. */
  pending(): Array<{ requestId: string; sessionId: string; agentId: string | null }> {
    return [...this.waiting.values()].map((entry) => ({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
    }));
  }

  /** Settle everything as cancelled — shutdown. */
  dispose(): number {
    let cancelled = 0;
    for (const entry of [...this.waiting.values()]) {
      if (this.finalize(entry, { kind: "cancelled" }, {
        behavior: "deny", scope: "once",
        message: "capygen closed before this call was answered.",
      })) cancelled += 1;
    }
    return cancelled;
  }
}
