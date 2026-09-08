import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, BUILT_IN_OWNER_MEMBER_ID, type CapygenStore } from "@capygen/db";
import { createPolicyRuntime, type PolicyRuntime } from "../src/policies/runtime.js";
import { AskBroker } from "../src/policies/askBroker.js";

/**
 * Two calls of the same tool, in the same millisecond.
 *
 * The clock is frozen on purpose: the default request id was
 * `${session}:${tool}:${now}`, so two parallel calls to one tool inside a
 * single millisecond produced the *same* id — the second card overwrote the
 * first's waiter, and one of the two calls could never be answered.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const FROZEN = 1_757_000_000_000;

let dir: string;
let store: CapygenStore;
let projectId: string;
let runtime: PolicyRuntime;
let sessionId: string;
let agentId: string;
let token: string;
let cards: Array<{ requestId: string; resolve: (kind: "allow" | "deny") => void }>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-reqid-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
  cards = [];
  runtime = createPolicyRuntime({
    store,
    // Every card is published and left open, so both calls are genuinely
    // in flight at once.
    ask: {
      publish: (card) => {
        cards.push({
          requestId: card.request.requestId,
          resolve: (kind) => runtime.broker.answer(card.request.requestId,
            kind === "allow" ? { behavior: "allow", scope: "once" } : { behavior: "deny" }),
        });
        return { blockId: `blk_${cards.length}`, turnId: "trn_1" };
      },
      settleCard: () => {},
    },
    publishChanged: () => {},
    engine: () => null,
    now: () => FROZEN,
  });
  const created = store.sessions.create({
    projectId, mode: "solo", title: "T",
    agents: [{ name: "A", backend: "api", model: "claude-opus-5", role: "lead",
      config: { api: { provider: "anthropic" } } }],
  });
  sessionId = created.session.id;
  agentId = created.agents[0]!.id;
  token = runtime.hooks.capture({
    sessionId, agentId, projectId, backend: "api", readOnly: false,
    declaresDynamicTools: false,
  });
  runtime.service.createRule({ memberId: BUILT_IN_OWNER_MEMBER_ID }, {
    scope: { kind: "session", sessionId },
    boundary: "api-tool", pattern: "Bash", decision: "ask", enabled: true,
  });
});

afterEach(() => {
  runtime.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const authorize = (input: unknown) => runtime.service.authorize({
  sessionId, agentId, lifecycleToken: token, originTurnId: "trn_1",
  boundary: "api-tool", toolName: "Bash", input, cwd: "C:\\work",
});

describe("two calls in the same millisecond are two decisions", () => {
  it("gives each its own request id, card and answer", async () => {
    const first = authorize({ command: "ls" });
    const second = authorize({ command: "rm -rf /" });
    await tick();
    await tick();

    // Both are waiting, under distinct ids.
    expect(cards).toHaveLength(2);
    expect(cards[0]!.requestId).not.toBe(cards[1]!.requestId);
    expect(runtime.broker.pending()).toHaveLength(2);

    // Answering one settles only that one.
    cards[0]!.resolve("allow");
    await tick();
    expect(runtime.broker.pending()).toHaveLength(1);
    cards[1]!.resolve("deny");

    const [a, b] = await Promise.all([first, second]);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    // The allowed one authorized *its own* input, not its neighbour's.
    expect(a.approvedInput).toEqual({ command: "ls" });
  });

  it("settles both cards rather than stranding one", async () => {
    const first = authorize({ command: "one" });
    const second = authorize({ command: "two" });
    await tick();
    await tick();
    cards.forEach((card) => card.resolve("deny"));
    await Promise.all([first, second]);
    expect(runtime.broker.pending()).toEqual([]);
  });
});

describe("the broker refuses a duplicate pending id", () => {
  it("does not overwrite a waiter that is already open", async () => {
    const published: string[] = [];
    const broker = new AskBroker({
      publish: (card) => {
        published.push(card.request.requestId);
        return { blockId: `blk_${published.length}`, turnId: "trn_1" };
      },
      settleCard: () => {},
    });
    const member = store.localMembers.get(BUILT_IN_OWNER_MEMBER_ID)!;
    const prompt = {
      requestId: "req_same", sessionId, agentId, backend: "api" as const,
      boundary: "api-tool" as const, toolName: "Bash", input: {}, cwd: "C:\\work",
      rule: null, member, originTurnId: "trn_1", executionSite: "backend" as const,
    };

    const first = broker.ask(prompt, undefined);
    await tick();
    // A second prompt reusing a live id must not replace the first's waiter,
    // and must not publish a second card for it either.
    const second = await broker.ask(prompt, undefined);
    expect(second).toEqual({ kind: "deny" });
    expect(published).toEqual(["req_same"]);

    // The original is untouched and still answerable.
    expect(broker.owns("req_same")).toBe(true);
    expect(broker.answer("req_same", { behavior: "allow", scope: "once" })).toEqual({ ok: true });
    await expect(first).resolves.toEqual({ kind: "allow-once" });
  });
});
