import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { parseEventPayload, type EventChannel } from "@capygen/shared";
import { createPolicyRuntime, createPermissionCardPublisher, type PolicyRuntime }
  from "../src/policies/runtime.js";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";

/**
 * The Approve page's aggregation (P17).
 *
 * Read from the persisted cards, so a native backend approval and a card
 * capygen's own policy raised both appear — the page exists to show everything
 * that is waiting, not one source of it.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let ipc: IpcContext;

const broadcast = (<E extends EventChannel>(event: E, payload: never): void => {
  parseEventPayload(event, payload);
}) as never;

function session(title: string) {
  const created = store.sessions.create({
    projectId, mode: "solo", title,
    agents: [{ name: "Assistant", backend: "api", model: "claude-opus-5", role: "lead",
      config: { api: { provider: "anthropic" } } }],
  });
  return created;
}

/** A waiting permission card, as either source would leave it. */
function card(sessionId: string, agentId: string | null, over: Record<string, unknown> = {}) {
  const turn = store.turns.create({
    sessionId, ...(agentId ? { agentId } : {}), role: "agent", status: "streaming",
  });
  const id = `blk_${Math.random().toString(16).slice(2)}`;
  store.blocks.upsert({
    id, turnId: turn.id, sessionId, kind: "permission", index: 0,
    request: {
      requestId: `req_${id}`, toolName: "Bash",
      input: { command: "ls -la /very/long/path/that/keeps/going" }, suggestions: [],
      ...over,
    },
    decision: null, createdAt: Date.now(), updatedAt: Date.now(),
  } as never);
  return id;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-approve-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  runtime = createPolicyRuntime({
    store,
    ask: createPermissionCardPublisher({ store, broadcast, newBlockId: () => "blk_x" }),
    publishChanged: () => {},
    engine: () => null,
  });
  ipc = createIpcContext({
    store,
    broadcast: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pickDirectory: async () => null,
    appInfo: () => ({ name: "capygen", version: "0.1.0" }) as never,
    localPolicies: runtime.ipcDeps,
    policyHooks: runtime.hooks,
    policyApprovability: (sessionId) => runtime.approvability(sessionId),
    makeEngine: () => ({
      send: () => {}, dispatch: () => ({}) as never, continueChain: () => ({ ok: false, agentTurnId: null }),
      hasPendingChain: () => false, interrupt: () => false,
      answerPermission: () => false, answerQuestion: () => false, answerElicitation: () => false,
      describeAgent: async () => ({}) as never, dispose: async () => {},
    }) as never,
  });
});

afterEach(async () => {
  await ipc.dispose();
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("everything waiting is listed", () => {
  it("lists cards from every source and counts the total beyond the page", async () => {
    const a = session("First");
    const b = session("Second");
    card(a.session.id, a.agents[0]!.id);
    card(b.session.id, b.agents[0]!.id, {
      localPolicy: { ruleId: "rule_1", scope: { kind: "global" }, boundary: "api-tool" },
    });

    const page = await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({
      sessionId: a.session.id, sessionTitle: "First", toolName: "Bash",
      agentLabel: "Assistant", answerable: true, refusal: null,
    });

    const second = await ipc.handlers["approve.pending"]({ projectId: null, offset: 1, limit: 1 });
    // A locally raised card carries its attribution so the page can link the rule.
    expect(second.requests[0]).toMatchObject({
      sessionId: b.session.id,
      localPolicy: { ruleId: "rule_1", boundary: "api-tool" },
    });
  });

  it("omits an answered card", async () => {
    const created = session("First");
    const blockId = card(created.session.id, created.agents[0]!.id);
    const block = store.blocks.get(blockId)!;
    store.blocks.upsert({
      ...block,
      decision: { behavior: "allow", scope: "once", decidedAt: Date.now() },
    } as never);
    expect((await ipc.handlers["approve.pending"](
      { projectId: null, offset: 0, limit: 25 })).total).toBe(0);
  });

  it("bounds the input hint rather than shipping the whole argument list", async () => {
    const created = session("First");
    card(created.session.id, created.agents[0]!.id, {
      input: { command: "x".repeat(5000) },
    });
    const page = await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 25 });
    expect(page.requests[0]!.inputSummary.length).toBeLessThanOrEqual(240);
  });

  it("still lists a request whose session was archived", async () => {
    const created = session("Shelved");
    card(created.session.id, created.agents[0]!.id);
    store.sessions.setArchived(created.session.id, true);
    // Archiving is a shelf, not a stop: the call is still waiting, and hiding
    // it would leave it blocked with nothing on screen to unblock it.
    const page = await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 25 });
    expect(page.total).toBe(1);
    expect(page.requests[0]).toMatchObject({
      sessionId: created.session.id, answerable: true,
    });
  });

  it("filters to one project", async () => {
    const mine = session("Mine");
    card(mine.session.id, mine.agents[0]!.id);
    const otherProject = store.projects.upsertByPath({ path: path.join(dir, "other") }).id;
    const theirs = store.sessions.create({
      projectId: otherProject, mode: "solo", title: "Theirs",
      agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
        config: { api: { provider: "anthropic" } } }],
    });
    card(theirs.session.id, theirs.agents[0]!.id);

    const page = await ipc.handlers["approve.pending"]({ projectId, offset: 0, limit: 25 });
    expect(page.total).toBe(1);
    expect(page.requests[0]!.sessionTitle).toBe("Mine");
  });
});

describe("answerability is resolved on every read", () => {
  it("still lists a request the current profile may not answer, and says why", async () => {
    const created = session("First");
    card(created.session.id, created.agents[0]!.id);
    expect((await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 25 }))
      .requests[0]).toMatchObject({ answerable: true, refusal: null });

    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      created.session.id, viewer.id);

    // Demoted in another window: the row is still shown, marked unanswerable.
    const page = await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 25 });
    expect(page.total).toBe(1);
    expect(page.requests[0]).toMatchObject({ answerable: false, refusal: "viewer" });
  });

  it("marks a read-only artifact's card unanswerable", async () => {
    const created = session("First");
    card(created.session.id, created.agents[0]!.id);
    store.db.run(
      "UPDATE sessions SET origin='import', artifact_kind='shared-bundle' WHERE id=?",
      created.session.id);
    expect((await ipc.handlers["approve.pending"]({ projectId: null, offset: 0, limit: 25 }))
      .requests[0]).toMatchObject({ answerable: false, refusal: "read-only-artifact" });
  });
});
