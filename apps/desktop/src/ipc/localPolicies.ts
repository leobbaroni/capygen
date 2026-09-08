/**
 * Main-process handlers for the local policy management channels (ADR-0007).
 *
 * A thin, standalone map from channel to the one `LocalPolicyService`: this
 * module owns no policy logic of its own. In particular the preview channel
 * calls the service's evaluator rather than re-implementing matching, so a
 * preview cannot drift from what an actual call would decide.
 *
 * What it does own is the boundary between a renderer and that service:
 *
 *   * every payload is re-parsed here against the channel's own schema, because
 *     a renderer is not a trusted caller even when preload validated first;
 *   * every scope id is resolved against a real project or session before any
 *     action, so a rule cannot be filed against something that does not exist;
 *   * the management actor is the main-owned local desktop operator. It is
 *     never read from the payload — these are execution profiles, not logins,
 *     and a renderer naming a member or a role is not authority;
 *   * every response is re-parsed against the channel's output schema, so a
 *     future field on a service object (a cwd, a lifecycle token, a canonical
 *     input) fails loudly here instead of quietly crossing the bridge;
 *   * failures carry a code and nothing else. A message that interpolated the
 *     caller's pattern, label or tool name would put its own input back on
 *     screen, and these payloads describe tool calls.
 *
 * Central registration is deliberately absent: root merges
 * `LOCAL_POLICY_INVOKE_CHANNELS` into the IPC map and wires this factory.
 */
import type {
  Backend,
  LocalPolicyScope,
  PolicyBoundary,
  PolicyBoundaryAvailability,
  LocalPolicyArgs,
  LocalPolicyAuditRecordDto,
  LocalPolicyChannel,
  LocalPolicyIpcErrorCode,
  LocalPolicyParsedArgs,
  InvokeResult,
} from "@capygen/shared";
import { LocalPolicyAuditRecordSchema, LOCAL_POLICY_INVOKE_CHANNELS } from "@capygen/shared";
import type { LocalPolicyAuditRecord } from "@capygen/db";
import { BUILT_IN_OWNER_MEMBER_ID } from "@capygen/db";
import { LocalPolicyError, type LocalPolicyService, type PolicyActor } from "../policies/index.js";

export const LOCAL_POLICY_CHANNELS = Object.keys(
  LOCAL_POLICY_INVOKE_CHANNELS,
) as readonly LocalPolicyChannel[];

/** A refusal the renderer renders itself; the code is the whole message. */
export class LocalPolicyIpcError extends Error {
  constructor(readonly code: LocalPolicyIpcErrorCode) {
    super(`local policy request refused: ${code}`);
    this.name = "LocalPolicyIpcError";
  }
}

/**
 * The live facts main owns and this module must not guess: what exists, what is
 * a read-only artifact, and what one agent's captured lifecycle can enforce.
 */
export interface LocalPolicyCatalogue {
  sessionExists(sessionId: string): boolean;
  projectExists(projectId: string): boolean;
  /** An imported transcript or received bundle: it never runs, so never assigns. */
  isReadOnlyArtifact(sessionId: string): boolean;
  /** Per agent, with the reason for each unavailable boundary. Never a union. */
  boundaryAvailability(
    sessionId: string,
    agentId: string | null,
  ): { backend: Backend; boundaries: PolicyBoundaryAvailability[] } | null;
}

/** Bounded audit reads. Root injects the repository; see `auditScanLimit`. */
export interface LocalPolicyAuditReader {
  recent(limit: number): LocalPolicyAuditRecord[];
  bySession(sessionId: string, limit: number): LocalPolicyAuditRecord[];
}

export interface LocalPolicyIpcDeps {
  service: LocalPolicyService;
  catalogue: LocalPolicyCatalogue;
  audit?: LocalPolicyAuditReader;
  /**
   * The local desktop operator every management call runs as. Resolved in main
   * from persisted rows; defaults to the built-in owner profile. A renderer
   * cannot influence it, which is the point.
   */
  actor?: () => PolicyActor;
  /** How far back a page may look. Paging is a window, not deep history. */
  auditScanLimit?: number;
  /**
   * Announce a successful management mutation.
   *
   * Metadata only — an area and, where one applies, a session. Never a rule, a
   * label, a tool name or a grant identity: this exists so an open Members,
   * Policies or Approve view can *refetch*, not so it can learn something it
   * could not have asked for. It fires only after a mutation has actually
   * changed something, so a refused edit or a no-op delete does not make every
   * other window reload for nothing.
   */
  publishChanged?: (change: {
    area: "members" | "subjects" | "rules" | "grants" | "runtime";
    sessionId: string | null;
  }) => void;
}

export type LocalPolicyHandlers = {
  [C in LocalPolicyChannel]: (args: LocalPolicyArgs<C>) => Promise<InvokeResult<C>>;
};

const DEFAULT_AUDIT_SCAN_LIMIT = 1000;

/** Parse an incoming payload, reporting only that it was invalid. */
function parseArgs<C extends LocalPolicyChannel>(
  channel: C,
  args: unknown,
): LocalPolicyParsedArgs<C> {
  const parsed = LOCAL_POLICY_INVOKE_CHANNELS[channel].input.safeParse(args);
  if (!parsed.success) throw new LocalPolicyIpcError("invalid-request");
  return parsed.data as LocalPolicyParsedArgs<C>;
}

/**
 * Parse an outgoing payload.
 *
 * A failure here is a contract bug, not a caller error, and it is deliberately
 * fatal to the response: the alternative is letting an unexpected field — the
 * kind a grant matches on — cross the bridge because nobody checked.
 */
function parseResult<C extends LocalPolicyChannel>(
  channel: C,
  value: unknown,
): InvokeResult<C> {
  const parsed = LOCAL_POLICY_INVOKE_CHANNELS[channel].output.safeParse(value);
  if (!parsed.success) throw new LocalPolicyIpcError("unavailable");
  return parsed.data as InvokeResult<C>;
}

/** Service refusals become codes; anything unexpected is `unavailable`. */
function translate(error: unknown): LocalPolicyIpcError {
  if (error instanceof LocalPolicyIpcError) return error;
  if (error instanceof LocalPolicyError) {
    switch (error.code) {
      case "not-owner":
      case "built-in-member":
        return new LocalPolicyIpcError("not-permitted");
      case "unknown-member":
        return new LocalPolicyIpcError("unknown-member");
      case "unknown-session":
        return new LocalPolicyIpcError("unknown-session");
      case "member-assigned":
        return new LocalPolicyIpcError("member-assigned");
      case "session-busy":
        return new LocalPolicyIpcError("session-busy");
      default:
        return new LocalPolicyIpcError("unavailable");
    }
  }
  // A zod failure from a repository, a SQLite error: neither is describable to
  // the renderer without quoting the payload or the storage layer.
  return new LocalPolicyIpcError("unavailable");
}

function auditToDto(record: LocalPolicyAuditRecord): LocalPolicyAuditRecordDto {
  // Field by field on purpose: a spread would forward whatever the repository
  // grows next, which is exactly what the DTO exists to prevent.
  return LocalPolicyAuditRecordSchema.parse({
    id: record.id,
    ts: record.ts,
    requestId: record.requestId ?? null,
    sessionId: record.sessionId ?? null,
    agentId: record.agentId ?? null,
    backend: record.backend,
    boundary: record.boundary,
    boundaryAvailable: record.boundaryAvailable,
    toolName: record.toolName,
    decision: record.decision,
    source: record.source,
    ruleId: record.ruleId ?? null,
    scopeKind: record.scopeKind ?? null,
    scopeId: record.scopeId ?? null,
    memberId: record.memberId ?? null,
    memberLabel: record.memberLabel ?? null,
    memberRole: record.memberRole ?? null,
    // Defaulted here as well as in the repository: a row written before the
    // column existed truthfully ran at a backend site.
    executionSite: record.executionSite ?? "backend",
  });
}

export function createLocalPolicyHandlers(deps: LocalPolicyIpcDeps): LocalPolicyHandlers {
  const { service, catalogue } = deps;
  const scanLimit = deps.auditScanLimit ?? DEFAULT_AUDIT_SCAN_LIMIT;
  const actor = (): PolicyActor => deps.actor?.() ?? { memberId: BUILT_IN_OWNER_MEMBER_ID };

  const requireSession = (sessionId: string): void => {
    if (!catalogue.sessionExists(sessionId)) throw new LocalPolicyIpcError("unknown-session");
  };

  /** A scope names ids, so those ids must resolve before a rule can use them. */
  const requireScope = (scope: LocalPolicyScope): void => {
    if (scope.kind === "project" && !catalogue.projectExists(scope.projectId)) {
      throw new LocalPolicyIpcError("unknown-project");
    }
    if (scope.kind === "session" && !catalogue.sessionExists(scope.sessionId)) {
      throw new LocalPolicyIpcError("unknown-session");
    }
  };

  const boundaryReport = (sessionId: string, agentId: string | null) => {
    const report = catalogue.boundaryAvailability(sessionId, agentId);
    if (!report) throw new LocalPolicyIpcError("unknown-session");
    return report;
  };

  const isAvailable = (
    boundaries: readonly PolicyBoundaryAvailability[],
    boundary: PolicyBoundary,
  ): boolean => boundaries.some((entry) => entry.boundary === boundary && entry.available);

  const auditWindow = (sessionId: string | null): LocalPolicyAuditRecord[] => {
    if (deps.audit) {
      return sessionId ? deps.audit.bySession(sessionId, scanLimit) : deps.audit.recent(scanLimit);
    }
    // Fallback for a caller that injected only the service: the same bounded
    // window, filtered here. Root injects the repository so a session's page
    // is not limited by how busy other sessions were.
    const recent = service.recentAudit(scanLimit);
    return sessionId ? recent.filter((record) => record.sessionId === sessionId) : recent;
  };

  /** Wrap one handler so every refusal leaves as a code. */
  /**
   * Run one channel, and — for a mutation — announce it once it has succeeded.
   *
   * `invalidate` is consulted only after the work and the output parse have
   * both succeeded, so a refusal never invalidates anything. Returning null
   * from it means "nothing actually changed": a delete that removed no row and
   * a revoke that matched no grant leave every other window alone.
   */
  const handler = <C extends LocalPolicyChannel>(
    channel: C,
    run: (args: LocalPolicyParsedArgs<C>) => unknown,
    invalidate?: (
      args: LocalPolicyParsedArgs<C>,
      result: unknown,
    ) => { area: "members" | "subjects" | "rules" | "grants" | "runtime"; sessionId: string | null } | null,
  ) => async (args: LocalPolicyArgs<C>): Promise<InvokeResult<C>> => {
    try {
      const parsed = parseArgs(channel, args);
      const outcome = await run(parsed);
      const result = parseResult(channel, outcome);
      if (invalidate) {
        const change = invalidate(parsed, outcome);
        if (change) deps.publishChanged?.(change);
      }
      return result;
    } catch (error) {
      throw translate(error);
    }
  };

  const members = () => ({ area: "members" as const, sessionId: null });
  /** A session-scoped rule names its session so that view can refetch precisely. */
  const rules = (scope: LocalPolicyScope | undefined) => ({
    area: "rules" as const,
    sessionId: scope?.kind === "session" ? scope.sessionId : null,
  });

  return {
    "policy.members.list": handler("policy.members.list", () => ({
      members: service.listMembers(),
    })),
    "policy.members.create": handler("policy.members.create", (args) => ({
      member: service.createMember(actor(), { label: args.label, role: args.role }),
    }), members),
    "policy.members.update": handler("policy.members.update", (args) => ({
      member: service.updateMember(actor(), args.memberId, {
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(args.role === undefined ? {} : { role: args.role }),
      }),
    }), members),
    "policy.members.remove": handler("policy.members.remove", (args) => ({
      removed: service.removeMember(actor(), args.memberId),
    }), (_args, result) =>
      (result as { removed: boolean }).removed ? members() : null),

    "policy.session.subject.get": handler("policy.session.subject.get", (args) => {
      requireSession(args.sessionId);
      const subject = service.resolveSubject(args.sessionId);
      // A null subject is a real state — the assigned profile is gone — and the
      // UI must show it as a refusal, not resolve it to the owner.
      return { subject: subject ? { sessionId: args.sessionId, member: subject.member, explicit: subject.explicit } : null };
    }),
    "policy.session.subject.assign": handler("policy.session.subject.assign", (args) => {
      requireSession(args.sessionId);
      if (catalogue.isReadOnlyArtifact(args.sessionId)) {
        throw new LocalPolicyIpcError("read-only-artifact");
      }
      const member = service.assignMember(actor(), args.sessionId, args.memberId);
      return { subject: { sessionId: args.sessionId, member, explicit: true } };
    }, (args) => ({ area: "subjects", sessionId: args.sessionId })),

    "policy.rules.list": handler("policy.rules.list", (args) => {
      const scope = args.scope ?? null;
      const rules = service.listRules().filter((rule) => {
        if (!scope) return true;
        if (rule.scope.kind !== scope.kind) return false;
        if (scope.kind === "project") return rule.scope.kind === "project"
          && rule.scope.projectId === scope.projectId;
        if (scope.kind === "session") return rule.scope.kind === "session"
          && rule.scope.sessionId === scope.sessionId;
        return true;
      });
      return { rules };
    }),
    "policy.rules.create": handler("policy.rules.create", (args) => {
      requireScope(args.scope);
      return { rule: service.createRule(actor(), args) };
    }, (args) => rules(args.scope)),
    "policy.rules.update": handler("policy.rules.update", (args) => {
      const { ruleId, ...patch } = args;
      if (!service.listRules().some((rule) => rule.id === ruleId)) {
        throw new LocalPolicyIpcError("unknown-rule");
      }
      if (patch.scope) requireScope(patch.scope);
      return { rule: service.updateRule(actor(), ruleId, patch) };
    }, (_args, result) => rules((result as { rule: { scope: LocalPolicyScope } }).rule.scope)),
    "policy.rules.remove": handler("policy.rules.remove", (args) => ({
      removed: service.removeRule(actor(), args.ruleId),
    }), (_args, result) =>
      (result as { removed: boolean }).removed ? { area: "rules", sessionId: null } : null),
    "policy.rules.preview": handler("policy.rules.preview", (args) => {
      requireSession(args.sessionId);
      const report = boundaryReport(args.sessionId, args.agentId);
      // The service's own evaluator, so a preview cannot drift from a decision.
      const outcome = service.evaluate({
        sessionId: args.sessionId,
        agentId: args.agentId,
        boundary: args.boundary,
        toolName: args.toolName,
      });
      return {
        decision: outcome.decision,
        source: outcome.source,
        ruleId: outcome.rule?.id ?? null,
        scopeKind: outcome.scopeKind,
        scopeId: outcome.scopeId,
        matchedRuleIds: outcome.matched.map((rule) => rule.id),
        boundaryAvailable: isAvailable(report.boundaries, args.boundary),
      };
    }),

    "policy.grants.list": handler("policy.grants.list", () => ({
      grants: service.listGrants(),
    })),
    "policy.grants.revoke": handler("policy.grants.revoke", (args) => ({
      revoked: service.revokeGrantById(actor(), args.grantId),
    }), (_args, result) =>
      // The grant's own session is not named: a grant id is private identity,
      // and every open view refetches its own scope anyway.
      (result as { revoked: boolean }).revoked ? { area: "grants", sessionId: null } : null),

    "policy.audit.list": handler("policy.audit.list", (args) => {
      if (args.sessionId) requireSession(args.sessionId);
      const window = auditWindow(args.sessionId);
      let start = 0;
      if (args.cursor) {
        const at = window.findIndex((record) => record.id === args.cursor);
        // A cursor that has fallen out of the window is not resumable; saying
        // so beats silently restarting the page at the top.
        if (at < 0) throw new LocalPolicyIpcError("invalid-request");
        start = at + 1;
      }
      const page = window.slice(start, start + args.limit);
      const consumed = start + page.length;
      const last = page[page.length - 1];
      return {
        records: page.map(auditToDto),
        nextCursor: consumed < window.length && last ? last.id : null,
        truncated: window.length >= scanLimit,
      };
    }),

    "policy.boundaries.availability": handler("policy.boundaries.availability", (args) => {
      requireSession(args.sessionId);
      const report = boundaryReport(args.sessionId, args.agentId);
      return {
        sessionId: args.sessionId,
        agentId: args.agentId,
        backend: report.backend,
        boundaries: report.boundaries,
      };
    }),
  };
}
