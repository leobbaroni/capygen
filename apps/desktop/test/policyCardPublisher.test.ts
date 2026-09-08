import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { parseEventPayload, type EventChannel } from "@capygen/shared";
import { createPolicyRuntime, createPermissionCardPublisher, type PolicyRuntime }
  from "../src/policies/runtime.js";

/**
 * The publisher, driven through the **real** event parser.
 *
 * A no-op broadcast double is what let a malformed `permission.request` ship:
 * main parses every event before it sends it, so a payload the contract refuses
 * throws there — before the broker registers a waiter — and every local ask
 * died with its card stuck at a null decision. These tests parse exactly as
 * main does, so the shape is checked rather than assumed.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let sent: Array<{ event: string; payload: unknown }>;
let blockSeq: number;

/** Exactly what `main.broadcast` does: parse, then deliver. */
const broadcast = (<E extends EventChannel>(event: E, payload: never): void => {
  sent.push({ event, payload: parseEventPayload(event, payload) });
}) as never;

const publisher = () => createPermissionCardPublisher({
  store, broadcast, newBlockId: () => `blk_local_${(blockSeq += 1)}`,
  now: () => 1_757_000_000_000,
});

function liveSession() {
  return store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
      config: { api: { provider: "anthropic" } } }],
  });
}

const request = {
  requestId: "req_1", toolName: "Write", input: { path: "a.txt" },
  reason: "capygen's local policy asks before this Write call (session profile: Owner).",
  suggestions: [],
  localPolicy: { ruleId: "rule_1", scope: { kind: "global" as const }, boundary: "api-tool" as const },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-card-publisher-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  sent = [];
  blockSeq = 0;
  runtime = createPolicyRuntime({
    store, ask: publisher(), publishChanged: () => {}, engine: () => null,
  });
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a published card satisfies the event contract", () => {
  it("emits permission.request with the turn and block the card really has", () => {
    const created = liveSession();
    const turn = store.turns.create({
      sessionId: created.session.id, agentId: created.agents[0]!.id,
      role: "agent", status: "streaming",
    });

    const card = publisher().publish({
      sessionId: created.session.id, agentId: created.agents[0]!.id,
      originTurnId: turn.id, request,
    });

    expect(card).toEqual({ blockId: "blk_local_1", turnId: turn.id });
    // The parser accepted it — which is the whole point of this test.
    const event = sent.find((entry) => entry.event === "permission.request")!;
    expect(event.payload).toMatchObject({
      sessionId: created.session.id, turnId: turn.id, blockId: "blk_local_1",
      request: { requestId: "req_1", toolName: "Write" },
    });

    // The block exists, is answerable, and is emitted before the request.
    expect(sent.map((entry) => entry.event)).toEqual(["chat.block", "permission.request"]);
    const stored = store.blocks.get("blk_local_1")!;
    expect(stored).toMatchObject({ kind: "permission", turnId: turn.id, decision: null });
  });

  it("carries the rule attribution the card renders", () => {
    const created = liveSession();
    const turn = store.turns.create({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, role: "agent", status: "streaming" });
    publisher().publish({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, originTurnId: turn.id, request });
    const event = sent.find((entry) => entry.event === "permission.request")!;
    expect((event.payload as { request: { localPolicy: unknown } }).request.localPolicy)
      .toMatchObject({ ruleId: "rule_1", boundary: "api-tool" });
  });

  it("records the answer on the same card", () => {
    const created = liveSession();
    const turn = store.turns.create({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, role: "agent", status: "streaming" });
    const publish = publisher();
    const card = publish.publish({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, originTurnId: turn.id, request })!;
    sent.length = 0;
    publish.settleCard({
      blockId: card.blockId, sessionId: created.session.id, requestId: "req_1",
      decision: { behavior: "allow", scope: "session", decidedAt: 1_757_000_000_001 },
    });
    const stored = store.blocks.get(card.blockId)!;
    expect(stored.kind === "permission" && stored.decision)
      .toMatchObject({ behavior: "allow", scope: "session" });
    expect(sent.map((entry) => entry.event)).toEqual(["chat.block"]);
  });

  it("publishes nothing when there is no turn to attach the card to", () => {
    const created = liveSession();
    expect(publisher().publish({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, originTurnId: null, request })).toBeNull();
    // A turn from a different session is not this session's card either.
    const other = liveSession();
    const foreign = store.turns.create({ sessionId: other.session.id, role: "agent",
      status: "streaming" });
    expect(publisher().publish({ sessionId: created.session.id,
      agentId: created.agents[0]!.id, originTurnId: foreign.id, request })).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("an ask that cannot be shown is refused, not left waiting", () => {
  it("denies rather than hanging when no card can be published", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId,
      backend: "api", readOnly: false, declaresDynamicTools: false,
    });
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId: created.session.id },
      boundary: "api-tool", pattern: "Write", decision: "ask", enabled: true,
    });

    // No turn exists, so the card cannot be shown.
    const authorization = await runtime.service.authorize({
      sessionId: created.session.id, agentId,
      lifecycleToken: runtime.lifecycles.tokenFor(created.session.id, agentId)!,
      originTurnId: null,
      boundary: "api-tool", toolName: "Write", input: {}, cwd: dir,
    });
    expect(authorization.allowed).toBe(false);
    expect(authorization.message).toBeTruthy();
  });

  it("asks, and is answerable, when the turn is real", async () => {
    const created = liveSession();
    const agentId = created.agents[0]!.id;
    const turn = store.turns.create({ sessionId: created.session.id, agentId,
      role: "agent", status: "streaming" });
    runtime.hooks.capture({
      sessionId: created.session.id, agentId, projectId,
      backend: "api", readOnly: false, declaresDynamicTools: false,
    });
    runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
      scope: { kind: "session", sessionId: created.session.id },
      boundary: "api-tool", pattern: "Write", decision: "ask", enabled: true,
    });

    const pending = runtime.service.authorize({
      sessionId: created.session.id, agentId,
      lifecycleToken: runtime.lifecycles.tokenFor(created.session.id, agentId)!,
      originTurnId: turn.id,
      boundary: "api-tool", toolName: "Write", input: { path: "a.txt" }, cwd: dir,
      requestId: "req_live",
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The card reached the renderer through the real parser, and the broker
    // owns the request, so `permission.answer` can settle it.
    expect(sent.some((entry) => entry.event === "permission.request")).toBe(true);
    expect(runtime.broker.owns("req_live")).toBe(true);
    expect(runtime.broker.answer("req_live", { behavior: "allow", scope: "once" }))
      .toEqual({ ok: true });

    const authorization = await pending;
    expect(authorization.allowed).toBe(true);
    const blockId = (sent.find((entry) => entry.event === "permission.request")!
      .payload as { blockId: string }).blockId;
    const settled = store.blocks.get(blockId)!;
    expect(settled.kind === "permission" && settled.decision)
      .toMatchObject({ behavior: "allow", scope: "once" });
  });
});
