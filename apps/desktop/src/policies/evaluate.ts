/**
 * Pure local-policy evaluation (ADR-0007).
 *
 * Nothing here reads the database, calls a backend or performs I/O: it takes
 * the applicable rules and a request and returns a decision with its
 * attribution. That is what makes the precedence rules testable as rules rather
 * than as an integration.
 *
 * The three invariants this file exists to hold:
 *   * matching is bounded literal text with `*` wildcards — no regex, no
 *     argument matching, no path semantics;
 *   * across every applicable scope deny wins, then ask, then allow, so a
 *     narrower allow can never defeat a broader deny;
 *   * attribution among equal decisions is deterministic — most specific scope
 *     first, then stable rule id.
 */
import {
  policyBoundaryBackend,
  type Backend,
  type LocalPolicyDecision,
  type LocalPolicyRule,
  type LocalPolicyScope,
  type PolicyBoundary,
} from "@capygen/shared";

export interface PolicyRequest {
  sessionId: string;
  /** The session's project, for project-scoped rules. */
  projectId: string | null;
  agentId: string | null;
  boundary: PolicyBoundary;
  toolName: string;
}

export interface LocalPolicyOutcome {
  decision: LocalPolicyDecision;
  /** `default` means no local rule applied — not that anything was allowed. */
  source: "rule" | "default";
  /** The rule a refusal names and whose editor the UI links to. */
  rule: LocalPolicyRule | null;
  scopeKind: LocalPolicyScope["kind"] | null;
  scopeId: string | null;
  /** Every rule that matched, winning decision or not, for the explanation. */
  matched: LocalPolicyRule[];
}

/**
 * `*` matches any run of characters, including none. Everything else is a
 * literal byte comparison: no case folding and no Unicode normalization, for
 * the same reason grant signatures preserve string bytes — normalizing would
 * make two different tool names share one identity.
 *
 * Iterative with a backtrack point rather than a compiled regex: user text
 * never becomes an expression, and `****…` cannot become a pathological match.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < toolName.length) {
    if (p < pattern.length && (pattern[p] === toolName[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Session beats project beats global when two scopes reach the same decision. */
export function scopeSpecificity(scope: LocalPolicyScope): number {
  if (scope.kind === "session") return 3;
  if (scope.kind === "project") return 2;
  return 1;
}

export function ruleScopeId(rule: LocalPolicyRule): string | null {
  if (rule.scope.kind === "project") return rule.scope.projectId;
  if (rule.scope.kind === "session") return rule.scope.sessionId;
  return null;
}

/** True when `rule`'s scope covers this request. Ids only, never names. */
export function ruleAppliesToRequest(rule: LocalPolicyRule, request: PolicyRequest): boolean {
  if (rule.scope.kind === "global") return true;
  if (rule.scope.kind === "project") return rule.scope.projectId === request.projectId;
  return rule.scope.sessionId === request.sessionId;
}

/**
 * The rules that bear on one request: in scope, enabled, same boundary, and
 * matching the tool name. Boundary equality already implies backend equality —
 * backend is derived from the boundary, so the pair cannot disagree.
 */
export function selectMatchingRules(
  rules: readonly LocalPolicyRule[],
  request: PolicyRequest,
): LocalPolicyRule[] {
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.boundary === request.boundary &&
      ruleAppliesToRequest(rule, request) &&
      matchesToolPattern(rule.pattern, request.toolName),
  );
}

const PRECEDENCE: readonly LocalPolicyDecision[] = ["deny", "ask", "allow"];

/**
 * Evaluate every applicable scope at once.
 *
 * With no matching rule the outcome is `allow`/`default`, which means only
 * "capygen adds no local restriction here". It is never an unconditional native
 * allow: the caller still applies the backend's own rules, and ADR-0007 forbids
 * a local allow from being reported to a harness as one.
 */
export function evaluateLocalPolicy(
  rules: readonly LocalPolicyRule[],
  request: PolicyRequest,
): LocalPolicyOutcome {
  const matched = selectMatchingRules(rules, request);
  if (matched.length === 0) {
    return { decision: "allow", source: "default", rule: null, scopeKind: null, scopeId: null, matched };
  }
  const decision = PRECEDENCE.find((candidate) => matched.some((r) => r.decision === candidate));
  if (!decision) {
    // Unreachable while the decision enum has three members; treated as a
    // failure rather than a silent allow, because this is the fail-closed path.
    throw new Error("local policy evaluation produced no decision");
  }
  const rule = attribute(matched.filter((r) => r.decision === decision));
  return {
    decision,
    source: "rule",
    rule,
    scopeKind: rule.scope.kind,
    scopeId: ruleScopeId(rule),
    matched,
  };
}

/**
 * The exact rule set this outcome rests on.
 *
 * A pending approval is only valid while the rules that produced it are
 * unchanged. Comparing decisions is not enough: replacing one `ask` rule with a
 * different `ask` rule leaves the decision identical while the refusal text, the
 * rule the card linked to and the restriction the operator answered about have
 * all changed. The fingerprint therefore covers every matching rule's identity,
 * decision and `updatedAt`, plus which one was attributed.
 */
export function attributionFingerprint(outcome: LocalPolicyOutcome): string {
  const matched = outcome.matched
    .map((rule) => `${rule.id}:${rule.decision}:${rule.boundary}:${rule.pattern}:${rule.updatedAt}`)
    .sort()
    .join("|");
  return `${outcome.decision}/${outcome.source}/${outcome.rule?.id ?? "-"}/${matched}`;
}

/** Most specific scope, then the stable rule id — deterministic either way. */
function attribute(candidates: readonly LocalPolicyRule[]): LocalPolicyRule {
  return candidates.reduce((best, candidate) => {
    const specificity = scopeSpecificity(candidate.scope) - scopeSpecificity(best.scope);
    if (specificity !== 0) return specificity > 0 ? candidate : best;
    return candidate.id.localeCompare(best.id) < 0 ? candidate : best;
  });
}

export interface BoundaryRefusal {
  rule: LocalPolicyRule;
  boundary: PolicyBoundary;
  scopeKind: LocalPolicyScope["kind"];
  scopeId: string | null;
  message: string;
}

/**
 * Rules whose enforcement boundary this *target* cannot actually provide.
 *
 * ADR-0007: capability availability belongs to the specific agent and its
 * captured harness lifecycle, and dispatch checks the actual target backend. So
 * both filters are mandatory here, and neither may be widened:
 *
 *   * `targetBackend` — a Codex-only restriction says nothing about an
 *     API-only target, and must not refuse it;
 *   * `availableBoundaries` — the boundaries *this* agent's captured lifecycle
 *     supports. Another agent's capabilities are never unioned in; that is how
 *     an unenforceable restriction would end up silently authorized.
 *
 * Only restrictive rules qualify: an unenforceable `allow` removes nothing, so
 * it cannot make a target unsafe.
 */
export function unavailableBoundaryRefusals(
  rules: readonly LocalPolicyRule[],
  request: Pick<PolicyRequest, "sessionId" | "projectId">,
  availableBoundaries: readonly PolicyBoundary[],
  targetBackend: Backend,
): BoundaryRefusal[] {
  const available = new Set(availableBoundaries);
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.decision !== "allow" &&
        policyBoundaryBackend(rule.boundary) === targetBackend &&
        !available.has(rule.boundary) &&
        ruleAppliesToRequest(rule, { ...request, agentId: null, boundary: rule.boundary, toolName: "" }),
    )
    .map((rule) => ({
      rule,
      boundary: rule.boundary,
      scopeKind: rule.scope.kind,
      scopeId: ruleScopeId(rule),
      message:
        `This session cannot enforce the ${rule.boundary} boundary, which the ` +
        `${rule.scope.kind} restriction "${rule.pattern}" requires.`,
    }));
}
