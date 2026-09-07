/**
 * In-memory session grants (ADR-0007 "Grants, cancellation and audit").
 *
 * A grant is not a policy rule. It only satisfies an exact `ask` outcome after
 * the current deny checks have already run, and it can never override a deny.
 * "Allow for session" mints one; nothing else does, and no button anywhere
 * creates a permanent one — an explicit policy edit is the persistent way to
 * allow a tool.
 *
 * Why memory and not SQLite: a grant is bound to the opaque authorization
 * lifecycle token main mints per harness and per captured MCP-pool connection.
 * A restarted harness or a new connection instance gets a new token even when
 * its settings look identical, so a persisted grant would necessarily be a
 * grant for a lifecycle that no longer exists.
 *
 * Equality is exact. The signature covers session, originating agent, backend,
 * boundary, tool, the complete canonical JSON input, the execution cwd and the
 * lifecycle token — no wildcard matching, no field elision, no Unicode
 * normalization. A different input, agent, cwd or restarted backend lifecycle is
 * simply not this grant.
 *
 * The token is an opaque string the service has already verified against the
 * agent's captured lifecycle. Nothing here derives credential identity, and
 * neither the token nor the connection identity behind it is ever exposed in
 * grant UI or written to the audit.
 *
 * The registry never holds the tool input itself, only the canonical text of
 * the snapshot the service took (`inputSnapshot.ts`). Together with `describe()`
 * — an opaque id plus safe metadata, no cwd, no token, no signature — that is
 * what keeps the material a grant *matches on* from reaching a listing, an IPC
 * payload or a log.
 */
import { canonicalJson } from "@capygen/db";
import type { Backend, PolicyBoundary } from "@capygen/shared";

export interface GrantIdentity {
  sessionId: string;
  /** The agent that originated the call; a delegated child is a different one. */
  agentId: string | null;
  backend: Backend;
  boundary: PolicyBoundary;
  toolName: string;
  /** Canonical text of the approved input snapshot, never the live object. */
  inputCanonical: string;
  /** The execution working directory, part of the signature. */
  cwd: string;
  /** Opaque token for the captured harness/connection lifecycle. */
  lifecycleToken: string;
}

export interface GrantRecord {
  /** Opaque handle for revoking one grant without naming what it matches. */
  grantId: string;
  signature: string;
  sessionId: string;
  agentId: string | null;
  backend: Backend;
  boundary: PolicyBoundary;
  toolName: string;
  cwd: string;
  lifecycleToken: string;
  /** Captured so a project-scoped policy edit can invalidate without a query. */
  projectId: string | null;
  grantedAt: number;
}

/** What a listing, an IPC reply or a log may see. */
export interface GrantSummary {
  grantId: string;
  sessionId: string;
  agentId: string | null;
  backend: Backend;
  boundary: PolicyBoundary;
  toolName: string;
  grantedAt: number;
}

/**
 * Canonical, exact identity of one grant.
 *
 * `inputCanonical` already sorts object keys recursively while preserving array
 * order and string bytes, so `{a:1,b:2}` and `{b:2,a:1}` are the same input and
 * `["a","b"]` and `["b","a"]` are not.
 */
export function grantSignature(identity: GrantIdentity): string {
  return canonicalJson([
    identity.sessionId,
    identity.agentId,
    identity.backend,
    identity.boundary,
    identity.toolName,
    identity.cwd,
    identity.lifecycleToken,
    identity.inputCanonical,
  ]);
}

export interface GrantContext {
  projectId?: string | null;
  now?: () => number;
}

/** Grants held for the life of this process. */
export class SessionGrantRegistry {
  private readonly grants = new Map<string, GrantRecord>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  get size(): number {
    return this.grants.size;
  }

  has(identity: GrantIdentity): boolean {
    return this.grants.has(grantSignature(identity));
  }

  /** Idempotent: re-granting the same exact identity keeps the first record. */
  grant(identity: GrantIdentity, context: GrantContext = {}): GrantRecord {
    const signature = grantSignature(identity);
    const existing = this.grants.get(signature);
    if (existing) return existing;
    const record: GrantRecord = {
      grantId: `grt_${crypto.randomUUID().replaceAll("-", "")}`,
      signature,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      backend: identity.backend,
      boundary: identity.boundary,
      toolName: identity.toolName,
      cwd: identity.cwd,
      lifecycleToken: identity.lifecycleToken,
      projectId: context.projectId ?? null,
      grantedAt: (context.now ?? this.clock)(),
    };
    this.grants.set(signature, record);
    return record;
  }

  /**
   * Safe metadata only. There is deliberately no accessor that hands out a
   * record: the signature, the canonical input and the lifecycle token stay
   * inside this object, so a caller cannot forward them by accident.
   */
  describe(): GrantSummary[] {
    return [...this.grants.values()].map((record) => ({
      grantId: record.grantId,
      sessionId: record.sessionId,
      agentId: record.agentId,
      backend: record.backend,
      boundary: record.boundary,
      toolName: record.toolName,
      grantedAt: record.grantedAt,
    }));
  }

  /** Revoke by the opaque handle a listing carries. */
  revokeById(grantId: string): boolean {
    return this.revokeMatching((record) => record.grantId === grantId) > 0;
  }

  /** The one primitive every revocation below is written in terms of. */
  revokeMatching(predicate: (record: GrantRecord) => boolean): number {
    let removed = 0;
    for (const [signature, record] of [...this.grants]) {
      if (!predicate(record)) continue;
      this.grants.delete(signature);
      removed += 1;
    }
    return removed;
  }

  /** Session shutdown, and any reassignment of the session's execution role. */
  revokeSession(sessionId: string): number {
    return this.revokeMatching((record) => record.sessionId === sessionId);
  }

  /** A restarted harness or a replaced connection: its old token is dead. */
  revokeLifecycle(lifecycleToken: string): number {
    return this.revokeMatching((record) => record.lifecycleToken === lifecycleToken);
  }

  revokeAgent(sessionId: string, agentId: string | null): number {
    return this.revokeMatching(
      (record) => record.sessionId === sessionId && record.agentId === agentId,
    );
  }

  revokeAll(): number {
    const removed = this.grants.size;
    this.grants.clear();
    return removed;
  }
}
