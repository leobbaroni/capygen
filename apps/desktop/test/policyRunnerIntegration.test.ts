import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createSessionRunner } from "../src/engine/SessionRunner.js";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";
import type { Engine } from "../src/engine/types.js";

/**
 * The real runtime driving the real runner.
 *
 * These are deliberately not written against a hand-rolled hooks double: the
 * defect this file exists for — a dispatch check that could only see captures,
 * so no fresh session could ever run — was invisible to a mock that answered
 * `{allowed: true}` regardless.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let engine: Engine;
let built: Array<{ backend: string; authorizeLocal: unknown }>;
let cards: Array<Record<string, unknown>>;
let blocks: unknown[];

function wire(): void {
  built = [];
  cards = [];
  blocks = [];
  runtime = createPolicyRuntime({
    store,
    ask: {
      publish: (card) => {
        cards.push(card as unknown as Record<string, unknown>);
        return null;
      },
      settleCard: () => {},
    },
    publishChanged: () => {},
    engine: () => engine as never,
  });
  engine = createSessionRunner({
    store,
    broadcast: (channel, payload) => { if (channel === "chat.block") blocks.push(payload); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    policy: runtime.hooks,
    makeHarness: (agent, extras) => {
      built.push({ backend: agent.backend, authorizeLocal: extras.authorizeLocal });
      return {
        start: async () => {},
        send: () => (async function* () {})(),
        interrupt: async () => {},
        dispose: async () => {},
      } as never;
    },
  });
}

function liveSession(backend: "api" | "codex" = "api") {
  return store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend, model: backend === "api" ? "claude-opus-5" : "gpt-5-codex",
      role: "lead", config: backend === "api" ? { api: { provider: "anthropic" } } : null }],
  });
}

const sendTurn = async (sessionId: string, agentId: string): Promise<string> => {
  const turn = store.turns.create({ sessionId, role: "user", status: "done" });
  engine.send({ sessionId, turnId: turn.id, agentId, text: "hello" });
  await settle();
  return turn.id;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-int-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  wire();
});

afterEach(async () => {
  await engine.dispose();
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a fresh session can actually run", () => {
  it("dispatches an ordinary owner turn on a session that has never run", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    // Nothing is captured yet — this is the cold start every new session has.
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).toBeNull();

    const turnId = await sendTurn(created.session.id, agentId);

    expect(store.turns.get(turnId)?.status).not.toBe("error");
    expect(built).toHaveLength(1);
    expect(typeof built[0]!.authorizeLocal).toBe("function");
    // And only now does a capture exist.
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).not.toBeNull();
  });

  it("decides dispatch from current configuration, not a previous capture", async () => {
    const created = liveSession("codex");
    const agentId = created.agents[0]!.id;
    await sendTurn(created.session.id, agentId);
    const firstToken = runtime.lifecycles.tokenFor(created.session.id, agentId);

    // Change the configuration; the runner evicts, so the capture is gone and
    // the next dispatch has only the preflight to go on.
    store.sessions.updateAgent(agentId, { config: { codex: { approvalPolicy: "on-request" } } });
    engine.agentConfigChanged?.(agentId);
    await settle();
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).toBeNull();

    const turnId = await sendTurn(created.session.id, agentId);
    expect(store.turns.get(turnId)?.status).not.toBe("error");
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).not.toBe(firstToken);
  });

  it("still requires a captured token to authorize a tool call", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    // A dispatch check succeeds cold, but the preflight token it used is not
    // authority: authorizing with a made-up token is refused.
    expect(runtime.hooks.checkDispatch(created.session.id, agentId, {
      projectId, readOnly: false, backend: "api", declaresDynamicTools: false,
    })).toEqual({ allowed: true });
    const authorization = await runtime.service.authorize({
      sessionId: created.session.id, agentId, lifecycleToken: "preflight-made-up",
      boundary: "api-tool", toolName: "Bash", input: {}, cwd: "C:\\work",
    });
    expect(authorization.allowed).toBe(false);
  });
});

describe("a refused turn costs no model call", () => {
  const assignViewer = (sessionId: string): void => {
    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, sessionId, viewer.id);
  };

  it("builds no harness at all for a viewer subject", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    assignViewer(created.session.id);

    const turnId = await sendTurn(created.session.id, agentId);

    expect(built).toHaveLength(0);
    expect(runtime.lifecycles.size()).toBe(0);
    expect(store.turns.get(turnId)?.status).toBe("error");
    const errors = store.blocks.listBySession(created.session.id)
      .filter((block) => block.kind === "error");
    expect(errors).toHaveLength(1);
  });

  it("builds no harness when a rule names a boundary this capture cannot enforce", async () => {
    const created = liveSession("codex");
    const agentId = created.agents[0]!.id;
    // A Codex agent with no approval policy cannot enforce a command-approval
    // rule, and the session-scoped rule says it must.
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId: created.session.id },
      boundary: "codex-command-approval", pattern: "*", decision: "deny", enabled: true,
    });

    const turnId = await sendTurn(created.session.id, agentId);

    expect(built).toHaveLength(0);
    expect(store.turns.get(turnId)?.status).toBe("error");
  });
});

describe("a delegated child is governed like any other run", () => {
  /** Build a child exactly as `delegate_task` does, through the real hooks. */
  const buildChild = (sessionId: string, parentAgentId: string, over: {
    backend?: "api" | "codex";
    approvalPolicy?: string;
    throwOnBuild?: boolean;
  } = {}) => {
    const facts = {
      projectId, readOnly: false,
      backend: (over.backend ?? "api") as "api" | "codex",
      ...(over.approvalPolicy !== undefined ? { codexApprovalPolicy: over.approvalPolicy } : {}),
      declaresDynamicTools: false,
    };
    const childAgentId = `${parentAgentId}#delegate-1`;
    const decision = runtime.hooks.checkDispatch(sessionId, childAgentId, facts);
    if (!decision.allowed) return { refused: decision.message, childAgentId };
    const token = runtime.hooks.capture({ sessionId, agentId: childAgentId, ...facts });
    if (over.throwOnBuild) {
      runtime.hooks.release(sessionId, childAgentId);
      return { threw: true, childAgentId };
    }
    return { token, childAgentId };
  };

  it("refuses to start a child once the session was reassigned to a viewer", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    await sendTurn(created.session.id, agentId);
    expect(built).toHaveLength(1);

    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      created.session.id, viewer.id);

    // The parent's turn started under an owner; the child must not.
    const outcome = buildChild(created.session.id, agentId);
    expect(outcome.refused).toBeTruthy();
    expect(runtime.lifecycles.tokenFor(created.session.id, outcome.childAgentId)).toBeNull();
  });

  it("judges the child against its own resolved configuration", async () => {
    const created = liveSession("codex");
    const agentId = created.agents[0]!.id;
    await sendTurn(created.session.id, agentId);
    // A rule this child's own approval policy cannot enforce refuses it, even
    // though the parent is a different backend entirely.
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId: created.session.id },
      boundary: "codex-command-approval", pattern: "*", decision: "deny", enabled: true,
    });
    expect(buildChild(created.session.id, agentId,
      { backend: "codex", approvalPolicy: "never" }).refused).toBeTruthy();
    // With a policy that does ask the app, the same child is admissible.
    expect(buildChild(created.session.id, agentId,
      { backend: "codex", approvalPolicy: "on-request" }).token).toBeTruthy();
  });

  it("gives the child its own token and releases it when the build fails", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    await sendTurn(created.session.id, agentId);
    const parentToken = runtime.lifecycles.tokenFor(created.session.id, agentId);

    const ok = buildChild(created.session.id, agentId);
    expect(ok.token).not.toBe(parentToken);
    runtime.hooks.release(created.session.id, ok.childAgentId);

    const failed = buildChild(created.session.id, agentId, { throwOnBuild: true });
    expect(failed.threw).toBe(true);
    expect(runtime.lifecycles.tokenFor(created.session.id, failed.childAgentId)).toBeNull();
  });
});

describe("the tool catalogue is metadata, never a turn", () => {
  const withCatalogue = (answer: unknown, onCall?: () => void) => {
    engine = createSessionRunner({
      store,
      broadcast: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      policy: runtime.hooks,
      makeHarness: (agent, extras) => {
        built.push({ backend: agent.backend, authorizeLocal: extras.authorizeLocal });
        return {
          start: async () => {},
          send: () => { throw new Error("catalogue must never send a prompt"); },
          interrupt: async () => {},
          dispose: async () => {},
          ...(answer === undefined ? {} : {
            catalogue: async () => { onCall?.(); return answer; },
          }),
        } as never;
      },
    });
  };

  it("answers notStarted rather than launching a runtime nobody asked for", async () => {
    const created = liveSession();
    withCatalogue({ kind: "ok", servers: [], truncated: false });
    expect(await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, false))
      .toEqual({ kind: "notStarted" });
    expect(built).toHaveLength(0);
  });

  it("starts a runtime for an explicit refresh, and sends no prompt", async () => {
    const created = liveSession();
    let queried = 0;
    withCatalogue({ kind: "ok", servers: [{ name: "docs", state: "connected",
      tools: ["search"], truncated: false }], truncated: false }, () => { queried += 1; });
    const answer = await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, true);
    expect(answer).toMatchObject({ kind: "ok" });
    expect(queried).toBe(1);
    expect(built).toHaveLength(1);
    // No turn row was created, so nothing was ever dispatched.
    expect(store.turns.list(created.session.id)).toHaveLength(0);
  });

  it("keeps unsupported, error and notStarted distinct", async () => {
    const created = liveSession();
    // A harness with no catalogue surface at all.
    withCatalogue(undefined);
    expect(await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, true))
      .toEqual({ kind: "unsupported" });

    withCatalogue({ kind: "ok", servers: [], truncated: false });
    await engine.dispose();
    engine = createSessionRunner({
      store, broadcast: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      policy: runtime.hooks,
      makeHarness: () => ({
        start: async () => {},
        send: () => (async function* () {})(),
        interrupt: async () => {},
        dispose: async () => {},
        catalogue: async () => { throw new Error("the backend refused"); },
      } as never),
    });
    expect(await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, true))
      .toEqual({ kind: "error" });
  });

  it("refuses to give a read-only artifact a runtime", async () => {
    const created = liveSession();
    store.db.run("UPDATE sessions SET origin='import', artifact_kind='shared-bundle' WHERE id=?",
      created.session.id);
    withCatalogue({ kind: "ok", servers: [], truncated: false });
    expect(await engine.catalogueAgent!(created.session.id, created.agents[0]!.id, true))
      .toEqual({ kind: "notStarted" });
    expect(built).toHaveLength(0);
  });
});

describe("captures do not survive what ends them", () => {
  it("releases the capture when the harness cannot be built", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    engine = createSessionRunner({
      store,
      broadcast: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      policy: runtime.hooks,
      makeHarness: () => { throw new Error("the backend refused to start"); },
    });
    const turnId = await sendTurn(created.session.id, agentId);
    expect(store.turns.get(turnId)?.status).toBe("error");
    // The capture went with the failed build rather than outliving it.
    expect(runtime.lifecycles.tokenFor(created.session.id, agentId)).toBeNull();
    expect(runtime.lifecycles.size()).toBe(0);
  });
});
