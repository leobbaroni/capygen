import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_OWNER_MEMBER_ID,
  openStore,
  readMigrations,
  openDatabase,
  LocalPolicyAuditRepo,
  type CapygenStore,
} from "../src/index.js";
import type { LocalPolicyRuleDraft } from "@capygen/shared";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;
let projectId: string;
let sessionId: string;

const open = (): CapygenStore => openStore(file, { migrationsDir: MIGRATIONS_DIR });

const rule = (over: Partial<LocalPolicyRuleDraft> = {}): LocalPolicyRuleDraft => ({
  scope: { kind: "global" }, boundary: "api-tool", pattern: "mcp__docs__*",
  decision: "deny", enabled: true, ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-local-policies-"));
  file = path.join(dir, "capygen.db");
  store = open();
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project"), name: "Project" }).id;
  sessionId = store.sessions.create({ projectId, mode: "solo", title: "Live", agents: [] }).session.id;
});

afterEach(() => {
  try { store.close(); } catch { /* already closed by a case */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 0010 — local policy schema", () => {
  it("preserves the legacy parity rows and the native tool-policy cache", () => {
    // Build a pre-0010 database, put a row in each legacy table, then migrate.
    store.close();
    fs.rmSync(file, { force: true });
    const all = readMigrations(MIGRATIONS_DIR);
    const before = all.filter((m) => m.id < "0010");
    expect(before.length).toBe(all.length - 1);
    const legacy = openDatabase(file, { migrations: before });
    legacy.db.run(
      "INSERT INTO members (id, name, role, created_at) VALUES ('m1', 'Legacy', 'owner', 1)",
    );
    legacy.db.run(
      `INSERT INTO approvals (id, session_id, block_id, decision, decided_by, created_at)
       VALUES ('a1', NULL, NULL, 'allow_always', 'user', 1)`,
    );
    legacy.db.run(
      `INSERT INTO policies (id, backend, scope, session_id, pattern, action, created_at, updated_at)
       VALUES ('p1', 'claude', 'global', NULL, 'Bash', 'ask', 1, 1)`,
    );
    legacy.db.close();

    store = open();
    expect(store.migration.applied).toEqual(["0010_local_policies"]);
    expect(store.db.get("SELECT name FROM members WHERE id = 'm1'")).toEqual({ name: "Legacy" });
    // The historical allow_always record survives as history and is not
    // migrated into any authority table.
    expect(store.db.get("SELECT decision FROM approvals WHERE id = 'a1'"))
      .toEqual({ decision: "allow_always" });
    expect(store.db.all("SELECT id FROM local_policy_rules")).toEqual([]);
    expect(store.toolPolicies.listByBackend("claude")).toHaveLength(1);
  });

  it("seeds exactly one built-in owner that cannot be demoted or deleted", () => {
    const owner = store.localMembers.builtInOwner();
    expect(owner.id).toBe(BUILT_IN_OWNER_MEMBER_ID);
    expect(owner).toMatchObject({ role: "owner", builtIn: true });
    expect(() =>
      store.db.run("INSERT INTO local_members (id, label, role, built_in, created_at, updated_at) VALUES ('x','X','owner',1,1,1)"),
    ).toThrow();
    expect(() => store.db.run("UPDATE local_members SET role = 'viewer' WHERE built_in = 1")).toThrow(/built-in/);
    expect(() => store.db.run("DELETE FROM local_members WHERE built_in = 1")).toThrow(/built-in/);
    expect(() => store.localMembers.remove(BUILT_IN_OWNER_MEMBER_ID)).toThrow(/built-in/);
  });

  it("makes a contradictory scope or backend unrepresentable, not merely unwritten", () => {
    const insert = (columns: string, values: string) =>
      store.db.run(
        `INSERT INTO local_policy_rules (id, ${columns}, pattern, decision, enabled, created_at, updated_at)
         VALUES ('r1', ${values}, 'Bash', 'deny', 1, 1, 1)`,
      );
    // project scope with no project id, session scope carrying a project id,
    // global scope carrying an id, and a backend that contradicts its boundary.
    expect(() => insert("scope_kind, project_id, session_id, boundary, backend",
      "'project', NULL, NULL, 'api-tool', 'api'")).toThrow();
    expect(() => insert("scope_kind, project_id, session_id, boundary, backend",
      `'session', '${projectId}', '${sessionId}', 'api-tool', 'api'`)).toThrow();
    expect(() => insert("scope_kind, project_id, session_id, boundary, backend",
      `'global', '${projectId}', NULL, 'api-tool', 'api'`)).toThrow();
    expect(() => insert("scope_kind, project_id, session_id, boundary, backend",
      "'global', NULL, NULL, 'api-tool', 'claude'")).toThrow();
    expect(() => insert("scope_kind, project_id, session_id, boundary, backend",
      "'global', NULL, NULL, 'codex-file-approval', 'claude'")).toThrow();
  });

  it("keeps one rule per scope, boundary and pattern even when the scope ids are NULL", () => {
    store.localPolicyRules.create(rule());
    expect(() => store.localPolicyRules.create(rule())).toThrow();
    // A different scope with the same pattern is a different rule.
    expect(store.localPolicyRules.create(rule({ scope: { kind: "session", sessionId } }))).toBeTruthy();
    expect(store.localPolicyRules.create(rule({ scope: { kind: "project", projectId } }))).toBeTruthy();
    expect(store.localPolicyRules.list()).toHaveLength(3);
  });

  it("stores the backend derived from the boundary rather than a supplied one", () => {
    store.localPolicyRules.create(rule({ boundary: "claude-pre-tool", pattern: "Bash" }));
    store.localPolicyRules.create(rule({ boundary: "codex-command-approval", pattern: "Bash" }));
    expect(store.db.all("SELECT boundary, backend FROM local_policy_rules ORDER BY backend")).toEqual([
      { boundary: "api-tool", backend: "api" },
      { boundary: "claude-pre-tool", backend: "claude" },
      { boundary: "codex-command-approval", backend: "codex" },
    ].filter((row) => row.boundary !== "api-tool"));
  });

  it("has nowhere to put a tool argument, credential or output in the audit", () => {
    const columns = store.db
      .all<{ name: string }>("PRAGMA table_info(local_policy_audit)")
      .map((c) => c.name);
    for (const forbidden of ["input", "input_json", "arguments", "args", "argument_hash",
      "input_sha256", "signature", "credential", "token", "output", "result", "error"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(columns).toContain("boundary_available");
    expect(columns).toContain("member_label");
  });
});

describe("local policy repositories", () => {
  it("resolves a session with no assignment to the built-in owner", () => {
    const resolved = store.sessionMembers.resolve(sessionId);
    expect(resolved).toMatchObject({ explicit: false });
    expect(resolved?.member.id).toBe(BUILT_IN_OWNER_MEMBER_ID);
  });

  it("refuses to delete a member a session still names, and cascades on session delete", () => {
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    store.sessionMembers.set(sessionId, viewer.id);
    expect(store.localMembers.assignedSessionIds(viewer.id)).toEqual([sessionId]);
    expect(() => store.localMembers.remove(viewer.id)).toThrow(/still assigned/);
    // The schema is the backstop for a caller that skips the repository.
    expect(() => store.db.run("DELETE FROM local_members WHERE id = ?", viewer.id)).toThrow();

    store.db.run("DELETE FROM sessions WHERE id = ?", sessionId);
    expect(store.sessionMembers.get(sessionId)).toBeNull();
    expect(store.localMembers.remove(viewer.id)).toBe(true);
  });

  it("resolves nothing — never the owner — when an assigned member is gone", () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    store.sessionMembers.set(sessionId, editor.id);
    // Force the state the ON DELETE RESTRICT normally prevents, to prove the
    // read path fails closed rather than substituting the owner.
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.run("DELETE FROM local_members WHERE id = ?", editor.id);
    store.db.exec("PRAGMA foreign_keys = ON");
    expect(store.sessionMembers.resolve(sessionId)).toBeNull();
  });

  it("returns only the rules whose scope covers a session", () => {
    const otherProject = store.projects.upsertByPath({ path: path.join(dir, "other"), name: "Other" }).id;
    const otherSession = store.sessions
      .create({ projectId: otherProject, mode: "solo", agents: [] }).session.id;
    const global = store.localPolicyRules.create(rule({ pattern: "a" }));
    const mine = store.localPolicyRules.create(rule({ scope: { kind: "project", projectId }, pattern: "b" }));
    const theirs = store.localPolicyRules.create(
      rule({ scope: { kind: "project", projectId: otherProject }, pattern: "c" }));
    const session = store.localPolicyRules.create(rule({ scope: { kind: "session", sessionId }, pattern: "d" }));
    store.localPolicyRules.create(rule({ scope: { kind: "session", sessionId: otherSession }, pattern: "e" }));

    const ids = store.localPolicyRules.applicable({ projectId, sessionId }).map((r) => r.id).sort();
    expect(ids).toEqual([global.id, mine.id, session.id].sort());
    expect(ids).not.toContain(theirs.id);

    store.localPolicyRules.update(session.id, { enabled: false });
    expect(store.localPolicyRules.applicable({ projectId, sessionId, enabledOnly: true })
      .map((r) => r.id)).not.toContain(session.id);
  });

  it("revalidates a patch instead of trusting it, and keeps createdAt", () => {
    const created = store.localPolicyRules.create(rule());
    const updated = store.localPolicyRules.update(created.id, { decision: "ask" });
    expect(updated).toMatchObject({ id: created.id, decision: "ask", createdAt: created.createdAt });
    expect(() => store.localPolicyRules.update(created.id, { pattern: "tool(args)" })).toThrow();
    expect(store.localPolicyRules.get(created.id)?.pattern).toBe("mcp__docs__*");
  });

  it("rolls back a whole unit when one rule in it is invalid", () => {
    expect(() =>
      store.db.transaction(() => {
        store.localPolicyRules.create(rule({ pattern: "first" }));
        store.localPolicyRules.create(rule({ pattern: "[a-z]" }));
      }),
    ).toThrow();
    expect(store.localPolicyRules.list()).toEqual([]);
  });

  it("records bounded decision metadata and keeps only the newest rows", () => {
    const record = store.localPolicyAudit.record({
      requestId: "req_1", sessionId, agentId: null, backend: "api", boundary: "api-tool",
      boundaryAvailable: true, toolName: "mcp__docs__search", decision: "deny", source: "rule",
      ruleId: "lpr_1", scopeKind: "global", scopeId: null,
      memberId: BUILT_IN_OWNER_MEMBER_ID, memberLabel: "Owner", memberRole: "owner",
    });
    expect(record).toMatchObject({ decision: "deny", source: "rule", boundaryAvailable: true });
    expect(store.localPolicyAudit.bySession(sessionId)).toHaveLength(1);

    const bounded = new LocalPolicyAuditRepo(store.db, 3);
    for (let i = 0; i < 6; i += 1) {
      bounded.record({
        sessionId, backend: "api", boundary: "api-tool", boundaryAvailable: true,
        toolName: `t${i}`, decision: "allow", source: "default",
      });
    }
    expect(bounded.count()).toBe(3);
    expect(bounded.recent(10).map((r) => r.toolName)).toEqual(["t5", "t4", "t3"]);
  });
});
