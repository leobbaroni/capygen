import { describe, expect, it, vi } from "vitest";
import { AskBroker, localAnswerFor } from "../src/policies/askBroker.js";
import type { ApprovalPrompt } from "../src/policies/LocalPolicyService.js";

const member = { id: "mbr_1", label: "Owner", role: "owner" as const,
  builtIn: true, createdAt: 1, updatedAt: 1 };

const prompt = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  requestId: "req_1", sessionId: "ses_1", agentId: "agt_1", backend: "codex",
  boundary: "codex-command-approval", toolName: "Bash",
  input: { command: "ls" }, cwd: "C:\\work",
  rule: { id: "rule_1", scope: { kind: "project", projectId: "prj_1" },
    boundary: "codex-command-approval", pattern: "Bash", decision: "ask",
    enabled: true, createdAt: 1, updatedAt: 1 },
  member, originTurnId: "trn_1", executionSite: "backend" as const, ...over,
});

function brokerWith() {
  const published: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  let seq = 0;
  const broker = new AskBroker({
    publish: (card) => { published.push(card); return { blockId: `blk_${(seq += 1)}`, turnId: "trn_1" }; },
    settleCard: (info) => { settled.push(info as unknown as Record<string, unknown>); },
    now: () => 1_757_000_000_000,
  });
  return { broker, published, settled };
}

describe("a local ask becomes an ordinary permission card", () => {
  it("publishes one card carrying its rule and scope attribution", async () => {
    const { broker, published } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    expect(published).toHaveLength(1);
    const request = (published[0] as { request: Record<string, unknown> }).request;
    expect(request).toMatchObject({
      requestId: "req_1", toolName: "Bash",
      localPolicy: { ruleId: "rule_1", boundary: "codex-command-approval",
        scope: { kind: "project", projectId: "prj_1" } },
    });
    // The card shows the frozen input, and names the profile as a label.
    expect(request.input).toEqual({ command: "ls" });
    expect(String(request.reason)).toContain("Owner");
    broker.answer("req_1", { behavior: "deny" });
    await expect(pending).resolves.toEqual({ kind: "deny" });
  });

  it("attributes a prompt with no rule without inventing one", async () => {
    const { broker, published } = brokerWith();
    const pending = broker.ask(prompt({ rule: null }), undefined);
    expect((published[0] as { request: { localPolicy: unknown } }).request.localPolicy)
      .toMatchObject({ ruleId: null, scope: null, boundary: "codex-command-approval" });
    broker.answer("req_1", { behavior: "deny" });
    await pending;
  });
});

describe("an answer means exactly what it said", () => {
  it("keeps allow-once and allow-for-session distinct", async () => {
    for (const [scope, kind] of [["once", "allow-once"], ["session", "allow-session"]] as const) {
      const { broker } = brokerWith();
      const pending = broker.ask(prompt(), undefined);
      expect(broker.answer("req_1", { behavior: "allow", scope })).toEqual({ ok: true });
      await expect(pending).resolves.toEqual({ kind });
    }
  });

  it("never lets a card mint standing authority", async () => {
    // Historical `allow_always`, and the card's own "always" scope, both
    // authorize this call only: a permanent allow is a policy edit.
    for (const decision of [
      { behavior: "allow_always" as const },
      { behavior: "allow_always" as const, scope: "always" as const },
      { behavior: "allow" as const, scope: "always" as const },
    ]) {
      expect(localAnswerFor(decision)).toEqual({ kind: "allow-once" });
    }
  });

  it("carries an edited input through, and distinguishes it from none", async () => {
    const { broker } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    broker.answer("req_1", { behavior: "allow", scope: "once",
      hasUpdatedInput: true, updatedInput: { command: "ls -la" } });
    await expect(pending).resolves.toEqual({ kind: "allow-once", input: { command: "ls -la" } });

    // An answer with no edit must not carry `input: undefined`, which the
    // service would read as an edit to `undefined`.
    const second = brokerWith();
    const waiting = second.broker.ask(prompt(), undefined);
    second.broker.answer("req_1", { behavior: "allow", scope: "once" });
    const answer = await waiting;
    expect(answer).toEqual({ kind: "allow-once" });
    expect("input" in answer).toBe(false);
  });

  it("records the decision on the same card it published", async () => {
    const { broker, settled } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    broker.answer("req_1", { behavior: "allow", scope: "session" });
    await pending;
    expect(settled[0]).toMatchObject({
      blockId: "blk_1", sessionId: "ses_1", requestId: "req_1",
      decision: { behavior: "allow", scope: "session", decidedAt: 1_757_000_000_000 },
    });
  });
});

describe("nothing stays waiting against authority it no longer has", () => {
  it("reports a stale answer instead of authorizing", async () => {
    const { broker } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    expect(broker.answer("req_1", { behavior: "deny" })).toEqual({ ok: true });
    await pending;
    // Answered twice, answered late, answered for something unknown.
    expect(broker.answer("req_1", { behavior: "allow", scope: "session" }))
      .toEqual({ ok: false, reason: "stale" });
    expect(broker.answer("req_nope", { behavior: "allow" })).toEqual({ ok: false, reason: "stale" });
    expect(broker.owns("req_1")).toBe(false);
  });

  it("settles as cancelled when the call is aborted", async () => {
    const { broker } = brokerWith();
    const controller = new AbortController();
    const pending = broker.ask(prompt(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    // And an answer arriving after the abort changes nothing.
    expect(broker.answer("req_1", { behavior: "allow", scope: "session" }))
      .toEqual({ ok: false, reason: "stale" });
  });

  it("does not publish a card for a call that was already cancelled", async () => {
    const { broker, published } = brokerWith();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.ask(prompt(), controller.signal)).resolves.toEqual({ kind: "cancelled" });
    expect(published).toHaveLength(0);
  });

  it("denies a session's waiting requests on a restrictive reassignment", async () => {
    const { broker, settled } = brokerWith();
    const mine = broker.ask(prompt(), undefined);
    const other = broker.ask(prompt({ requestId: "req_2", sessionId: "ses_2" }), undefined);
    expect(broker.denySession("ses_1", "this profile can no longer approve tools")).toBe(1);
    await expect(mine).resolves.toEqual({ kind: "deny" });
    expect(settled.at(-1)).toMatchObject({ requestId: "req_1",
      decision: { behavior: "deny", message: "this profile can no longer approve tools" } });
    // Another session's card is untouched.
    expect(broker.owns("req_2")).toBe(true);
    broker.dispose();
    await expect(other).resolves.toEqual({ kind: "cancelled" });
  });

  it("cancels one agent's requests when its child goes away", async () => {
    const { broker } = brokerWith();
    const child = broker.ask(prompt({ requestId: "req_c", agentId: "child-1" }), undefined);
    const parent = broker.ask(prompt({ requestId: "req_p", agentId: "agt_1" }), undefined);
    expect(broker.cancelAgent("ses_1", "child-1")).toBe(1);
    await expect(child).resolves.toEqual({ kind: "cancelled" });
    expect(broker.pending()).toEqual([{ requestId: "req_p", sessionId: "ses_1", agentId: "agt_1" }]);
    broker.dispose();
    await parent;
  });

  it("settles the persisted card on every exit, not just an answer", async () => {
    // A resolved promise with an un-settled card leaves a permission prompt in
    // the transcript and the Inbox for ever, waiting on a call that is gone.
    for (const [name, act] of [
      ["abort", (b: AskBroker, c: AbortController) => c.abort()],
      ["agent released", (b: AskBroker) => { b.cancelAgent("ses_1", "agt_1"); }],
      ["shutdown", (b: AskBroker) => { b.dispose(); }],
    ] as const) {
      const { broker, settled } = brokerWith();
      const controller = new AbortController();
      const pending = broker.ask(prompt(), controller.signal);
      act(broker, controller);
      await pending;
      expect(settled, name).toHaveLength(1);
      expect(settled[0], name).toMatchObject({
        blockId: "blk_1", requestId: "req_1",
        decision: { behavior: "deny", scope: "once" },
      });
      expect(String((settled[0]!.decision as { message: string }).message).length)
        .toBeGreaterThan(0);
    }
  });

  it("settles a card exactly once when two endings race", async () => {
    const { broker, settled } = brokerWith();
    const controller = new AbortController();
    const pending = broker.ask(prompt(), controller.signal);
    // An answer and an abort arriving together must not settle twice, and the
    // loser must report staleness rather than a second authorization.
    const first = broker.answer("req_1", { behavior: "allow", scope: "session" });
    controller.abort();
    const second = broker.answer("req_1", { behavior: "allow", scope: "session" });
    await expect(pending).resolves.toEqual({ kind: "allow-session" });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "stale" });
    expect(settled).toHaveLength(1);
  });

  it("records what an allow-always card actually did", async () => {
    const { broker, settled } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    broker.answer("req_1", { behavior: "allow_always", scope: "always" });
    await expect(pending).resolves.toEqual({ kind: "allow-once" });
    // The stored decision may not claim a standing authority nothing created.
    expect(settled[0]!.decision).toMatchObject({ behavior: "allow", scope: "once" });
  });

  it("refuses instead of waiting when no card can be published", async () => {
    const published: unknown[] = [];
    const broker = new AskBroker({
      publish: (card) => { published.push(card); return null; },
      settleCard: () => {},
    });
    // A prompt nobody can see is a prompt nobody can answer.
    await expect(broker.ask(prompt(), undefined)).resolves.toEqual({ kind: "deny" });
    expect(published).toHaveLength(1);
    expect(broker.pending()).toEqual([]);
  });

  it("refuses when publishing throws", async () => {
    const broker = new AskBroker({
      publish: () => { throw new Error("the event payload was rejected"); },
      settleCard: () => {},
    });
    await expect(broker.ask(prompt(), undefined)).resolves.toEqual({ kind: "deny" });
    expect(broker.pending()).toEqual([]);
  });

  it("resolves denied when the answer cannot be persisted", async () => {
    const broker = new AskBroker({
      publish: () => ({ blockId: "blk_1", turnId: "trn_1" }),
      settleCard: () => { throw new Error("the card could not be written"); },
    });
    const pending = broker.ask(prompt(), undefined);
    // An approval that could not be recorded must not become an executable
    // allow — and must not orphan the waiter either.
    expect(broker.answer("req_1", { behavior: "allow", scope: "session" })).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ kind: "deny" });
    expect(broker.pending()).toEqual([]);
  });

  it("displays an explicit always scope as the once it actually was", async () => {
    const { broker, settled } = brokerWith();
    const pending = broker.ask(prompt(), undefined);
    broker.answer("req_1", { behavior: "allow", scope: "always" });
    await expect(pending).resolves.toEqual({ kind: "allow-once" });
    expect(settled[0]!.decision).toMatchObject({ behavior: "allow", scope: "once" });
  });

  it("removes its abort listener once settled", async () => {
    const { broker } = brokerWith();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = broker.ask(prompt(), controller.signal);
    broker.answer("req_1", { behavior: "deny" });
    await pending;
    expect(remove).toHaveBeenCalled();
  });
});
