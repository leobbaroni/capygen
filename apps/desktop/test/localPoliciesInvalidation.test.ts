import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";
import { createLocalPolicyHandlers, type LocalPolicyHandlers } from "../src/ipc/localPolicies.js";

/**
 * The invalidation an open Members/Policies/Approve view depends on.
 *
 * Root's native shell test proved the gap: subscribing and renaming a member
 * produced no event at all, so a second window kept showing the old label.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let handlers: LocalPolicyHandlers;
let changes: Array<{ area: string; sessionId: string | null }>;

const liveSession = () => store.sessions.create({
  projectId, mode: "solo", title: "T",
  agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
    config: { api: { provider: "anthropic" } } }],
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-inval-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  changes = [];
  runtime = createPolicyRuntime({
    store,
    ask: { publish: () => null, settleCard: () => {} },
    publishChanged: (change) => changes.push(change),
    engine: () => null,
  });
  handlers = createLocalPolicyHandlers(runtime.ipcDeps);
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a successful management mutation invalidates open views", () => {
  it("announces a member rename — the case the native shell test caught", async () => {
    const created = await handlers["policy.members.create"]({ label: "Reviewer", role: "editor" });
    expect(changes).toEqual([{ area: "members", sessionId: null }]);

    changes.length = 0;
    await handlers["policy.members.update"]({
      memberId: created.member.id, label: "Renamed reviewer",
    });
    expect(changes).toEqual([{ area: "members", sessionId: null }]);

    changes.length = 0;
    expect((await handlers["policy.members.remove"]({ memberId: created.member.id })).removed)
      .toBe(true);
    expect(changes).toEqual([{ area: "members", sessionId: null }]);
  });

  it("names the session a subject assignment belongs to", async () => {
    const session = liveSession().session;
    const member = (await handlers["policy.members.create"]({ label: "Ed", role: "editor" })).member;
    changes.length = 0;
    await handlers["policy.session.subject.assign"]({
      sessionId: session.id, memberId: member.id,
    });
    expect(changes).toEqual([{ area: "subjects", sessionId: session.id }]);
  });

  it("names a session-scoped rule's session, and leaves a global rule unscoped", async () => {
    const session = liveSession().session;
    const scoped = await handlers["policy.rules.create"]({
      scope: { kind: "session", sessionId: session.id },
      boundary: "api-tool", pattern: "Bash", decision: "ask", enabled: true,
    });
    expect(changes).toEqual([{ area: "rules", sessionId: session.id }]);

    changes.length = 0;
    await handlers["policy.rules.create"]({
      scope: { kind: "global" }, boundary: "api-tool", pattern: "Read", decision: "deny",
      enabled: true,
    });
    expect(changes).toEqual([{ area: "rules", sessionId: null }]);

    // An update reports the rule's own scope, not the caller's patch.
    changes.length = 0;
    await handlers["policy.rules.update"]({ ruleId: scoped.rule.id, enabled: false });
    expect(changes).toEqual([{ area: "rules", sessionId: session.id }]);
  });

  it("carries metadata only — never a label, pattern or identity", async () => {
    const session = liveSession().session;
    await handlers["policy.members.create"]({ label: "Secret Reviewer", role: "editor" });
    await handlers["policy.rules.create"]({
      scope: { kind: "session", sessionId: session.id },
      boundary: "api-tool", pattern: "mcp__secrets__read", decision: "deny", enabled: true,
    });
    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain("Secret Reviewer");
    expect(serialized).not.toContain("mcp__secrets__read");
    for (const change of changes) {
      expect(Object.keys(change).sort()).toEqual(["area", "sessionId"]);
    }
  });
});

describe("nothing that did not happen is announced", () => {
  it("stays silent when a mutation is refused", async () => {
    await expect(handlers["policy.members.update"]({
      memberId: BUILT_IN_OWNER_MEMBER_ID, role: "viewer",
    })).rejects.toThrow();
    expect(changes).toEqual([]);

    await expect(handlers["policy.members.create"]({ label: "   ", role: "editor" }))
      .rejects.toThrow();
    expect(changes).toEqual([]);

    await expect(handlers["policy.session.subject.assign"]({
      sessionId: "ses_missing", memberId: BUILT_IN_OWNER_MEMBER_ID,
    })).rejects.toThrow();
    expect(changes).toEqual([]);
  });

  it("stays silent when a delete or revoke matched nothing", async () => {
    expect((await handlers["policy.members.remove"]({ memberId: "mbr_missing" })).removed)
      .toBe(false);
    expect((await handlers["policy.rules.remove"]({ ruleId: "rule_missing" })).removed)
      .toBe(false);
    expect((await handlers["policy.grants.revoke"]({ grantId: "grant_missing" })).revoked)
      .toBe(false);
    expect(changes).toEqual([]);
  });

  it("does not announce a read", async () => {
    await handlers["policy.members.list"]({});
    await handlers["policy.rules.list"]({});
    await handlers["policy.grants.list"]({});
    expect(changes).toEqual([]);
  });
});
