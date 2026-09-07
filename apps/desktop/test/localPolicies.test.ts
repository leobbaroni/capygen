import { describe, expect, it } from "vitest";
import type { LocalPolicyRule, LocalPolicyRuleDraft } from "@capygen/shared";
import {
  evaluateLocalPolicy,
  matchesToolPattern,
  selectMatchingRules,
  unavailableBoundaryRefusals,
} from "../src/policies/evaluate.js";
import { SessionGrantRegistry, grantSignature, type GrantIdentity } from "../src/policies/grants.js";
import { snapshotToolInput } from "../src/policies/inputSnapshot.js";

let seq = 0;
function rule(over: Partial<LocalPolicyRule> & Partial<LocalPolicyRuleDraft> = {}): LocalPolicyRule {
  seq += 1;
  return {
    id: `lpr_${String(seq).padStart(3, "0")}`,
    scope: { kind: "global" },
    boundary: "api-tool",
    pattern: "*",
    decision: "allow",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as LocalPolicyRule;
}

const request = {
  sessionId: "ses_1", projectId: "prj_1", agentId: "agt_1",
  boundary: "api-tool" as const, toolName: "mcp__docs__search",
};

describe("bounded tool matching", () => {
  it("treats * as the only wildcard and everything else as literal text", () => {
    expect(matchesToolPattern("Bash", "Bash")).toBe(true);
    expect(matchesToolPattern("*", "anything at all")).toBe(true);
    expect(matchesToolPattern("mcp__docs__*", "mcp__docs__search")).toBe(true);
    expect(matchesToolPattern("mcp__docs__*", "mcp__docs__")).toBe(true);
    expect(matchesToolPattern("*__search", "mcp__docs__search")).toBe(true);
    expect(matchesToolPattern("mcp__*__search", "mcp__docs__deep__search")).toBe(true);
    expect(matchesToolPattern("mcp__docs__*", "mcp__other__search")).toBe(false);
    // No regex, no path or glob semantics beyond `*`.
    expect(matchesToolPattern("Bas?", "Bash")).toBe(false);
    expect(matchesToolPattern("Ba.h", "Bash")).toBe(false);
    expect(matchesToolPattern("B[a-z]sh", "Bash")).toBe(false);
    expect(matchesToolPattern("mcp__docs__?*", "mcp__docs__search")).toBe(false);
    // Case-sensitive, and no Unicode normalization: precomposed é and the
    // decomposed sequence are different tool names, as they are different bytes.
    expect(matchesToolPattern("bash", "Bash")).toBe(false);
    expect(matchesToolPattern("caf\u00e9", "cafe\u0301")).toBe(false);
    expect(matchesToolPattern("caf\u00e9", "caf\u00e9")).toBe(true);
  });

  it("settles a pattern made mostly of wildcards instead of backtracking forever", () => {
    const started = Date.now();
    // 60 required `a`s against a name holding 30: a rejection, reached promptly.
    expect(matchesToolPattern(`${"*a".repeat(60)}*`, `${"a".repeat(30)}b`)).toBe(false);
    expect(matchesToolPattern(`${"*a".repeat(60)}*`, `${"a".repeat(200)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("precedence across every applicable scope", () => {
  it("lets deny beat ask beat allow regardless of how narrow the allow is", () => {
    const globalDeny = rule({ pattern: "mcp__docs__*", decision: "deny" });
    const sessionAllow = rule({
      scope: { kind: "session", sessionId: "ses_1" }, pattern: "mcp__docs__search", decision: "allow",
    });
    const projectAsk = rule({
      scope: { kind: "project", projectId: "prj_1" }, pattern: "*", decision: "ask",
    });
    const outcome = evaluateLocalPolicy([sessionAllow, projectAsk, globalDeny], request);
    expect(outcome).toMatchObject({ decision: "deny", source: "rule", scopeKind: "global" });
    expect(outcome.rule?.id).toBe(globalDeny.id);
    expect(outcome.matched).toHaveLength(3);

    expect(evaluateLocalPolicy([sessionAllow, projectAsk], request))
      .toMatchObject({ decision: "ask", rule: { id: projectAsk.id } });
    expect(evaluateLocalPolicy([sessionAllow], request))
      .toMatchObject({ decision: "allow", source: "rule", rule: { id: sessionAllow.id } });
  });

  it("attributes an equal decision to the narrowest scope, then to the stable id", () => {
    const globalDeny = rule({ id: "lpr_aaa", pattern: "*", decision: "deny" });
    const projectDeny = rule({
      id: "lpr_zzz", scope: { kind: "project", projectId: "prj_1" }, pattern: "*", decision: "deny",
    });
    const sessionDeny = rule({
      id: "lpr_mmm", scope: { kind: "session", sessionId: "ses_1" }, pattern: "*", decision: "deny",
    });
    expect(evaluateLocalPolicy([globalDeny, projectDeny, sessionDeny], request).rule?.id)
      .toBe(sessionDeny.id);
    expect(evaluateLocalPolicy([projectDeny, globalDeny], request).rule?.id).toBe(projectDeny.id);
    // Same scope, same decision: the lower stable id wins, whatever the order.
    const twinA = rule({ id: "lpr_001", pattern: "mcp__*", decision: "deny" });
    const twinB = rule({ id: "lpr_002", pattern: "*search", decision: "deny" });
    expect(evaluateLocalPolicy([twinB, twinA], request).rule?.id).toBe("lpr_001");
    expect(evaluateLocalPolicy([twinA, twinB], request).rule?.id).toBe("lpr_001");
  });

  it("reports no local restriction as `default`, which is not an allow decision by a rule", () => {
    const outcome = evaluateLocalPolicy([], request);
    expect(outcome).toMatchObject({ decision: "allow", source: "default", rule: null, matched: [] });
  });

  it("ignores rules from another scope id, another boundary or a disabled row", () => {
    const otherProject = rule({
      scope: { kind: "project", projectId: "prj_2" }, pattern: "*", decision: "deny",
    });
    const otherSession = rule({
      scope: { kind: "session", sessionId: "ses_2" }, pattern: "*", decision: "deny",
    });
    const otherBoundary = rule({ boundary: "claude-pre-tool", pattern: "*", decision: "deny" });
    const disabled = rule({ pattern: "*", decision: "deny", enabled: false });
    const rules = [otherProject, otherSession, otherBoundary, disabled];
    expect(selectMatchingRules(rules, request)).toEqual([]);
    expect(evaluateLocalPolicy(rules, request).source).toBe("default");
    // A project rule belongs to its project id, never to a similar name.
    expect(evaluateLocalPolicy([otherProject], { ...request, projectId: "prj_2" }).decision)
      .toBe("deny");
    // A session with no project still sees its global and session rules only.
    expect(evaluateLocalPolicy([otherProject, otherSession], { ...request, projectId: null }).source)
      .toBe("default");
  });
});

describe("boundary availability", () => {
  it("refuses dispatch only for restrictions the session cannot enforce", () => {
    const codexDeny = rule({ boundary: "codex-command-approval", pattern: "*", decision: "deny" });
    const codexAsk = rule({ boundary: "codex-file-approval", pattern: "*", decision: "ask" });
    const codexAllow = rule({ boundary: "codex-dynamic-tool", pattern: "*", decision: "allow" });
    const apiDeny = rule({ boundary: "api-tool", pattern: "*", decision: "deny" });
    const refusals = unavailableBoundaryRefusals(
      [codexDeny, codexAsk, codexAllow, apiDeny],
      { sessionId: "ses_1", projectId: "prj_1" },
      ["api-tool"],
      "codex",
    );
    expect(refusals.map((r) => r.boundary))
      .toEqual(["codex-command-approval", "codex-file-approval"]);
    expect(refusals[0]?.message).toContain("codex-command-approval");
    expect(refusals[0]?.rule.id).toBe(codexDeny.id);
    // An unenforceable allow removes nothing, so it cannot refuse a session.
    expect(unavailableBoundaryRefusals(
      [codexAllow], { sessionId: "ses_1", projectId: "prj_1" }, [], "codex")).toEqual([]);
    // A Codex-only restriction is not an API target's problem: capability and
    // backend belong to the specific agent (ADR-0007).
    expect(unavailableBoundaryRefusals(
      [codexDeny, codexAsk], { sessionId: "ses_1", projectId: "prj_1" }, ["api-tool"], "api")).toEqual([]);
  });
});

describe("session grants are exact", () => {
  /** The registry matches on snapshot text, never on a live object. */
  const canonical = (input: unknown): string => {
    const snapshot = snapshotToolInput(input);
    if (!snapshot.ok) throw new Error(`test input is not bounded JSON: ${snapshot.reason}`);
    return snapshot.canonical;
  };
  const identity = (over: Partial<GrantIdentity> & { input?: unknown } = {}): GrantIdentity => {
    const { input, ...rest } = over;
    return {
      sessionId: "ses_1", agentId: "agt_1", backend: "api", boundary: "api-tool",
      toolName: "mcp__docs__search",
      inputCanonical: canonical(input ?? { query: "capybara", limit: 5 }),
      cwd: "C:/work/app", lifecycleToken: "tok_1", ...rest,
    };
  };

  it("matches the same input whatever order its keys were written in", () => {
    const registry = new SessionGrantRegistry();
    registry.grant(identity({ input: { query: "capybara", limit: 5 } }));
    expect(registry.has(identity({ input: { limit: 5, query: "capybara" } }))).toBe(true);
    expect(registry.has(identity({ input: { query: "capybara", limit: 5, extra: null } }))).toBe(false);
  });

  it("refuses a different value, array order, cwd, agent, tool or lifecycle", () => {
    const registry = new SessionGrantRegistry();
    registry.grant(identity({ input: { paths: ["a", "b"] } }));
    expect(registry.has(identity({ input: { paths: ["a", "b"] } }))).toBe(true);
    for (const other of [
      identity({ input: { paths: ["b", "a"] } }),
      identity({ input: { paths: ["a", "b", "c"] } }),
      identity({ input: { paths: ["a", "b"] }, cwd: "C:/work/other" }),
      identity({ input: { paths: ["a", "b"] }, agentId: "agt_2" }),
      identity({ input: { paths: ["a", "b"] }, agentId: null }),
      identity({ input: { paths: ["a", "b"] }, toolName: "mcp__docs__search2" }),
      identity({ input: { paths: ["a", "b"] }, lifecycleToken: "tok_2" }),
      identity({ input: { paths: ["a", "b"] }, sessionId: "ses_2" }),
      identity({ input: { paths: ["a", "b"] }, boundary: "claude-pre-tool", backend: "claude" }),
    ]) {
      expect(registry.has(other)).toBe(false);
    }
  });

  it("keeps a precomposed and a decomposed string apart", () => {
    const registry = new SessionGrantRegistry();
    registry.grant(identity({ input: { path: "caf\u00e9.txt" } }));
    expect(registry.has(identity({ input: { path: "cafe\u0301.txt" } }))).toBe(false);
    expect(registry.has(identity({ input: { path: "caf\u00e9.txt" } }))).toBe(true);
  });

  it("revokes by session and by lifecycle, and never leaks the token into the signature shape", () => {
    const registry = new SessionGrantRegistry();
    registry.grant(identity({ lifecycleToken: "tok_1" }));
    registry.grant(identity({ lifecycleToken: "tok_2" }));
    registry.grant(identity({ sessionId: "ses_2" }));
    expect(registry.size).toBe(3);
    expect(registry.revokeLifecycle("tok_2")).toBe(1);
    expect(registry.revokeSession("ses_1")).toBe(1);
    expect(registry.describe().map((r) => r.sessionId)).toEqual(["ses_2"]);
    // The signature is opaque text; nothing reads fields back out of it.
    expect(grantSignature(identity())).toBe(grantSignature(identity()));
    expect(grantSignature(identity())).not.toBe(grantSignature(identity({ cwd: "C:/other" })));
  });

  it("is idempotent for the same identity", () => {
    const registry = new SessionGrantRegistry(() => 100);
    const first = registry.grant(identity());
    const second = registry.grant(identity(), { now: () => 999 });
    expect(second).toBe(first);
    expect(registry.size).toBe(1);
  });
});

describe("input snapshots copy exactly what is there, or refuse", () => {
  it("retains an own __proto__ data field instead of eliding it into the prototype", () => {
    // JSON.parse makes `__proto__` an ordinary own data property. A snapshot
    // that assigns it back with `out[key] = …` hits the prototype setter and
    // loses the field, so two different requests share one identity.
    const source = JSON.parse('{"__proto__":{"flag":true},"visible":1}') as object;
    const result = snapshotToolInput(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.value as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.value as object)).toBeNull();
    expect(result.canonical).toContain('"__proto__"');

    const other = JSON.parse('{"__proto__":{"flag":false},"visible":1}') as object;
    const second = snapshotToolInput(other);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.canonical).not.toBe(result.canonical);
  });

  it("refuses an accessor without ever invoking it", () => {
    let accessed = false;
    const withGetter = Object.defineProperty({}, "value", {
      enumerable: true,
      get() { accessed = true; return "fixture"; },
    });
    const result = snapshotToolInput(withGetter);
    expect(result).toMatchObject({ ok: false, reason: "accessor" });
    expect(accessed).toBe(false);
  });

  it("refuses members a plain key walk would skip rather than eliding them", () => {
    const symbolKeyed = { visible: 1, [Symbol("hidden")]: 2 };
    expect(snapshotToolInput(symbolKeyed)).toMatchObject({ ok: false, reason: "hidden-member" });

    const nonEnumerable = Object.defineProperty({ visible: 1 }, "quiet", {
      value: 2, enumerable: false,
    });
    expect(snapshotToolInput(nonEnumerable)).toMatchObject({ ok: false, reason: "hidden-member" });

    const arrayWithExtras: unknown[] & { extra?: number } = ["a"];
    arrayWithExtras.extra = 1;
    expect(snapshotToolInput(arrayWithExtras)).toMatchObject({ ok: false, reason: "hidden-member" });
  });

  it("refuses an own array name that only looks like one of its indices", () => {
    // Number("01") === 1, and so do "1e0", "+1" and "-0": each is a *different*
    // own property from the index it coerces to, and the index walk never
    // visits it. Discarding them is elision, so only a canonical index counts.
    for (const alias of ["01", "1e0", "+1", "-0", "1.0", " 1"]) {
      const array: unknown[] = ["a", "b"];
      Object.defineProperty(array, alias, { value: 9, enumerable: true, configurable: true });
      expect(snapshotToolInput(array)).toMatchObject({ ok: false, reason: "hidden-member" });
    }
    expect(snapshotToolInput(["a", "b"])).toMatchObject({ ok: true });
  });

  it("refuses a non-enumerable array index, as it does for an object member", () => {
    const array: unknown[] = ["a", "b"];
    Object.defineProperty(array, "0", { value: "a", enumerable: false });
    expect(snapshotToolInput(array)).toMatchObject({ ok: false, reason: "hidden-member" });
  });

  it("charges keys and bytes while copying, before anything large is built", () => {
    // The budget is spent before the copy reaches the unrepresentable member at
    // the end; reporting `not-representable` would mean the whole value was
    // walked and materialized first.
    const heavy = ["x".repeat(64), "y".repeat(64), () => 1];
    expect(snapshotToolInput(heavy, { maxCanonicalBytes: 50 }))
      .toMatchObject({ ok: false, reason: "too-large" });
    // Keys count against the string bound like any other text.
    expect(snapshotToolInput({ ["k".repeat(20)]: 1 }, { maxStringLength: 10 }))
      .toMatchObject({ ok: false, reason: "string-too-long" });
  });

  it("cannot have its bounds removed by a malformed limit", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 100; i += 1) deep = { deep };
    for (const limits of [{ maxDepth: Number.NaN }, { maxDepth: Infinity }, { maxDepth: 0 },
      { maxDepth: -1 }, { maxDepth: undefined }]) {
      expect(snapshotToolInput(deep, limits)).toMatchObject({ ok: false, reason: "too-deep" });
    }
    expect(snapshotToolInput({ a: 1 }, { maxNodes: Number.NaN })).toMatchObject({ ok: true });
    expect(snapshotToolInput({ a: "z".repeat(2_000_000) }, { maxCanonicalBytes: Infinity }))
      .toMatchObject({ ok: false });
  });

  it("reports a structural path that never quotes the caller's own key text", () => {
    const result = snapshotToolInput({ outer: [{ "s3cret-key-name": undefined }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).not.toContain("s3cret-key-name");
    expect(result.path).not.toContain("outer");
    expect(result.path.length).toBeLessThanOrEqual(120);
  });
});
