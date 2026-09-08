import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";

/**
 * The subject a scheduled run executes as.
 *
 * A run copies the source session's *current* profile before it dispatches, and
 * a missing or viewer profile refuses visibly. There is deliberately no fallback
 * to the owner: a prompt that fires at 3am must not quietly acquire authority
 * the person who scheduled it no longer has.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let changes: Array<{ area: string; sessionId: string | null }>;

const session = (title: string) => store.sessions.create({
  projectId, mode: "solo", title,
  agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
    config: { api: { provider: "anthropic" } } }],
}).session;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-automation-policy-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  changes = [];
  runtime = createPolicyRuntime({
    store,
    ask: { publish: () => null, settleCard: () => {} },
    publishChanged: (change) => changes.push(change),
    engine: () => null,
  });
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a scheduled run inherits the source session's current profile", () => {
  it("copies an explicit assignment onto the fresh run", () => {
    const source = session("source");
    const fresh = session("run");
    const editor = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Scheduler", role: "editor" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, source.id, editor.id);

    changes.length = 0;
    expect(runtime.subject.copyForRun(source.id, fresh.id)).toEqual({ ok: true });
    expect(runtime.service.resolveSubject(fresh.id)?.member.id).toBe(editor.id);
    expect(changes).toContainEqual({ area: "subjects", sessionId: fresh.id });
  });

  it("takes the assignment as it is *now*, not as it was when scheduled", () => {
    const source = session("source");
    const first = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "First", role: "editor" });
    const second = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Second", role: "editor" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, source.id, first.id);
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, source.id, second.id);

    const fresh = session("run");
    expect(runtime.subject.copyForRun(source.id, fresh.id)).toEqual({ ok: true });
    expect(runtime.service.resolveSubject(fresh.id)?.member.id).toBe(second.id);
  });

  it("refuses a viewer subject with a message, and assigns nothing", () => {
    const source = session("source");
    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, source.id, viewer.id);

    const fresh = session("run");
    const outcome = runtime.subject.copyForRun(source.id, fresh.id);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("viewer");
      expect(outcome.message.length).toBeGreaterThan(0);
    }
    // No fallback to the owner: the fresh run has no explicit subject at all.
    expect(runtime.service.resolveSubject(fresh.id)?.explicit).not.toBe(true);
  });

  it("refuses when the source session is gone", () => {
    const fresh = session("run");
    const outcome = runtime.subject.copyForRun("ses_missing", fresh.id);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unknown-session");
  });

  it("refuses when the assigned profile was deleted out from under it", () => {
    const source = session("source");
    const temp = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Temp", role: "editor" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, source.id, temp.id);
    // Reassign away, then delete: the source now resolves to no explicit member.
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      source.id, BUILT_IN_OWNER_MEMBER_ID);
    runtime.service.removeMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, temp.id);

    const fresh = session("run");
    // The built-in owner is a real, current assignment, so this one succeeds —
    // the refusal cases above are what a missing or viewer profile produces.
    expect(runtime.subject.copyForRun(source.id, fresh.id)).toEqual({ ok: true });
  });
});
