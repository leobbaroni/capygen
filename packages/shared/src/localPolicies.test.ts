import { describe, expect, it } from "vitest";
import {
  LocalPolicyRuleDraftSchema, LocalMemberDraftSchema, LocalPolicyScopeSchema,
  policyBoundaryBackend,
  type PolicyBoundary,
} from "./localPolicies.js";

describe("local execution policy contracts", () => {
  const rule = { scope: { kind: "global" }, boundary: "api-tool", pattern: "mcp__docs__*", decision: "deny", enabled: true };
  it("accepts explicit supported boundaries without claiming universal interception", () => {
    expect(LocalPolicyRuleDraftSchema.parse(rule)).toEqual(rule);
    expect(policyBoundaryBackend("codex-dynamic-tool")).toBe("codex");
    expect(policyBoundaryBackend("claude-pre-tool")).toBe("claude");
    expect(policyBoundaryBackend("api-tool")).toBe("api");
    expect(() => policyBoundaryBackend("unknown-boundary" as PolicyBoundary)).toThrow();
    expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, boundary: "codex-any-tool" }).success).toBe(false);
    expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, backend: "claude" }).success).toBe(false);
  });
  it("requires the identity of every non-global scope and rejects ambiguous scope fields", () => {
    expect(LocalPolicyScopeSchema.safeParse({ kind: "project", projectId: "prj_one" }).success).toBe(true);
    expect(LocalPolicyScopeSchema.safeParse({ kind: "session", sessionId: "ses_one" }).success).toBe(true);
    for (const scope of [{ kind: "project" }, { kind: "session", sessionId: "" },
      { kind: "global", projectId: "prj_one" }, { kind: "project", projectId: "prj_one", sessionId: "ses_one" }]) {
      expect(LocalPolicyScopeSchema.safeParse(scope).success).toBe(false);
    }
  });
  it("bounds patterns and refuses unsupported matcher syntax or executable options", () => {
    for (const pattern of ["", "x".repeat(257), "tool\nname", "tool?", "[a-z]", "tool(args)", "tool\\name"]) {
      expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, pattern }).success).toBe(false);
    }
    expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, pattern: "*" }).success).toBe(true);
    expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, pattern: "mcp__@scope/pkg__tool" }).success).toBe(true);
    expect(LocalPolicyRuleDraftSchema.safeParse({ ...rule, input: { command: "*" } }).success).toBe(false);
  });
  it("models local execution profiles without accepting supplied authentication or authority fields", () => {
    expect(LocalMemberDraftSchema.safeParse({ label: "Reviewer", role: "viewer" }).success).toBe(true);
    for (const member of [{ label: "", role: "viewer" }, { label: "  ", role: "viewer" },
      { label: "Reviewer", role: "admin" }, { label: "Reviewer", role: "owner", verified: true },
      { label: "Reviewer", role: "editor", builtIn: true }]) {
      expect(LocalMemberDraftSchema.safeParse(member).success).toBe(false);
    }
    for (const label of ["Reviewer\nOwner", "Reviewer\u202e", "Reviewer\u2066", "Reviewer\u0085"]) {
      expect(LocalMemberDraftSchema.safeParse({ label, role: "viewer" }).success).toBe(false);
    }
  });
});
