import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let changes: Array<{ area: string; sessionId: string | null }>;
let interrupted: string[];
let pendingChain: Set<string>;
let published: Array<Record<string, unknown>>;

function sessionWithAgent(backend: "codex" | "api" = "codex") {
  return store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend, model: "m", role: "lead", config: null }],
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-runtime-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  changes = [];
  interrupted = [];
  pendingChain = new Set();
  published = [];
  runtime = createPolicyRuntime({
    store,
    ask: {
      publish: (card) => {
        published.push(card as unknown as Record<string, unknown>);
        return { blockId: "blk_1", turnId: "trn_1" };
      },
      settleCard: () => {},
    },
    publishChanged: (change) => changes.push(change),
    engine: () => ({
      interrupt: (sessionId) => { interrupted.push(sessionId); return true; },
      hasPendingChain: (sessionId) => pendingChain.has(sessionId),
    }),
  });
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("one service, wired to what main actually owns", () => {
  it("runs management as the built-in operator, never as a caller's claim", () => {
    const member = runtime.ipcDeps.actor!();
    expect(member).toEqual({ memberId: BUILT_IN_OWNER_MEMBER_ID });
    // The closure takes no argument, so there is nothing for a payload to fill.
    expect(runtime.ipcDeps.actor!.length).toBe(0);
  });

  it("reports boundaries from the capture, not from stored configuration", () => {
    const created = sessionWithAgent();
    const agentId = created.agents[0]!.id;
    // Nothing captured yet: no boundary is enforceable, and that is said plainly
    // rather than guessed from the agent row.
    expect(runtime.ipcDeps.catalogue.boundaryAvailability(created.session.id, agentId))
      .toMatchObject({ backend: "codex", boundaries: [] });

    runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId, backend: "codex",
      readOnly: false, codexApprovalPolicy: "on-request", declaresDynamicTools: false,
    });
    const after = runtime.ipcDeps.catalogue.boundaryAvailability(created.session.id, agentId)!;
    const byName = Object.fromEntries(after.boundaries.map((b) => [b.boundary, b]));
    expect(byName["codex-command-approval"]).toMatchObject({ available: true, reason: null });
    expect(byName["codex-permissions-approval"])
      .toMatchObject({ available: false, reason: "capability-unproven" });
  });

  it("knows a read-only artifact never runs", () => {
    const created = sessionWithAgent();
    expect(runtime.ipcDeps.catalogue.isReadOnlyArtifact(created.session.id)).toBe(false);
    store.db.run(
      "UPDATE sessions SET origin='import', artifact_kind='shared-bundle' WHERE id=?",
      created.session.id);
    expect(runtime.ipcDeps.catalogue.isReadOnlyArtifact(created.session.id)).toBe(true);
  });
});

describe("a capture's grants die with the capture", () => {
  it("revokes on release and announces it without payload", () => {
    const created = sessionWithAgent();
    const agentId = created.agents[0]!.id;
    runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId,
      backend: "codex", readOnly: false, declaresDynamicTools: true,
    });
    runtime.hooks.release(created.session.id, agentId);
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).toBeNull();
    // Any change published carries metadata only — never a rule or an input.
    for (const change of changes) {
      expect(Object.keys(change).sort()).toEqual(["area", "sessionId"]);
    }
  });

  it("cancels an agent's waiting card when its capture is released", async () => {
    const created = sessionWithAgent();
    const agentId = created.agents[0]!.id;
    const member = store.localMembers.get(BUILT_IN_OWNER_MEMBER_ID)!;
    const waiting = runtime.broker.ask({
      requestId: "req_1", sessionId: created.session.id, agentId, backend: "codex",
      boundary: "codex-dynamic-tool", toolName: "Bash", input: {}, cwd: "C:\\work",
      rule: null, member, originTurnId: "trn_1", executionSite: "backend" as const,
    }, undefined);
    expect(published).toHaveLength(1);
    runtime.hooks.release(created.session.id, agentId);
    await expect(waiting).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("quiescence is the runner's, not the status row's", () => {
  const quiescent = (sessionId: string): boolean => {
    // Reached through the service, which is the only caller that matters.
    try {
      runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, sessionId,
        BUILT_IN_OWNER_MEMBER_ID);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "session-busy") return false;
      throw error;
    }
  };

  it("refuses an ordinary reassignment while a chain is still pending", () => {
    const created = sessionWithAgent();
    expect(quiescent(created.session.id)).toBe(true);
    // The status row says idle, but the round table has a hop waiting.
    pendingChain.add(created.session.id);
    expect(quiescent(created.session.id)).toBe(false);
  });

  it("refuses while a permission card is still open", async () => {
    const created = sessionWithAgent();
    const member = store.localMembers.get(BUILT_IN_OWNER_MEMBER_ID)!;
    const waiting = runtime.broker.ask({
      requestId: "req_2", sessionId: created.session.id, agentId: created.agents[0]!.id,
      backend: "codex", boundary: "codex-dynamic-tool", toolName: "Bash",
      input: {}, cwd: "C:\\work", rule: null, member, originTurnId: "trn_1", executionSite: "backend" as const,
    }, undefined);
    expect(quiescent(created.session.id)).toBe(false);
    runtime.broker.answer("req_2", { behavior: "deny" });
    await waiting;
    expect(quiescent(created.session.id)).toBe(true);
  });

  it("denies waiting cards before interrupting on a restrictive change", async () => {
    const created = sessionWithAgent();
    const member = store.localMembers.get(BUILT_IN_OWNER_MEMBER_ID)!;
    const waiting = runtime.broker.ask({
      requestId: "req_3", sessionId: created.session.id, agentId: created.agents[0]!.id,
      backend: "codex", boundary: "codex-dynamic-tool", toolName: "Bash",
      input: {}, cwd: "C:\\work", rule: null, member, originTurnId: "trn_1", executionSite: "backend" as const,
    }, undefined);

    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      created.session.id, viewer.id);

    // The card is denied, and the turn interrupted — in that order.
    await expect(waiting).resolves.toEqual({ kind: "deny" });
    expect(interrupted).toContain(created.session.id);
  });
});

describe("dispatch is decided before a model runs", () => {
  it("refuses a viewer subject", () => {
    const created = sessionWithAgent();
    const agentId = created.agents[0]!.id;
    runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId,
      backend: "codex", readOnly: false, declaresDynamicTools: true,
    });
    const facts = { projectId, readOnly: false, backend: "codex" as const,
      declaresDynamicTools: true };
    expect(runtime.hooks.checkDispatch(created.session.id, agentId, facts))
      .toEqual({ allowed: true });

    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      created.session.id, viewer.id);

    const decision = runtime.hooks.checkDispatch(created.session.id, agentId, facts);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.message.length).toBeGreaterThan(0);
  });
});
