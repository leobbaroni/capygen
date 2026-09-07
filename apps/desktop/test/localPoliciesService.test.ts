import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_OWNER_MEMBER_ID, openStore, type CapygenStore } from "@capygen/db";
import type { Backend, LocalPolicyRuleDraft, PolicyBoundary } from "@capygen/shared";
import {
  LocalPolicyError,
  LocalPolicyService,
  type ApprovalAnswer,
  type ApprovalPrompt,
  type AgentPolicyContext,
  type AuthorizeRequest,
} from "../src/policies/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let sessionId: string;
let service: LocalPolicyService;

/** Injected surroundings, mutated per case. */
let readOnly: boolean;
let quiescent: boolean;
let backend: Backend;
let boundaries: PolicyBoundary[];
let interrupted: Array<{ sessionId: string; reason: string }>;
let answer: (prompt: ApprovalPrompt, signal: AbortSignal | undefined) => Promise<ApprovalAnswer>;
let asked: ApprovalPrompt[];

const owner = { memberId: BUILT_IN_OWNER_MEMBER_ID } as const;

const draft = (over: Partial<LocalPolicyRuleDraft> = {}): LocalPolicyRuleDraft => ({
  scope: { kind: "global" }, boundary: "api-tool", pattern: "mcp__docs__*",
  decision: "deny", enabled: true, ...over,
});

const call = (over: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  requestId: "req_1", sessionId, agentId: "agt_1", boundary: "api-tool",
  toolName: "mcp__docs__search", input: { query: "capybara" },
  cwd: "C:/work/app", lifecycleToken: "tok_1", ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-service-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project"), name: "Project" }).id;
  sessionId = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;

  readOnly = false;
  quiescent = true;
  backend = "api";
  boundaries = ["api-tool"];
  interrupted = [];
  asked = [];
  answer = async () => ({ kind: "allow-once" });

  service = new LocalPolicyService({
    store,
    resolveContext: (id, agentId): AgentPolicyContext | null =>
      id === sessionId && agentId === "agt_1"
        ? { projectId, readOnly, backend, lifecycleToken: "tok_1", availableBoundaries: boundaries }
        : null,
    ask: async (prompt, signal) => {
      asked.push(prompt);
      return answer(prompt, signal);
    },
    interruptAndDeny: (id, reason) => interrupted.push({ sessionId: id, reason }),
    isQuiescent: () => quiescent,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("subject gating", () => {
  it("refuses a viewer without ever opening an approval", async () => {
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    store.sessionMembers.set(sessionId, viewer.id);
    service.createRule(owner, draft({ decision: "ask" }));

    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "viewer", source: "subject" });
    expect(result.message).toContain("Reviewer");
    expect(asked).toEqual([]);
    expect(service.grants.size).toBe(0);
    expect(service.canAnswerApproval(sessionId, "agt_1")).toBe(false);
    expect(result.audit).toMatchObject({ decision: "deny", memberRole: "viewer", memberLabel: "Reviewer" });
  });

  it("refuses a session whose assigned profile is gone rather than using the owner", async () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    store.sessionMembers.set(sessionId, editor.id);
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.run("DELETE FROM local_members WHERE id = ?", editor.id);
    store.db.exec("PRAGMA foreign_keys = ON");

    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "missing-member" });
    expect(service.checkDispatch(sessionId, "agt_1")).toMatchObject({ allowed: false, reason: "missing-member" });
  });

  it("runs a pre-existing session as the built-in owner", async () => {
    expect(service.resolveSubject(sessionId)).toMatchObject({ explicit: false });
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: true, source: "default" });
    expect(result.audit?.memberId).toBe(BUILT_IN_OWNER_MEMBER_ID);
  });

  it("never asks, allows or grants for a read-only artifact", async () => {
    readOnly = true;
    service.createRule(owner, draft({ decision: "ask" }));
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "read-only-artifact" });
    expect(asked).toEqual([]);
    expect(service.grants.size).toBe(0);
    expect(service.checkDispatch(sessionId, "agt_1")).toMatchObject({ allowed: false, reason: "read-only-artifact" });
  });
});

describe("authorization", () => {
  it("denies with the owning rule and scope named", async () => {
    const rule = service.createRule(owner, draft({ scope: { kind: "session", sessionId } }));
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "rule", source: "rule" });
    expect(result.rule?.id).toBe(rule.id);
    expect(result.message).toContain("session restriction");
    expect(result.audit).toMatchObject({ ruleId: rule.id, scopeKind: "session", scopeId: sessionId });
  });

  it("allows once without minting a grant", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    answer = async () => ({ kind: "allow-once" });
    const first = await service.authorize(call());
    expect(first).toMatchObject({ allowed: true, source: "approval", grantCreated: false });
    expect(service.grants.size).toBe(0);
    await service.authorize(call());
    expect(asked).toHaveLength(2);
  });

  it("satisfies an identical later call from a session grant, and only an identical one", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    answer = async () => ({ kind: "allow-session" });
    const first = await service.authorize(call());
    expect(first).toMatchObject({ allowed: true, grantCreated: true });

    answer = async () => ({ kind: "deny" });
    // Same input, different key order: the same call.
    const repeat = await service.authorize(call({ input: { query: "capybara" } }));
    expect(repeat).toMatchObject({ allowed: true, source: "grant" });
    expect(asked).toHaveLength(1);

    // A different value or cwd is a different call and asks again.
    for (const other of [call({ input: { query: "otter" } }), call({ cwd: "C:/work/elsewhere" })]) {
      expect(await service.authorize(other)).toMatchObject({ allowed: false, reason: "user-denied" });
    }
    expect(asked).toHaveLength(3);
    // A token that is not this agent's captured lifecycle never even asks.
    expect(await service.authorize(call({ lifecycleToken: "tok_2" })))
      .toMatchObject({ allowed: false, reason: "lifecycle-mismatch" });
    expect(asked).toHaveLength(3);
  });

  it("lets a deny override an existing grant and revokes it with the edit", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    answer = async () => ({ kind: "allow-session" });
    await service.authorize(call());
    expect(service.grants.size).toBe(1);

    service.createRule(owner, draft({ scope: { kind: "project", projectId }, decision: "deny" }));
    expect(service.grants.size).toBe(0);
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "rule" });
  });

  it("re-reads the policy after the answer arrives and denies a revoked request", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    answer = async () => {
      // The operator adds a restriction while the card is open.
      service.createRule(owner, draft({ scope: { kind: "session", sessionId }, decision: "deny" }));
      return { kind: "allow-session" };
    };
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "rule", source: "rule" });
    expect(result.grantCreated).toBe(false);
    expect(service.grants.size).toBe(0);
  });

  it("denies a waiting approval when the session becomes a viewer", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    answer = async () => {
      service.assignMember(owner, sessionId, viewer.id);
      return { kind: "allow-session" };
    };
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "viewer" });
    expect(interrupted).toEqual([{ sessionId, reason: '"Reviewer" is a viewer profile.' }]);
  });

  it("honours cancellation before and during the approval", async () => {
    service.createRule(owner, draft({ decision: "ask" }));
    const aborted = new AbortController();
    aborted.abort();
    expect(await service.authorize(call({ signal: aborted.signal })))
      .toMatchObject({ allowed: false, reason: "cancelled" });
    expect(asked).toEqual([]);

    const late = new AbortController();
    answer = async (_prompt, signal) => {
      late.abort();
      expect(signal?.aborted).toBe(true);
      return { kind: "allow-session" };
    };
    expect(await service.authorize(call({ signal: late.signal })))
      .toMatchObject({ allowed: false, reason: "cancelled" });
    expect(service.grants.size).toBe(0);

    // An explicitly cancelled card is a refusal too, not an allow.
    answer = async () => ({ kind: "cancelled" });
    expect(await service.authorize(call())).toMatchObject({ allowed: false, reason: "cancelled" });
  });

  it("refuses and records when the policy store itself fails", async () => {
    const failing = new LocalPolicyService({
      store: {
        ...store,
        localPolicyRules: {
          ...store.localPolicyRules,
          applicable: () => { throw new Error("disk gone"); },
        } as unknown as CapygenStore["localPolicyRules"],
      },
      resolveContext: () => ({
        projectId, readOnly: false, backend: "api",
        lifecycleToken: "tok_1", availableBoundaries: boundaries,
      }),
      ask: async () => ({ kind: "allow-session" }),
      interruptAndDeny: () => {},
      isQuiescent: () => true,
    });
    const result = await failing.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "error", source: "error" });
    expect(result.audit).toMatchObject({ decision: "deny", source: "error" });
    expect(result.message).not.toContain("disk gone");
    expect(failing.grants.size).toBe(0);
  });
});

describe("dispatch", () => {
  it("refuses a session whose boundary cannot enforce an applicable restriction", () => {
    backend = "codex";
    boundaries = ["codex-dynamic-tool"];
    service.createRule(owner, draft({ boundary: "codex-command-approval", pattern: "*" }));
    const decision = service.checkDispatch(sessionId, "agt_1");
    expect(decision).toMatchObject({ allowed: false, reason: "boundary-unavailable" });
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.refusals[0]?.boundary).toBe("codex-command-approval");
    expect(decision.message).toContain("codex-command-approval");

    boundaries = [...boundaries, "codex-command-approval"];
    expect(service.checkDispatch(sessionId, "agt_1")).toMatchObject({ allowed: true });
  });
});

describe("management is owner-only and revocation is immediate", () => {
  it("refuses restriction and grant management by an editor or viewer", () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    store.sessionMembers.set(sessionId, editor.id);
    expect(() => service.createRule({ sessionId }, draft())).toThrow(LocalPolicyError);
    expect(() => service.createRule({ memberId: editor.id }, draft())).toThrow(/cannot manage/);
    expect(() => service.revokeGrants({ memberId: editor.id })).toThrow(/cannot manage/);
    expect(service.listRules()).toEqual([]);
  });

  it("refuses to delete a profile a session still uses", () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    service.assignMember(owner, sessionId, editor.id);
    const error = (() => {
      try { service.removeMember(owner, editor.id); return null; } catch (e) { return e as LocalPolicyError; }
    })();
    expect(error).toBeInstanceOf(LocalPolicyError);
    expect(error?.code).toBe("member-assigned");
    expect(error?.detail).toEqual({ sessionIds: [sessionId] });

    store.sessionMembers.clear(sessionId);
    expect(service.removeMember(owner, editor.id)).toBe(true);
    expect(() => service.removeMember(owner, BUILT_IN_OWNER_MEMBER_ID)).toThrow(/built-in/);
  });

  it("requires quiescence for an ordinary reassignment but never for a revocation", () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    quiescent = false;
    expect(() => service.assignMember(owner, sessionId, editor.id)).toThrow(/Finish or stop/);
    expect(service.resolveSubject(sessionId)?.member.id).toBe(BUILT_IN_OWNER_MEMBER_ID);

    // Restrictive reassignment applies immediately and interrupts the session.
    service.grants.grant({
      sessionId, agentId: null, backend: "api", boundary: "api-tool",
      toolName: "t", inputCanonical: "{}", cwd: "C:/work", lifecycleToken: "tok_1",
    });
    service.assignMember(owner, sessionId, viewer.id);
    expect(service.resolveSubject(sessionId)?.member.id).toBe(viewer.id);
    expect(interrupted).toEqual([{ sessionId, reason: '"Reviewer" is a viewer profile.' }]);
    expect(service.grants.size).toBe(0);

    quiescent = true;
    service.assignMember(owner, sessionId, editor.id);
    expect(service.resolveSubject(sessionId)).toMatchObject({ explicit: true });
  });

  it("interrupts every session of a profile demoted to viewer", () => {
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    service.assignMember(owner, sessionId, editor.id);
    service.updateMember(owner, editor.id, { role: "viewer" });
    expect(interrupted.map((i) => i.sessionId)).toEqual([sessionId]);
    expect(service.canAnswerApproval(sessionId, "agt_1")).toBe(false);
  });
});

describe("automation subject copying", () => {
  it("copies an executing subject and refuses a viewer or a removed profile", () => {
    const target = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;
    const editor = store.localMembers.create({ label: "Editor", role: "editor" });
    service.assignMember(owner, sessionId, editor.id);

    expect(service.copySubjectForRun(sessionId, target)).toMatchObject({ ok: true });
    expect(store.sessionMembers.get(target)?.memberId).toBe(editor.id);

    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    service.assignMember(owner, sessionId, viewer.id);
    const refused = service.copySubjectForRun(sessionId, target);
    expect(refused).toMatchObject({ ok: false, reason: "viewer" });
    // The refusal never falls back to the owner: the target keeps what it had.
    expect(store.sessionMembers.get(target)?.memberId).toBe(editor.id);
  });
});

describe("audit", () => {
  it("records bounded metadata only, with no tool input anywhere in it", async () => {
    service.createRule(owner, draft());
    await service.authorize(call({ input: { query: "a-secret-looking-value" } }));
    const [record] = service.recentAudit(10);
    expect(record).toMatchObject({
      sessionId, agentId: "agt_1", backend: "api", boundary: "api-tool",
      boundaryAvailable: true, toolName: "mcp__docs__search", decision: "deny", source: "rule",
    });
    expect(JSON.stringify(record)).not.toContain("a-secret-looking-value");
    expect(JSON.stringify(record)).not.toContain("tok_1");
    expect(JSON.stringify(record)).not.toContain("C:/work/app");
  });
});
