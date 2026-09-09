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
 * The `pre` → `final` path, which a Claude call takes twice.
 *
 * The property under test is that a receipt saves *asking twice*, and nothing
 * else: `final` re-evaluates the current rules, member, grants and lifecycle
 * every time, so a policy edit while the native approval was open still refuses.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let sessionId: string;
let agentId: string;
let token: string;
let asks: number;
let answer: "allow-once" | "allow-session" | "deny";

const broadcast = (<E extends EventChannel>(event: E, payload: never): void => {
  parseEventPayload(event, payload);
}) as never;

function setup(): void {
  const created = store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
      config: { api: { provider: "anthropic" } } }],
  });
  sessionId = created.session.id;
  agentId = created.agents[0]!.id;
  const turn = store.turns.create({ sessionId, agentId, role: "agent", status: "streaming" });

  const cards = createPermissionCardPublisher({
    store, broadcast, newBlockId: () => `blk_${Math.random().toString(16).slice(2)}`,
  });
  runtime = createPolicyRuntime({
    store,
    ask: {
      publish: (card) => {
        asks += 1;
        const published = cards.publish(card);
        // Answer as soon as the card is up, like a user clicking.
        if (published) {
          setImmediate(() => {
            runtime.broker.answer(card.request.requestId, answer === "deny"
              ? { behavior: "deny" }
              : { behavior: "allow", scope: answer === "allow-session" ? "session" : "once" });
          });
        }
        return published;
      },
      settleCard: cards.settleCard,
    },
    publishChanged: () => {},
    engine: () => null,
  });
  runtime.hooks.capture({
    sessionId, agentId, projectId, backend: "api", readOnly: false,
    declaresDynamicTools: false,
  });
  token = runtime.lifecycles.tokenFor(sessionId, agentId)!;
  runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
    scope: { kind: "session", sessionId },
    boundary: "api-tool", pattern: "*", decision: "ask", enabled: true,
  });
  void turn;
}

const authorize = (over: Record<string, unknown> = {}) => runtime.service.authorize({
  sessionId, agentId, lifecycleToken: token,
  originTurnId: store.turns.list(sessionId)[0]!.id,
  boundary: "api-tool", toolName: "Write", input: { path: "a.txt" }, cwd: "C:\\work",
  stage: "pre", callId: "call_1", requestId: `req_${Math.random().toString(16).slice(2)}`,
  ...over,
} as never);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-receipt-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  asks = 0;
  answer = "allow-once";
  setup();
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("one call asks the user once", () => {
  it("reuses the pre answer for the final check of the same call and input", async () => {
    expect((await authorize()).allowed).toBe(true);
    expect(asks).toBe(1);
    expect((await authorize({ stage: "final" })).allowed).toBe(true);
    expect(asks).toBe(1);
  });

  it("consumes the receipt, so a replay asks again", async () => {
    await authorize();
    await authorize({ stage: "final" });
    expect(asks).toBe(1);
    await authorize({ stage: "final" });
    expect(asks).toBe(2);
  });
});

describe("the final check always re-evaluates current authority", () => {
  it("refuses when a rule was edited to deny while the approval waited", async () => {
    expect((await authorize()).allowed).toBe(true);
    const rule = runtime.service.listRules()
      .find((candidate) => candidate.pattern === "*")!;
    runtime.service.updateRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, rule.id,
      { decision: "deny" });

    const final = await authorize({ stage: "final" });
    expect(final.allowed).toBe(false);
    expect(final.reason).toBe("rule");
  });

  it("refuses after the subject is demoted to a viewer", async () => {
    expect((await authorize()).allowed).toBe(true);
    const viewer = runtime.service.createMember({ memberId: BUILT_IN_OWNER_MEMBER_ID },
      { label: "Reviewer", role: "viewer" });
    runtime.service.assignMember({ memberId: BUILT_IN_OWNER_MEMBER_ID }, sessionId, viewer.id);
    expect((await authorize({ stage: "final" })).allowed).toBe(false);
  });

  it("refuses after every grant is revoked", async () => {
    answer = "allow-session";
    expect((await authorize()).allowed).toBe(true);
    runtime.service.revokeGrants({ memberId: BUILT_IN_OWNER_MEMBER_ID });
    // The revocation moved the epoch, so the receipt is discarded and the user
    // is asked again rather than carried by the earlier answer.
    answer = "deny";
    expect((await authorize({ stage: "final" })).allowed).toBe(false);
    expect(asks).toBe(2);
  });

  it("refuses after the lifecycle ended, and after a restart mints a new one", async () => {
    expect((await authorize()).allowed).toBe(true);
    runtime.hooks.release(sessionId, agentId);
    expect((await authorize({ stage: "final" })).allowed).toBe(false);

    // A restarted capture is a different lifecycle: its token cannot satisfy
    // the receipt the old one produced.
    const fresh = runtime.hooks.capture({
      sessionId, agentId, projectId, backend: "api", readOnly: false,
      declaresDynamicTools: false,
    });
    expect(fresh).not.toBe(token);
    answer = "deny";
    expect((await authorize({ stage: "final", lifecycleToken: fresh })).allowed).toBe(false);
  });

  // Three disk-backed authorization pairs can exceed 5s on hosted Windows.
  it("asks again when the tool, cwd or input changed", async () => {
    for (const changed of [
      { toolName: "Read" },
      { cwd: "C:\\elsewhere" },
      { input: { path: "b.txt" } },
    ]) {
      asks = 0;
      await authorize();
      expect(asks).toBe(1);
      await authorize({ stage: "final", ...changed });
      expect(asks, JSON.stringify(changed)).toBe(2);
    }
  }, process.env.CI ? 30_000 : 5_000);

  it("refuses a final check that was cancelled, without reusing the answer", async () => {
    expect((await authorize()).allowed).toBe(true);
    const controller = new AbortController();
    controller.abort();
    const final = await authorize({ stage: "final", signal: controller.signal });
    expect(final.allowed).toBe(false);
    expect(final.reason).toBe("cancelled");
  });

  it("never lets one call's receipt answer another call", async () => {
    expect((await authorize()).allowed).toBe(true);
    answer = "deny";
    expect((await authorize({ stage: "final", callId: "call_2" })).allowed).toBe(false);
    await tick();
  });
});
