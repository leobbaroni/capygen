/**
 * Management IPC handlers for local policy (ADR-0007), over a real store.
 *
 * The handlers are the renderer-facing surface, so the cases here are mostly
 * about what a renderer must *not* be able to do: name its own actor, assign a
 * profile to a read-only artifact, reach a scope id that does not exist, or
 * read back the material a grant matches on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_OWNER_MEMBER_ID, openStore, type CapygenStore } from "@capygen/db";
import type { PolicyBoundaryAvailability } from "@capygen/shared";
import { LocalPolicyService, type AgentPolicyContext } from "../src/policies/index.js";
import {
  LOCAL_POLICY_CHANNELS,
  LocalPolicyIpcError,
  createLocalPolicyHandlers,
  type LocalPolicyCatalogue,
  type LocalPolicyHandlers,
} from "../src/ipc/localPolicies.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let sessionId: string;
let service: LocalPolicyService;
let handlers: LocalPolicyHandlers;
let interrupted: string[];
let quiescent: boolean;
let readOnlySessions: Set<string>;
let availability: PolicyBoundaryAvailability[];

const context = (): AgentPolicyContext => ({
  projectId, readOnly: false, backend: "api", lifecycleToken: "tok_api",
  availableBoundaries: availability.filter((b) => b.available).map((b) => b.boundary),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-ipc-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project"), name: "Project" }).id;
  sessionId = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;

  interrupted = [];
  quiescent = true;
  readOnlySessions = new Set();
  availability = [
    { boundary: "api-tool", available: true, reason: null },
    { boundary: "codex-command-approval", available: false, reason: "unsupported-backend" },
  ];

  service = new LocalPolicyService({
    store,
    resolveContext: (id, agentId) =>
      id === sessionId && agentId === "agt_api" && !readOnlySessions.has(id) ? context() : null,
    ask: async () => ({ kind: "deny" }),
    interruptAndDeny: (id) => interrupted.push(id),
    isQuiescent: () => quiescent,
  });

  const catalogue: LocalPolicyCatalogue = {
    sessionExists: (id) => store.sessions.get(id) !== null && store.sessions.get(id) !== undefined,
    projectExists: (id) => store.projects.get(id) !== null && store.projects.get(id) !== undefined,
    isReadOnlyArtifact: (id) => readOnlySessions.has(id),
    boundaryAvailability: (id, agentId) =>
      id === sessionId && agentId === "agt_api"
        ? { backend: "api", boundaries: availability }
        : null,
  };
  handlers = createLocalPolicyHandlers({ service, catalogue });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const codeOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof LocalPolicyIpcError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-error";
};

describe("member and rule management round-trips through the store", () => {
  it("creates, lists, updates and removes a profile", async () => {
    const created = await handlers["policy.members.create"]({ label: "Reviewer", role: "viewer" });
    expect(created.member).toMatchObject({ label: "Reviewer", role: "viewer", builtIn: false });

    const listed = await handlers["policy.members.list"]({});
    expect(listed.members.map((m) => m.id)).toContain(created.member.id);
    expect(listed.members.some((m) => m.id === BUILT_IN_OWNER_MEMBER_ID)).toBe(true);

    const updated = await handlers["policy.members.update"]({
      memberId: created.member.id, label: "Auditor", role: "editor",
    });
    expect(updated.member).toMatchObject({ label: "Auditor", role: "editor" });

    // Persistence, not an in-memory illusion.
    expect(store.localMembers.get(created.member.id)?.label).toBe("Auditor");
    expect(await handlers["policy.members.remove"]({ memberId: created.member.id }))
      .toEqual({ removed: true });
    expect(store.localMembers.get(created.member.id)).toBeNull();
  });

  it("creates, lists, updates and removes a restriction", async () => {
    const created = await handlers["policy.rules.create"]({
      scope: { kind: "session", sessionId }, boundary: "api-tool",
      pattern: "mcp__docs__*", decision: "ask", enabled: true,
    });
    expect(created.rule).toMatchObject({ decision: "ask", pattern: "mcp__docs__*" });
    expect((await handlers["policy.rules.list"]({})).rules).toHaveLength(1);

    const updated = await handlers["policy.rules.update"]({
      ruleId: created.rule.id, decision: "deny",
    });
    expect(updated.rule.decision).toBe("deny");
    expect(store.localPolicyRules.get(created.rule.id)?.decision).toBe("deny");
    expect(await handlers["policy.rules.remove"]({ ruleId: created.rule.id }))
      .toEqual({ removed: true });
    expect(store.localPolicyRules.list()).toEqual([]);
  });
});

describe("the session subject is main's to resolve", () => {
  it("reports the built-in owner for a session that never chose a profile", async () => {
    const subject = await handlers["policy.session.subject.get"]({ sessionId });
    expect(subject.subject).toMatchObject({ explicit: false });
    expect(subject.subject?.member.id).toBe(BUILT_IN_OWNER_MEMBER_ID);
  });

  it("assigns a viewer immediately, interrupting the session, and refuses a busy reassignment", async () => {
    const viewer = await handlers["policy.members.create"]({ label: "Reviewer", role: "viewer" });
    const editor = await handlers["policy.members.create"]({ label: "Editor", role: "editor" });
    quiescent = false;

    // Restrictive reassignment does not wait for quiet; it interrupts.
    await handlers["policy.session.subject.assign"]({ sessionId, memberId: viewer.member.id });
    expect(interrupted).toEqual([sessionId]);
    expect(store.sessionMembers.get(sessionId)?.memberId).toBe(viewer.member.id);

    // An ordinary one does.
    expect(await codeOf(() =>
      handlers["policy.session.subject.assign"]({ sessionId, memberId: editor.member.id })))
      .toBe("session-busy");
    quiescent = true;
    await handlers["policy.session.subject.assign"]({ sessionId, memberId: editor.member.id });
    expect(store.sessionMembers.get(sessionId)?.memberId).toBe(editor.member.id);
  });

  it("refuses to delete a profile a session still names", async () => {
    const member = await handlers["policy.members.create"]({ label: "Editor", role: "editor" });
    await handlers["policy.session.subject.assign"]({ sessionId, memberId: member.member.id });
    expect(await codeOf(() => handlers["policy.members.remove"]({ memberId: member.member.id })))
      .toBe("member-assigned");
    expect(store.localMembers.get(member.member.id)).not.toBeNull();
  });

  it("refuses to assign a profile to a read-only imported artifact", async () => {
    readOnlySessions.add(sessionId);
    const member = await handlers["policy.members.create"]({ label: "Editor", role: "editor" });
    expect(await codeOf(() =>
      handlers["policy.session.subject.assign"]({ sessionId, memberId: member.member.id })))
      .toBe("read-only-artifact");
    expect(store.sessionMembers.get(sessionId)).toBeNull();
  });
});

describe("identifiers and payloads are checked before anything happens", () => {
  it("refuses scope ids and record ids that do not exist", async () => {
    expect(await codeOf(() => handlers["policy.rules.create"]({
      scope: { kind: "project", projectId: "prj_missing" }, boundary: "api-tool",
      pattern: "*", decision: "deny", enabled: true,
    }))).toBe("unknown-project");
    expect(await codeOf(() => handlers["policy.rules.create"]({
      scope: { kind: "session", sessionId: "ses_missing" }, boundary: "api-tool",
      pattern: "*", decision: "deny", enabled: true,
    }))).toBe("unknown-session");
    expect(await codeOf(() => handlers["policy.rules.update"]({ ruleId: "lpr_missing", decision: "deny" })))
      .toBe("unknown-rule");
    expect(await codeOf(() => handlers["policy.session.subject.assign"]({
      sessionId, memberId: "mbr_missing",
    }))).toBe("unknown-member");
    expect(await codeOf(() => handlers["policy.session.subject.get"]({ sessionId: "ses_missing" })))
      .toBe("unknown-session");
    expect(store.localPolicyRules.list()).toEqual([]);
  });

  it("refuses a malformed payload without echoing any of it back", async () => {
    const bad = { pattern: "tool(args)", scope: { kind: "session", sessionId }, boundary: "api-tool",
      decision: "deny", enabled: true, secretHint: "s3cret-key-name" };
    let message = "";
    try {
      await handlers["policy.rules.create"](bad as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("s3cret-key-name");
    expect(message).not.toContain("tool(args)");
    expect(store.localPolicyRules.list()).toEqual([]);
  });

  it("refuses a renderer that tries to name its own management actor", async () => {
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    store.sessionMembers.set(sessionId, viewer.id);
    const rule = {
      scope: { kind: "global" }, boundary: "api-tool", pattern: "*",
      decision: "deny", enabled: true,
    };
    for (const spoof of [{ actor: { memberId: viewer.id } }, { asMember: viewer.id },
      { role: "owner" }, { memberId: viewer.id }]) {
      expect(await codeOf(() => handlers["policy.rules.create"]({ ...rule, ...spoof } as never)))
        .toBe("invalid-request");
    }
    expect(store.localPolicyRules.list()).toEqual([]);

    // The same session's subject is a viewer, and the same call still succeeds:
    // management runs as the main-owned local operator, not as that subject.
    const created = await handlers["policy.rules.create"](rule as never);
    expect(created.rule.decision).toBe("deny");
    expect(store.localPolicyRules.list()).toHaveLength(1);
  });
});

describe("read surfaces expose metadata only", () => {
  it("lists grants without the material they match on, and revokes by opaque id", async () => {
    service.grants.grant({
      sessionId, agentId: "agt_api", backend: "api", boundary: "api-tool",
      toolName: "mcp__docs__search", inputCanonical: '{"query":"a-secret-looking-value"}',
      cwd: "C:/work/app", lifecycleToken: "tok_api",
    }, { projectId });

    const listed = await handlers["policy.grants.list"]({});
    expect(listed.grants).toHaveLength(1);
    const serialized = JSON.stringify(listed);
    for (const secret of ["a-secret-looking-value", "tok_api", "C:/work/app"]) {
      expect(serialized).not.toContain(secret);
    }
    const grantId = listed.grants[0]!.grantId;
    expect(await handlers["policy.grants.revoke"]({ grantId })).toEqual({ revoked: true });
    expect(service.grants.size).toBe(0);
  });

  it("pages the audit with a bounded window and metadata-only records", async () => {
    for (let i = 0; i < 5; i += 1) {
      store.localPolicyAudit.record({
        sessionId, backend: "api", boundary: "api-tool", boundaryAvailable: true,
        toolName: `tool_${i}`, decision: "allow", source: "default",
      });
    }
    // Paging follows the reader's own order and partitions it exactly: no
    // record is repeated across pages and none is skipped. (Order inside one
    // millisecond is by row id, so the pages are stable rather than strictly
    // chronological — see the reported seam.)
    const order = store.localPolicyAudit.bySession(sessionId, 100).map((r) => r.id);
    expect(order).toHaveLength(5);

    const first = await handlers["policy.audit.list"]({ sessionId, limit: 2 });
    expect(first.records.map((r) => r.id)).toEqual(order.slice(0, 2));
    expect(first.nextCursor).toBe(order[1]);
    const second = await handlers["policy.audit.list"]({
      sessionId, limit: 2, cursor: first.nextCursor,
    });
    expect(second.records.map((r) => r.id)).toEqual(order.slice(2, 4));
    const last = await handlers["policy.audit.list"]({
      sessionId, limit: 2, cursor: second.nextCursor,
    });
    expect(last.records.map((r) => r.id)).toEqual(order.slice(4));
    expect(last.nextCursor).toBeNull();
    expect(last.truncated).toBe(false);
    expect(Object.keys(first.records[0] ?? {})).not.toContain("cwd");

    // A cursor that has fallen out of the window is refused, not restarted.
    expect(await codeOf(() => handlers["policy.audit.list"]({ sessionId, cursor: "lpa_gone" })))
      .toBe("invalid-request");
  });

  it("reports per-agent boundary availability with its reasons, never a union", async () => {
    const reported = await handlers["policy.boundaries.availability"]({
      sessionId, agentId: "agt_api",
    });
    expect(reported.backend).toBe("api");
    expect(reported.boundaries).toEqual(availability);
    expect(await codeOf(() => handlers["policy.boundaries.availability"]({
      sessionId, agentId: "agt_other",
    }))).toBe("unknown-session");
  });
});

describe("evaluation preview is the service's own evaluator", () => {
  it("agrees with the service for every decision and names the attributed rule", async () => {
    const rule = await handlers["policy.rules.create"]({
      scope: { kind: "session", sessionId }, boundary: "api-tool",
      pattern: "mcp__docs__*", decision: "deny", enabled: true,
    });
    const preview = await handlers["policy.rules.preview"]({
      sessionId, agentId: "agt_api", boundary: "api-tool", toolName: "mcp__docs__search",
    });
    const direct = service.evaluate({
      sessionId, agentId: "agt_api", boundary: "api-tool", toolName: "mcp__docs__search",
    });
    expect(preview).toMatchObject({
      decision: direct.decision, source: direct.source, ruleId: rule.rule.id,
      scopeKind: "session", scopeId: sessionId, boundaryAvailable: true,
    });
    expect(preview.matchedRuleIds).toEqual(direct.matched.map((r) => r.id));

    const unmatched = await handlers["policy.rules.preview"]({
      sessionId, agentId: "agt_api", boundary: "api-tool", toolName: "Bash",
    });
    expect(unmatched).toMatchObject({ decision: "allow", source: "default", ruleId: null });

    // A boundary this agent cannot enforce is reported as such, not as allowed.
    const unavailable = await handlers["policy.rules.preview"]({
      sessionId, agentId: "agt_api", boundary: "codex-command-approval", toolName: "shell",
    });
    expect(unavailable.boundaryAvailable).toBe(false);
  });

  it("names every channel it handles", () => {
    expect(Object.keys(handlers).sort()).toEqual([...LOCAL_POLICY_CHANNELS].sort());
  });
});
