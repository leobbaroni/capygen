/**
 * Local execution policy persistence (ADR-0007, migration 0010).
 *
 * Three things live here and nothing else: named local execution profiles, the
 * session→profile assignment, and capygen's own bounded restriction rules —
 * plus the metadata-only decision audit. Backend configuration files remain
 * authoritative for native permission rules, and `ToolPoliciesRepo` (the
 * `policies` cache of those native rules) is a different store with a different
 * job; nothing here reads or writes it.
 *
 * Grants are absent on purpose. A session grant is bound to a captured harness
 * or MCP-pool lifecycle token, so it cannot outlive the process that minted the
 * token; it lives in main-process memory instead (apps/desktop/src/policies).
 *
 * Every write re-validates against the @capygen/shared schemas. A repository
 * caller is not a trusted caller: a rule that reached here from an IPC payload
 * has crossed a process boundary, and the schema is what keeps an unbounded
 * matcher out of the table.
 */
import {
  LocalMemberDraftSchema,
  LocalMemberSchema,
  LocalPolicyRuleDraftSchema,
  LocalPolicyRuleSchema,
  LocalPolicyScopeSchema,
  policyBoundaryBackend,
  type Backend,
  type LocalMember,
  type LocalMemberDraft,
  type LocalMemberRole,
  type LocalPolicyDecision,
  type LocalPolicyRule,
  type LocalPolicyRuleDraft,
  type LocalPolicyScope,
  type PolicyBoundary,
} from "@capygen/shared";
import type { Database, Row } from "./driver.js";
import { intToBool, boolToInt } from "./driver.js";

/** The single seeded profile every pre-existing session resolves to. */
export const BUILT_IN_OWNER_MEMBER_ID = "mbr_builtin_owner";

const now = (): number => Date.now();

/**
 * Ids for rows this store owns. `@capygen/shared`'s `newId` has a fixed set of
 * prefixes and adding one is a shared-package change; these three prefixes stay
 * local until that contract is widened, and the shape matches (`pfx_<uuid>`).
 */
function localId(prefix: "mbr" | "lpr" | "lpa"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** SQLite has no boolean; the scope columns are the discriminator's payload. */
function scopeColumns(scope: LocalPolicyScope): { kind: string; projectId: string | null; sessionId: string | null } {
  if (scope.kind === "project") return { kind: "project", projectId: scope.projectId, sessionId: null };
  if (scope.kind === "session") return { kind: "session", projectId: null, sessionId: scope.sessionId };
  return { kind: "global", projectId: null, sessionId: null };
}

function rowToScope(row: Row): LocalPolicyScope {
  const kind = String(row.scope_kind);
  if (kind === "project") return LocalPolicyScopeSchema.parse({ kind, projectId: String(row.project_id) });
  if (kind === "session") return LocalPolicyScopeSchema.parse({ kind, sessionId: String(row.session_id) });
  return LocalPolicyScopeSchema.parse({ kind: "global" });
}

function rowToMember(row: Row): LocalMember {
  return LocalMemberSchema.parse({
    id: String(row.id),
    label: String(row.label),
    role: String(row.role),
    builtIn: intToBool(row.built_in),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function rowToRule(row: Row): LocalPolicyRule {
  return LocalPolicyRuleSchema.parse({
    id: String(row.id),
    scope: rowToScope(row),
    boundary: String(row.boundary),
    pattern: String(row.pattern),
    decision: String(row.decision),
    enabled: intToBool(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/** The identity of a scope, for attribution and for grant invalidation. */
export function scopeId(scope: LocalPolicyScope): string | null {
  if (scope.kind === "project") return scope.projectId;
  if (scope.kind === "session") return scope.sessionId;
  return null;
}

/**
 * Named local execution profiles. Labels are unauthenticated display strings;
 * nothing here authenticates a person, and the UI must not present one as if it
 * did (ADR-0007 "Local identity boundary").
 */
export class LocalMembersRepo {
  constructor(private readonly db: Database) {}

  /** The seeded owner. Missing means migration 0010 did not run — fail loudly. */
  builtInOwner(): LocalMember {
    const row = this.db.get<Row>("SELECT * FROM local_members WHERE built_in = 1");
    if (!row) throw new Error("local_members has no built-in owner profile");
    return rowToMember(row);
  }

  list(): LocalMember[] {
    return this.db
      .all<Row>("SELECT * FROM local_members ORDER BY built_in DESC, label, id")
      .map(rowToMember);
  }

  get(id: string): LocalMember | null {
    const row = this.db.get<Row>("SELECT * FROM local_members WHERE id = ?", id);
    return row ? rowToMember(row) : null;
  }

  create(draft: LocalMemberDraft): LocalMember {
    const parsed = LocalMemberDraftSchema.parse(draft);
    const id = localId("mbr");
    const ts = now();
    this.db.run(
      `INSERT INTO local_members (id, label, role, built_in, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      id, parsed.label, parsed.role, ts, ts,
    );
    return this.require(id);
  }

  /** Rename or re-role a profile. The built-in owner refuses a role change. */
  update(id: string, patch: Partial<LocalMemberDraft>): LocalMember {
    const current = this.get(id);
    if (!current) throw new Error(`unknown local member: ${id}`);
    const next = LocalMemberDraftSchema.parse({
      label: patch.label ?? current.label,
      role: patch.role ?? current.role,
    });
    this.db.run(
      "UPDATE local_members SET label = ?, role = ?, updated_at = ? WHERE id = ?",
      next.label, next.role, now(), id,
    );
    return this.require(id);
  }

  /**
   * Sessions currently assigned to `id`. The caller refuses a delete with this
   * list; the schema's ON DELETE RESTRICT is only the backstop.
   */
  assignedSessionIds(id: string): string[] {
    return this.db
      .all<{ session_id: string }>(
        "SELECT session_id FROM session_member_assignments WHERE member_id = ? ORDER BY session_id",
        id,
      )
      .map((r) => r.session_id);
  }

  /** Refused for the built-in profile and for any profile still assigned. */
  remove(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    if (current.builtIn) throw new Error("the built-in owner profile cannot be deleted");
    const assigned = this.assignedSessionIds(id);
    if (assigned.length > 0) {
      throw new Error(
        `local member ${id} is still assigned to ${assigned.length} session(s): ${assigned.join(", ")}`,
      );
    }
    return this.db.run("DELETE FROM local_members WHERE id = ?", id) > 0;
  }

  private require(id: string): LocalMember {
    const found = this.get(id);
    if (!found) throw new Error(`local member vanished immediately after write: ${id}`);
    return found;
  }
}

export interface SessionMemberAssignment {
  sessionId: string;
  memberId: string;
  assignedAt: number;
}

/** Why a session has no usable execution subject. */
export type ResolvedSubjectProblem = "missing-member";

export interface ResolvedSubject {
  sessionId: string;
  member: LocalMember;
  /** False when the session never chose a profile and uses the built-in owner. */
  explicit: boolean;
}

/**
 * The persisted session→profile assignment.
 *
 * A session with no row resolves to the built-in owner — that is the consistent
 * default for every session that existed before migration 0010, not a fallback.
 * A row pointing at a member that is gone resolves to *nothing*: ADR-0007 says a
 * missing assigned member never silently becomes the owner.
 */
export class SessionMembersRepo {
  constructor(private readonly db: Database, private readonly members: LocalMembersRepo) {}

  get(sessionId: string): SessionMemberAssignment | null {
    const row = this.db.get<Row>(
      "SELECT * FROM session_member_assignments WHERE session_id = ?", sessionId,
    );
    return row
      ? { sessionId, memberId: String(row.member_id), assignedAt: Number(row.assigned_at) }
      : null;
  }

  resolve(sessionId: string): ResolvedSubject | null {
    const assignment = this.get(sessionId);
    if (!assignment) return { sessionId, member: this.members.builtInOwner(), explicit: false };
    const member = this.members.get(assignment.memberId);
    return member ? { sessionId, member, explicit: true } : null;
  }

  set(sessionId: string, memberId: string): SessionMemberAssignment {
    if (!this.members.get(memberId)) throw new Error(`unknown local member: ${memberId}`);
    this.db.run(
      `INSERT INTO session_member_assignments (session_id, member_id, assigned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         member_id   = excluded.member_id,
         assigned_at = excluded.assigned_at`,
      sessionId, memberId, now(),
    );
    const written = this.get(sessionId);
    if (!written) throw new Error(`assignment vanished immediately after write: ${sessionId}`);
    return written;
  }

  /** Drop the explicit choice; the session goes back to the built-in owner. */
  clear(sessionId: string): boolean {
    return this.db.run("DELETE FROM session_member_assignments WHERE session_id = ?", sessionId) > 0;
  }
}

export interface LocalPolicyRuleQuery {
  projectId?: string | null;
  sessionId?: string | null;
  /** Omit for every rule; `true` for the ones evaluation may act on. */
  enabledOnly?: boolean;
}

/**
 * Capygen's own bounded restriction rules.
 *
 * Scope identity is explicit ids, so a project rule can never be confused with
 * another project's by name. `backend` is derived from `boundary` and stored
 * only so a query can filter without decoding; the schema's CHECK makes a
 * contradictory pair unrepresentable.
 */
export class LocalPolicyRulesRepo {
  constructor(private readonly db: Database) {}

  get(id: string): LocalPolicyRule | null {
    const row = this.db.get<Row>("SELECT * FROM local_policy_rules WHERE id = ?", id);
    return row ? rowToRule(row) : null;
  }

  list(): LocalPolicyRule[] {
    return this.db
      .all<Row>("SELECT * FROM local_policy_rules ORDER BY scope_kind, boundary, pattern, id")
      .map(rowToRule);
  }

  /**
   * Every rule that *could* apply to one session: the global rules, this
   * project's, and this session's. Precedence and matching are decided by the
   * evaluator, not by SQL — a narrower allow must never be able to hide a
   * broader deny by ordering.
   */
  applicable(query: LocalPolicyRuleQuery): LocalPolicyRule[] {
    const rows = this.db.all<Row>(
      `SELECT * FROM local_policy_rules
        WHERE (scope_kind = 'global')
           OR (scope_kind = 'project' AND project_id = ?)
           OR (scope_kind = 'session' AND session_id = ?)
        ORDER BY scope_kind, boundary, pattern, id`,
      query.projectId ?? "",
      query.sessionId ?? "",
    );
    const rules = rows.map(rowToRule);
    return query.enabledOnly ? rules.filter((rule) => rule.enabled) : rules;
  }

  create(draft: LocalPolicyRuleDraft): LocalPolicyRule {
    const parsed = LocalPolicyRuleDraftSchema.parse(draft);
    const id = localId("lpr");
    const ts = now();
    this.write(id, parsed, ts, ts);
    return this.require(id);
  }

  /** Merge-and-revalidate: a patch can never produce a rule the draft schema
   *  would have rejected outright. */
  update(id: string, patch: Partial<LocalPolicyRuleDraft>): LocalPolicyRule {
    const current = this.get(id);
    if (!current) throw new Error(`unknown local policy rule: ${id}`);
    const next = LocalPolicyRuleDraftSchema.parse({
      scope: patch.scope ?? current.scope,
      boundary: patch.boundary ?? current.boundary,
      pattern: patch.pattern ?? current.pattern,
      decision: patch.decision ?? current.decision,
      enabled: patch.enabled ?? current.enabled,
    });
    this.write(id, next, current.createdAt, now());
    return this.require(id);
  }

  remove(id: string): boolean {
    return this.db.run("DELETE FROM local_policy_rules WHERE id = ?", id) > 0;
  }

  private write(id: string, rule: LocalPolicyRuleDraft, createdAt: number, updatedAt: number): void {
    const scope = scopeColumns(rule.scope);
    const backend: Backend = policyBoundaryBackend(rule.boundary);
    this.db.run(
      `INSERT INTO local_policy_rules
         (id, scope_kind, project_id, session_id, boundary, backend, pattern, decision,
          enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         scope_kind = excluded.scope_kind,
         project_id = excluded.project_id,
         session_id = excluded.session_id,
         boundary   = excluded.boundary,
         backend    = excluded.backend,
         pattern    = excluded.pattern,
         decision   = excluded.decision,
         enabled    = excluded.enabled,
         updated_at = excluded.updated_at`,
      id, scope.kind, scope.projectId, scope.sessionId, rule.boundary, backend,
      rule.pattern, rule.decision, boolToInt(rule.enabled), createdAt, updatedAt,
    );
  }

  private require(id: string): LocalPolicyRule {
    const found = this.get(id);
    if (!found) throw new Error(`local policy rule vanished immediately after write: ${id}`);
    return found;
  }
}

/** Where a decision came from. `subject` is a refusal by execution role. */
export type LocalPolicyAuditSource =
  | "rule" | "grant" | "default" | "approval" | "subject" | "error";

/**
 * One decision, metadata only.
 *
 * There is deliberately no field for tool arguments, an argument hash,
 * credentials, tool output or raw exception text (ADR-0007). The absence of the
 * field is the enforcement; a convention would be forgotten by the next writer.
 */
export interface LocalPolicyAuditDraft {
  requestId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  backend: Backend;
  boundary: PolicyBoundary;
  /** Whether the named boundary was actually available for this request. */
  boundaryAvailable: boolean;
  toolName: string;
  decision: LocalPolicyDecision;
  source: LocalPolicyAuditSource;
  ruleId?: string | null;
  scopeKind?: LocalPolicyScope["kind"] | null;
  scopeId?: string | null;
  memberId?: string | null;
  /** An unauthenticated display label, as it read at decision time. */
  memberLabel?: string | null;
  memberRole?: LocalMemberRole | null;
}

export interface LocalPolicyAuditRecord extends LocalPolicyAuditDraft {
  id: string;
  ts: number;
}

function rowToAudit(row: Row): LocalPolicyAuditRecord {
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    ts: Number(row.ts),
    requestId: text(row.request_id),
    sessionId: text(row.session_id),
    agentId: text(row.agent_id),
    backend: String(row.backend) as Backend,
    boundary: String(row.boundary) as PolicyBoundary,
    boundaryAvailable: intToBool(row.boundary_available),
    toolName: String(row.tool_name),
    decision: String(row.decision) as LocalPolicyDecision,
    source: String(row.source) as LocalPolicyAuditSource,
    ruleId: text(row.rule_id),
    scopeKind: text(row.scope_kind) as LocalPolicyScope["kind"] | null,
    scopeId: text(row.scope_id),
    memberId: text(row.member_id),
    memberLabel: text(row.member_label),
    memberRole: text(row.member_role) as LocalMemberRole | null,
  };
}

/**
 * The bounded decision log.
 *
 * Bounded twice over: by column (nothing sensitive has anywhere to go) and by
 * row count — the log is an operator aid, not an archive, so it keeps the most
 * recent `retain` records and drops the rest as it writes.
 */
export class LocalPolicyAuditRepo {
  constructor(private readonly db: Database, private readonly retain = 5000) {}

  record(draft: LocalPolicyAuditDraft): LocalPolicyAuditRecord {
    const id = localId("lpa");
    const ts = now();
    // Truncation over refusal: a display label from a renamed profile must not
    // be able to fail the write that records why execution was refused.
    const toolName = draft.toolName.slice(0, 256);
    const memberLabel = draft.memberLabel ? draft.memberLabel.slice(0, 120) : null;
    this.db.run(
      `INSERT INTO local_policy_audit
         (id, ts, request_id, session_id, agent_id, backend, boundary, boundary_available,
          tool_name, decision, source, rule_id, scope_kind, scope_id, member_id,
          member_label, member_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ts, draft.requestId ?? null, draft.sessionId ?? null, draft.agentId ?? null,
      draft.backend, draft.boundary, boolToInt(draft.boundaryAvailable), toolName,
      draft.decision, draft.source, draft.ruleId ?? null, draft.scopeKind ?? null,
      draft.scopeId ?? null, draft.memberId ?? null, memberLabel, draft.memberRole ?? null,
    );
    this.prune();
    const written = this.db.get<Row>("SELECT * FROM local_policy_audit WHERE id = ?", id);
    if (!written) throw new Error("audit record vanished immediately after write");
    return rowToAudit(written);
  }

  recent(limit = 100): LocalPolicyAuditRecord[] {
    return this.db
      .all<Row>("SELECT * FROM local_policy_audit ORDER BY ts DESC, id DESC LIMIT ?", Math.max(1, limit))
      .map(rowToAudit);
  }

  bySession(sessionId: string, limit = 100): LocalPolicyAuditRecord[] {
    return this.db
      .all<Row>(
        "SELECT * FROM local_policy_audit WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
        sessionId, Math.max(1, limit),
      )
      .map(rowToAudit);
  }

  count(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM local_policy_audit")?.n ?? 0);
  }

  /** Keep the newest `retain` rows. Ordered by the same key `recent` reads. */
  prune(): number {
    return this.db.run(
      `DELETE FROM local_policy_audit WHERE id NOT IN (
         SELECT id FROM local_policy_audit ORDER BY ts DESC, id DESC LIMIT ?
       )`,
      this.retain,
    );
  }
}
