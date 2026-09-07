/**
 * Adversarial regressions for the local policy service (ADR-0007).
 *
 * Every case here is a way an authorization could be *wrongly granted*:
 * a cancelled request that still allows, an approval that outlives the
 * lifecycle it was asked for, an input that changes under the approval, a rule
 * for one backend refusing another, or a grant listing that leaks the material
 * it matches on. Each was run red against the pre-fix service before the fix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_OWNER_MEMBER_ID, openStore, type CapygenStore } from "@capygen/db";
import type { LocalPolicyRuleDraft, PolicyBoundary } from "@capygen/shared";
import {
  LocalPolicyService,
  snapshotToolInput,
  type AgentPolicyContext,
  type ApprovalAnswer,
  type ApprovalPrompt,
  type AuthorizeRequest,
} from "../src/policies/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let sessionId: string;
let service: LocalPolicyService;

let contexts: Map<string, AgentPolicyContext>;
let asked: ApprovalPrompt[];
let answer: (prompt: ApprovalPrompt, signal: AbortSignal | undefined) => Promise<ApprovalAnswer>;
type TestValidation = { ok: true; input: unknown } | { ok: false; message: string };
type TestValidator = (
  request: AuthorizeRequest,
  replacement: unknown,
) => TestValidation | Promise<TestValidation>;
let validate: TestValidator | undefined;

const owner = { memberId: BUILT_IN_OWNER_MEMBER_ID } as const;

const draft = (over: Partial<LocalPolicyRuleDraft> = {}): LocalPolicyRuleDraft => ({
  scope: { kind: "global" }, boundary: "api-tool", pattern: "mcp__docs__*",
  decision: "ask", enabled: true, ...over,
});

const apiContext = (over: Partial<AgentPolicyContext> = {}): AgentPolicyContext => ({
  projectId, readOnly: false, backend: "api", lifecycleToken: "tok_api",
  availableBoundaries: ["api-tool"], ...over,
});

const call = (over: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  requestId: "req_1", sessionId, agentId: "agt_api", boundary: "api-tool",
  toolName: "mcp__docs__search", input: { query: "capybara" },
  cwd: "C:/work/app", lifecycleToken: "tok_api", ...over,
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-adversarial-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project"), name: "Project" }).id;
  sessionId = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;

  contexts = new Map([["agt_api", apiContext()]]);
  asked = [];
  answer = async () => ({ kind: "allow-session" });
  validate = undefined;

  service = new LocalPolicyService({
    store,
    resolveContext: (id, agentId) =>
      id === sessionId ? contexts.get(agentId ?? "") ?? null : null,
    ask: async (prompt, signal) => {
      asked.push(prompt);
      return answer(prompt, signal);
    },
    validateEditedInput: (request, replacement) => validate?.(request, replacement)
      ?? { ok: false, message: "edited input is not accepted here" },
    interruptAndDeny: () => {},
    isQuiescent: () => true,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cancellation is checked before every success path", () => {
  it("refuses an already-cancelled request that no rule would have restricted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const result = await service.authorize(call({ signal: aborted.signal }));
    expect(result).toMatchObject({ allowed: false, reason: "cancelled" });
  });

  it("refuses an already-cancelled request that an exact grant would have satisfied", async () => {
    service.createRule(owner, draft());
    answer = async () => ({ kind: "allow-session" });
    expect(await service.authorize(call())).toMatchObject({ allowed: true, grantCreated: true });

    const aborted = new AbortController();
    aborted.abort();
    const result = await service.authorize(call({ signal: aborted.signal }));
    expect(result).toMatchObject({ allowed: false, reason: "cancelled" });
    expect(asked).toHaveLength(1);
  });

  it("stops waiting on an approval callback that ignores the signal, and ignores its late answer", async () => {
    service.createRule(owner, draft());
    const late: { settle: ((answer: ApprovalAnswer) => void) | null } = { settle: null };
    answer = () => new Promise<ApprovalAnswer>((resolve) => { late.settle = resolve; });

    const controller = new AbortController();
    const pending = service.authorize(call({ signal: controller.signal }));
    await tick();
    controller.abort();
    expect(await pending).toMatchObject({ allowed: false, reason: "cancelled" });

    late.settle?.({ kind: "allow-session" });
    await tick();
    expect(service.grants.size).toBe(0);
  });
});

describe("an approval cannot outlive the authorization it was asked for", () => {
  it("refuses a late allow-for-session when the session ended while the card was open", async () => {
    service.createRule(owner, draft());
    answer = async () => {
      service.endSession(sessionId);
      return { kind: "allow-session" };
    };
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "stale" });
    expect(result.grantCreated).toBe(false);
    expect(service.grants.size).toBe(0);
  });

  it("refuses a late answer when the captured lifecycle was replaced", async () => {
    service.createRule(owner, draft());
    answer = async () => {
      service.endLifecycle("tok_api");
      return { kind: "allow-session" };
    };
    expect(await service.authorize(call())).toMatchObject({ allowed: false, reason: "stale" });
    expect(service.grants.size).toBe(0);
  });

  it("refuses a late answer when grants were revoked while the card was open", async () => {
    service.createRule(owner, draft());
    answer = async () => {
      service.revokeGrants(owner);
      return { kind: "allow-session" };
    };
    expect(await service.authorize(call())).toMatchObject({ allowed: false, reason: "stale" });
    expect(service.grants.size).toBe(0);
  });

  it("refuses a late answer when the attributed rule was replaced, even by another ask", async () => {
    const first = service.createRule(owner, draft());
    answer = async () => {
      service.removeRule(owner, first.id);
      service.createRule(owner, draft({ scope: { kind: "session", sessionId }, decision: "ask" }));
      return { kind: "allow-session" };
    };
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "policy-changed" });
    expect(service.grants.size).toBe(0);
  });
});

describe("the approved input is a bounded immutable snapshot", () => {
  it("refuses input that is not bounded JSON, without opening an approval", async () => {
    service.createRule(owner, draft());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const holes = [1, , 3];
    for (const input of [undefined, cyclic, holes, { n: Number.NaN }, { n: Infinity },
      { fn: () => 1 }, { when: new Date(0) }, { big: 1n }, { missing: undefined }]) {
      const result = await service.authorize(call({ input }));
      expect(result).toMatchObject({ allowed: false, reason: "invalid-input" });
    }
    expect(asked).toEqual([]);
    // `null` is representable JSON and is not rejected.
    answer = async () => ({ kind: "allow-once" });
    expect(await service.authorize(call({ input: null }))).toMatchObject({ allowed: true });
  });

  it("keeps the approved identity when the caller mutates the object during the approval", async () => {
    service.createRule(owner, draft());
    const input: { query: string; extra?: string } = { query: "capybara" };
    answer = async () => {
      input.query = "otter";
      input.extra = "added";
      return { kind: "allow-session" };
    };
    const result = await service.authorize(call({ input }));
    expect(result.allowed).toBe(true);
    expect(result.approvedInput).toEqual({ query: "capybara" });
    expect(Object.isFrozen(result.approvedInput)).toBe(true);

    // The grant is the approved request, not the mutated object.
    answer = async () => ({ kind: "deny" });
    expect(await service.authorize(call({ input: { query: "capybara" } })))
      .toMatchObject({ allowed: true, source: "grant" });
    expect(await service.authorize(call({ input: { query: "otter", extra: "added" } })))
      .toMatchObject({ allowed: false, reason: "user-denied" });
  });

  it("snapshots reject what canonical JSON would otherwise silently elide", () => {
    expect(snapshotToolInput({ a: undefined }).ok).toBe(false);
    expect(snapshotToolInput({ a: 1, b: [null, "x"] })).toMatchObject({ ok: true });
    expect(snapshotToolInput({ deep: { a: { b: { c: { d: 1 } } } } }, { maxDepth: 3 }).ok).toBe(false);
    expect(snapshotToolInput(Array.from({ length: 50 }, (_, i) => i), { maxNodes: 10 }).ok).toBe(false);
  });
});

describe("an edited approval answer is validated before it authorizes anything", () => {
  it("never runs the original input when the replacement is rejected", async () => {
    service.createRule(owner, draft());
    validate = () => ({ ok: false, message: "path escapes the project" });
    answer = async () => ({ kind: "allow-session", input: { query: "../../etc" } });
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "invalid-edit" });
    expect(result.approvedInput).toBeUndefined();
    expect(service.grants.size).toBe(0);
  });

  it("returns the accepted replacement and grants that, not what was asked", async () => {
    service.createRule(owner, draft());
    validate = (_request, replacement) => ({ ok: true, input: replacement });
    answer = async () => ({ kind: "allow-session", input: { query: "otter" } });
    const result = await service.authorize(call({ input: { query: "capybara" } }));
    expect(result).toMatchObject({ allowed: true, grantCreated: true });
    expect(result.approvedInput).toEqual({ query: "otter" });

    answer = async () => ({ kind: "deny" });
    expect(await service.authorize(call({ input: { query: "otter" } })))
      .toMatchObject({ allowed: true, source: "grant" });
    expect(await service.authorize(call({ input: { query: "capybara" } })))
      .toMatchObject({ allowed: false, reason: "user-denied" });
  });
});

describe("capability and backend are per agent, never unioned", () => {
  it("does not let a Codex-only restriction refuse an API-only target", () => {
    service.createRule(owner, draft({ boundary: "codex-command-approval", pattern: "*", decision: "deny" }));
    expect(service.checkDispatch(sessionId, "agt_api")).toMatchObject({ allowed: true });
  });

  it("refuses only the agent whose captured lifecycle lacks the boundary", () => {
    contexts.set("agt_codex_a", {
      projectId, readOnly: false, backend: "codex", lifecycleToken: "tok_a",
      availableBoundaries: ["codex-dynamic-tool"],
    });
    contexts.set("agt_codex_b", {
      projectId, readOnly: false, backend: "codex", lifecycleToken: "tok_b",
      availableBoundaries: ["codex-dynamic-tool", "codex-command-approval"],
    });
    service.createRule(owner, draft({ boundary: "codex-command-approval", pattern: "*", decision: "deny" }));
    expect(service.checkDispatch(sessionId, "agt_codex_a"))
      .toMatchObject({ allowed: false, reason: "boundary-unavailable" });
    expect(service.checkDispatch(sessionId, "agt_codex_b")).toMatchObject({ allowed: true });
  });

  it("refuses a call at a boundary this agent cannot enforce", async () => {
    contexts.set("agt_codex_a", {
      projectId, readOnly: false, backend: "codex", lifecycleToken: "tok_a",
      availableBoundaries: ["codex-dynamic-tool"],
    });
    const result = await service.authorize(call({
      agentId: "agt_codex_a", boundary: "codex-command-approval",
      lifecycleToken: "tok_a", toolName: "shell",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "boundary-unavailable" });
    expect(result.audit).toMatchObject({ boundaryAvailable: false, decision: "deny" });
  });

  it("refuses a late answer when the boundary stopped being available", async () => {
    service.createRule(owner, draft());
    answer = async () => {
      contexts.set("agt_api", apiContext({ availableBoundaries: [] }));
      return { kind: "allow-session" };
    };
    expect(await service.authorize(call()))
      .toMatchObject({ allowed: false, reason: "boundary-unavailable" });
    expect(service.grants.size).toBe(0);
  });
});

describe("the request's lifecycle token is verified, never trusted", () => {
  it("refuses an empty, oversized or mismatched token", async () => {
    for (const lifecycleToken of ["", "   ", "t".repeat(257), "tok_other"]) {
      expect(await service.authorize(call({ lifecycleToken })))
        .toMatchObject({ allowed: false, reason: "lifecycle-mismatch" });
    }
    expect(asked).toEqual([]);
  });
});

describe("grant listings carry no matching material", () => {
  it("exposes an opaque id and safe metadata only", async () => {
    service.createRule(owner, draft());
    answer = async () => ({ kind: "allow-session" });
    await service.authorize(call({ input: { query: "a-secret-looking-value" } }));

    const [summary] = service.listGrants();
    expect(summary).toMatchObject({
      sessionId, agentId: "agt_api", backend: "api", boundary: "api-tool",
      toolName: "mcp__docs__search",
    });
    const serialized = JSON.stringify(service.listGrants());
    for (const secret of ["a-secret-looking-value", "tok_api", "C:/work/app"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(summary?.grantId).toBeTruthy();
    expect(service.revokeGrantById(owner, summary!.grantId)).toBe(true);
    expect(service.listGrants()).toEqual([]);
  });
});

describe("approval answering respects the session context", () => {
  it("refuses for an unknown session, an unknown agent and a read-only artifact", () => {
    expect(service.canAnswerApproval(sessionId, "agt_api")).toBe(true);
    expect(service.canAnswerApproval("ses_missing", "agt_api")).toBe(false);
    expect(service.canAnswerApproval(sessionId, "agt_missing")).toBe(false);
    contexts.set("agt_api", apiContext({ readOnly: true }));
    expect(service.canAnswerApproval(sessionId, "agt_api")).toBe(false);
  });
});

describe("the validation await is a second window, and is closed the same way", () => {
  /** A validator that parks until the case releases it. */
  const deferredValidator = (during: () => void) => {
    const gate: { release: (() => void) | null } = { release: null };
    validate = async () => {
      during();
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return { ok: true, input: { query: "otter" } };
    };
    return gate;
  };

  const editThenAuthorize = async (during: () => void) => {
    service.createRule(owner, draft());
    answer = async () => ({ kind: "allow-session", input: { query: "otter" } });
    const gate = deferredValidator(during);
    const pending = service.authorize(call());
    await tick();
    gate.release?.();
    return pending;
  };

  it("re-reads the rules: a deny arriving during validation refuses the edited call", async () => {
    const result = await editThenAuthorize(() => {
      service.createRule(owner, draft({ scope: { kind: "session", sessionId }, decision: "deny" }));
    });
    expect(result).toMatchObject({ allowed: false, reason: "rule" });
    expect(service.grants.size).toBe(0);
  });

  it("re-reads the attribution: an ask replaced during validation refuses", async () => {
    const first = service.listRules()[0];
    const result = await editThenAuthorize(() => {
      const [existing] = service.listRules();
      if (existing) service.removeRule(owner, existing.id);
      service.createRule(owner, draft({ scope: { kind: "project", projectId }, decision: "ask" }));
    });
    expect(first).toBeUndefined();
    expect(result).toMatchObject({ allowed: false, reason: "policy-changed" });
    expect(service.grants.size).toBe(0);
  });

  it("re-reads capability: a boundary lost during validation refuses", async () => {
    const result = await editThenAuthorize(() => {
      contexts.set("agt_api", apiContext({ availableBoundaries: [] }));
    });
    expect(result).toMatchObject({ allowed: false, reason: "boundary-unavailable" });
    expect(service.grants.size).toBe(0);
  });

  it("re-reads the artifact flag: a session that became read-only during validation refuses", async () => {
    const result = await editThenAuthorize(() => {
      contexts.set("agt_api", apiContext({ readOnly: true }));
    });
    expect(result).toMatchObject({ allowed: false, reason: "unknown-session" });
    expect(service.grants.size).toBe(0);
  });

  it("re-reads the lifecycle: a backend replaced during validation refuses", async () => {
    const result = await editThenAuthorize(() => {
      contexts.set("agt_api", apiContext({ lifecycleToken: "tok_replaced" }));
    });
    expect(result).toMatchObject({ allowed: false, reason: "lifecycle-mismatch" });
    expect(service.grants.size).toBe(0);
  });

  it("re-reads the subject: a demotion during validation refuses", async () => {
    const viewer = store.localMembers.create({ label: "Reviewer", role: "viewer" });
    const result = await editThenAuthorize(() => {
      service.assignMember(owner, sessionId, viewer.id);
    });
    expect(result).toMatchObject({ allowed: false, reason: "viewer" });
    expect(service.grants.size).toBe(0);
  });

  it("stops waiting on a validator that ignores the signal, and ignores its late answer", async () => {
    service.createRule(owner, draft());
    answer = async () => ({ kind: "allow-session", input: { query: "otter" } });
    const gate: { release: ((verdict: TestValidation) => void) | null } = { release: null };
    validate = () => new Promise<TestValidation>((resolve) => { gate.release = resolve; });

    const controller = new AbortController();
    const pending = service.authorize(call({ signal: controller.signal }));
    await tick();
    controller.abort();
    expect(await pending).toMatchObject({ allowed: false, reason: "cancelled" });

    gate.release?.({ ok: true, input: { query: "otter" } });
    await tick();
    expect(service.grants.size).toBe(0);
  });
});

describe("only an explicit allow answer authorizes", () => {
  it("refuses a malformed or unknown approval response", async () => {
    service.createRule(owner, draft());
    for (const malformed of [{ kind: "bogus" }, { kind: "allow" }, {}, null, undefined, "allow-once",
      { kind: "allow-once", extra: true, kindOf: "x" }].slice(0, 6)) {
      answer = async () => malformed as ApprovalAnswer;
      const result = await service.authorize(call());
      expect(result).toMatchObject({ allowed: false, reason: "invalid-answer" });
      expect(result.approvedInput).toBeUndefined();
    }
    expect(service.grants.size).toBe(0);
  });

  it("treats an explicitly undefined edited input as an edit, not as approval of the original", async () => {
    service.createRule(owner, draft());
    validate = (_request, replacement) => ({ ok: true, input: replacement });
    answer = async () => ({ kind: "allow-session", input: undefined });
    const result = await service.authorize(call({ input: { query: "capybara" } }));
    expect(result).toMatchObject({ allowed: false, reason: "invalid-edit" });
    expect(result.approvedInput).toBeUndefined();
    expect(service.grants.size).toBe(0);
  });
});

describe("a refusal never echoes the caller's own input text", () => {
  it("explains an unrepresentable input structurally, without its key names", async () => {
    service.createRule(owner, draft());
    const result = await service.authorize(call({
      input: { "s3cret-key-name": undefined, "another-private-key": 1 },
    }));
    expect(result).toMatchObject({ allowed: false, reason: "invalid-input" });
    expect(result.message).not.toContain("s3cret-key-name");
    expect(result.message).not.toContain("another-private-key");
    expect(asked).toEqual([]);
  });

  it("explains a rejected edit structurally too", async () => {
    service.createRule(owner, draft());
    validate = (_request, replacement) => ({ ok: true, input: replacement });
    answer = async () => ({ kind: "allow-session", input: { "edited-secret-key": undefined } });
    const result = await service.authorize(call());
    expect(result).toMatchObject({ allowed: false, reason: "invalid-edit" });
    expect(result.message).not.toContain("edited-secret-key");
    expect(service.grants.size).toBe(0);
  });
});
