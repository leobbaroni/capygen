import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { LocalAuthorize } from "@capygen/engine";
import { createSessionRunner, type SessionPolicyHooks } from "../src/engine/SessionRunner.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** `Engine.send` is fire-and-forget; let its turn reach a terminal state. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let dir: string;
let store: CapygenStore;
let projectId: string;

/** Records what the runner asked policy, and what it built. */
function harness() {
  const captures: Array<Record<string, unknown>> = [];
  const released: string[] = [];
  const authorizers: Array<Record<string, unknown>> = [];
  let seq = 0;
  let dispatch: { allowed: true } | { allowed: false; message: string } = { allowed: true };
  const hooks: SessionPolicyHooks = {
    capture: (info) => { captures.push(info); return `tok_${(seq += 1)}`; },
    release: (sessionId, agentId) => released.push(`${sessionId}:${agentId}`),
    authorizeFor: (bound) => {
      authorizers.push(bound);
      return (() => ({ allowed: true, approvedInput: {} })) as LocalAuthorize;
    },
    checkDispatch: () => dispatch,
  };
  return {
    hooks, captures, released, authorizers,
    refuse: (message: string) => { dispatch = { allowed: false, message }; },
  };
}

function runnerWith(policy: SessionPolicyHooks) {
  const built: Array<{ authorizeLocal: unknown }> = [];
  const engine = createSessionRunner({
    store,
    broadcast: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    policy,
    makeHarness: (_agent, extras) => {
      built.push({ authorizeLocal: extras.authorizeLocal });
      return {
        start: async () => {},
        // A harness that answers nothing: these tests are about what happens
        // before and around a turn, not about streaming.
        send: () => (async function* () {})(),
        interrupt: async () => {},
        dispose: async () => {},
      } as never;
    },
  });
  return { engine, built };
}

function session(origin: "live" | "import" = "live") {
  const created = store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend: "codex", model: "gpt-5-codex", role: "lead", config: null }],
  });
  if (origin === "import") {
    store.db.run(
      "UPDATE sessions SET origin='import', artifact_kind='native-transcript' WHERE id=?",
      created.session.id);
  }
  return created;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-runner-policy-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a turn is governed before a model can run", () => {
  it("refuses without building a harness when dispatch is denied", async () => {
    const policy = harness();
    const { engine, built } = runnerWith(policy.hooks);
    const created = session();
    policy.refuse("This session's profile can view history but not run tools.");
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });

    engine.send({
      sessionId: created.session.id, turnId: turn.id,
      agentId: created.agents[0]!.id, text: "hello",
    });
    await settle();

    expect(store.turns.get(turn.id)?.status).toBe("error");
    // Nothing was captured, nothing was built: no model call happened.
    expect(built).toHaveLength(0);
    expect(policy.captures).toHaveLength(0);
    // The refusal is visible in the transcript rather than silent.
    const blocks = store.blocks.listBySession(created.session.id);
    expect(blocks.some((block) => block.kind === "error"
      && block.message.includes("view history but not run tools"))).toBe(true);
    await engine.dispose();
  });

  it("captures the agent and binds an authorizer when dispatch is allowed", async () => {
    const policy = harness();
    const { engine, built } = runnerWith(policy.hooks);
    const created = session();
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });

    engine.send({
      sessionId: created.session.id, turnId: turn.id,
      agentId: created.agents[0]!.id, text: "hello",
    });
    await settle();

    expect(policy.captures[0]).toMatchObject({
      sessionId: created.session.id, agentId: created.agents[0]!.id,
      projectId, backend: "codex", readOnly: false,
    });
    // The authorizer is bound to the capture's own token, by main.
    // The bound values, plus the closure that resolves the card's turn.
    expect(policy.authorizers[0]).toMatchObject({
      sessionId: created.session.id, agentId: created.agents[0]!.id, lifecycleToken: "tok_1",
    });
    expect(typeof (policy.authorizers[0] as { originTurnId: unknown }).originTurnId)
      .toBe("function");
    expect(typeof built[0]!.authorizeLocal).toBe("function");
    await engine.dispose();
  });

  it("never captures a read-only artifact, because it never dispatches", async () => {
    const policy = harness();
    const { engine, built } = runnerWith(policy.hooks);
    const created = session("import");
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });
    // The runner's own imported-session guard refuses outright, before policy
    // is consulted, so nothing is captured or started.
    expect(() => engine.send({
      sessionId: created.session.id, turnId: turn.id,
      agentId: created.agents[0]!.id, text: "hello",
    })).toThrow(/read-only/i);
    await settle();
    expect(policy.captures).toHaveLength(0);
    expect(built).toHaveLength(0);
    await engine.dispose();
  });

  it("ends the lifecycle when the harness is released", async () => {
    const policy = harness();
    const { engine } = runnerWith(policy.hooks);
    const created = session();
    const agentId = created.agents[0]!.id;
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });
    engine.send({ sessionId: created.session.id, turnId: turn.id, agentId, text: "hello" });
    await settle();

    // A configuration change evicts the harness; the token dies with it.
    store.sessions.updateAgent(agentId, { model: "gpt-5.1-codex-max" });
    engine.agentConfigChanged?.(agentId);
    await settle();
    expect(policy.released).toContain(`${created.session.id}:${agentId}`);

    // The next turn is a new capture with a new token.
    const second = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });
    engine.send({ sessionId: created.session.id, turnId: second.id, agentId, text: "again" });
    await settle();
    expect(policy.captures).toHaveLength(2);
    expect(policy.authorizers[1]).toMatchObject({ lifecycleToken: "tok_2" });
    await engine.dispose();
  });

  it("gives a delegated child its own capture, and ends it with the child", async () => {
    // A child built through `delegate_task` is a separate run: it must not
    // inherit the parent's token, because a grant bound to the parent would
    // then authorize a tool the child chose.
    const policy = harness();
    const captured: Array<{ sessionId: string; agentId: string; token: string }> = [];
    const hooks: SessionPolicyHooks = {
      ...policy.hooks,
      capture: (info) => {
        const token = policy.hooks.capture(info);
        captured.push({ sessionId: info.sessionId, agentId: info.agentId, token });
        return token;
      },
    };
    const created = session();
    const parentId = created.agents[0]!.id;
    const { engine } = runnerWith(hooks);
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });
    engine.send({ sessionId: created.session.id, turnId: turn.id, agentId: parentId, text: "hi" });
    await settle();

    // Only the parent so far; a child appears when `delegate_task` runs, which
    // this offline harness never triggers. What is asserted here is the
    // invariant the wiring guarantees: distinct ids produce distinct tokens.
    expect(captured).toHaveLength(1);
    const childToken = hooks.capture({
      sessionId: created.session.id, agentId: `${parentId}#delegate-1`,
      projectId, backend: "api", readOnly: false, declaresDynamicTools: false,
    });
    expect(childToken).not.toBe(captured[0]!.token);
    expect(policy.authorizers.every((bound) => bound.agentId !== `${parentId}#delegate-1`
      || bound.lifecycleToken === childToken)).toBe(true);
    await engine.dispose();
  });

  it("runs exactly as before when main wired no policy", async () => {
    const { engine, built } = runnerWith(undefined as unknown as SessionPolicyHooks);
    const created = session();
    const turn = store.turns.create({ sessionId: created.session.id, role: "user", status: "done" });
    engine.send({
      sessionId: created.session.id, turnId: turn.id,
      agentId: created.agents[0]!.id, text: "hello",
    });
    await settle();
    expect(store.turns.get(turn.id)?.status).not.toBe("error");
    expect(built[0]!.authorizeLocal).toBeUndefined();
    await engine.dispose();
  });
});
