import { describe, expect, it } from "vitest";
import {
  LOCAL_POLICY_INVOKE_CHANNELS,
  LocalPolicyAuditPageRequestSchema,
  LocalPolicyAuditRecordSchema,
  LocalPolicyEvaluationSchema,
  LocalPolicyGrantSummarySchema,
  LocalPolicyMemberCreateSchema,
  LocalPolicyMemberUpdateSchema,
  LocalPolicyRuleCreateSchema,
  LocalPolicySubjectAssignSchema,
  type LocalPolicyChannel,
} from "./localPolicyIpc.js";

const auditRecord = {
  id: "lpa_1", ts: 1, requestId: "req_1", sessionId: "ses_1", agentId: "agt_1",
  backend: "api", boundary: "api-tool", boundaryAvailable: true,
  toolName: "mcp__docs__search", decision: "deny", source: "rule",
  ruleId: "lpr_1", scopeKind: "global", scopeId: null,
  memberId: "mbr_1", memberLabel: "Owner", memberRole: "owner",
  executionSite: "backend",
};

const grant = {
  grantId: "grt_1", sessionId: "ses_1", agentId: "agt_1", backend: "api",
  boundary: "api-tool", toolName: "mcp__docs__search", grantedAt: 1,
};

describe("local policy management IPC contract", () => {
  it("declares an input and an output schema for every channel", () => {
    const names = Object.keys(LOCAL_POLICY_INVOKE_CHANNELS) as LocalPolicyChannel[];
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const name of names) {
      expect(name.startsWith("policy.")).toBe(true);
      const def = LOCAL_POLICY_INVOKE_CHANNELS[name];
      expect(typeof def.input.parse).toBe("function");
      expect(typeof def.output.parse).toBe("function");
    }
  });

  it("never accepts a renderer-supplied actor, member role or authority field", () => {
    for (const payload of [
      { label: "Reviewer", role: "viewer", actor: { memberId: "mbr_owner" } },
      { label: "Reviewer", role: "viewer", asMember: "mbr_owner" },
      { label: "Reviewer", role: "viewer", builtIn: true },
      { label: "Reviewer", role: "owner", verified: true },
    ]) {
      expect(LocalPolicyMemberCreateSchema.safeParse(payload).success).toBe(false);
    }
    expect(LocalPolicyMemberCreateSchema.safeParse({ label: "Reviewer", role: "viewer" }).success)
      .toBe(true);
    expect(LocalPolicyMemberUpdateSchema.safeParse({ memberId: "mbr_1", role: "editor" }).success)
      .toBe(true);
    expect(LocalPolicyMemberUpdateSchema.safeParse({ memberId: "mbr_1", builtIn: true }).success)
      .toBe(false);
  });

  it("keeps matching material out of the grant and audit payloads", () => {
    expect(LocalPolicyGrantSummarySchema.parse(grant)).toEqual(grant);
    expect(LocalPolicyAuditRecordSchema.parse(auditRecord)).toEqual(auditRecord);
    for (const leak of ["cwd", "input", "inputCanonical", "signature", "lifecycleToken",
      "arguments", "credential"]) {
      expect(LocalPolicyGrantSummarySchema.safeParse({ ...grant, [leak]: "x" }).success).toBe(false);
      expect(LocalPolicyAuditRecordSchema.safeParse({ ...auditRecord, [leak]: "x" }).success)
        .toBe(false);
    }
  });

  it("carries the execution site, separately from the origin backend", () => {
    // A widget call still *originates* from an agent on a backend and is still
    // checked at that backend's boundary; the site says which capygen surface
    // executed it. Both have to survive the DTO or a refusal loses its origin.
    const widget = { ...auditRecord, backend: "codex", boundary: "codex-dynamic-tool",
      executionSite: "widget-host" };
    const parsed = LocalPolicyAuditRecordSchema.parse(widget);
    expect(parsed).toEqual(widget);
    expect(parsed.backend).toBe("codex");
    expect(parsed.boundary).toBe("codex-dynamic-tool");
    // Required and closed: an absent or invented site is not a record.
    const { executionSite: _omitted, ...withoutSite } = auditRecord;
    expect(LocalPolicyAuditRecordSchema.safeParse(withoutSite).success).toBe(false);
    // `unknown` is a real site: a decision recorded for a request that never
    // matched a capture. Everything else is still refused.
    expect(
      LocalPolicyAuditRecordSchema.safeParse({ ...auditRecord, executionSite: "unknown" }).success,
    ).toBe(true);
    for (const bad of ["renderer", "host", "", null, 1]) {
      expect(LocalPolicyAuditRecordSchema.safeParse({ ...auditRecord, executionSite: bad }).success)
        .toBe(false);
    }
  });

  it("bounds paging and refuses an unbounded or malformed page request", () => {
    expect(LocalPolicyAuditPageRequestSchema.parse({})).toMatchObject({ limit: expect.any(Number) });
    for (const request of [{ limit: 0 }, { limit: 1000 }, { limit: 1.5 }, { limit: "20" },
      { cursor: "" }, { cursor: "c".repeat(300) }, { sessionId: "" }, { unexpected: true }]) {
      expect(LocalPolicyAuditPageRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(LocalPolicyAuditPageRequestSchema.safeParse({ sessionId: "ses_1", limit: 25 }).success)
      .toBe(true);
  });

  it("carries only the three decisions, with no permanent allow", () => {
    const evaluation = {
      decision: "ask", source: "rule", ruleId: "lpr_1", scopeKind: "session",
      scopeId: "ses_1", matchedRuleIds: ["lpr_1"], boundaryAvailable: true,
    };
    expect(LocalPolicyEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    for (const decision of ["allow_always", "always", "bypass", "allowAlways"]) {
      expect(LocalPolicyEvaluationSchema.safeParse({ ...evaluation, decision }).success).toBe(false);
    }
  });

  it("requires explicit scope identity on a rule and a session on an assignment", () => {
    const rule = {
      scope: { kind: "project", projectId: "prj_1" }, boundary: "api-tool",
      pattern: "mcp__docs__*", decision: "deny", enabled: true,
    };
    expect(LocalPolicyRuleCreateSchema.safeParse(rule).success).toBe(true);
    expect(LocalPolicyRuleCreateSchema.safeParse({ ...rule, scope: { kind: "project" } }).success)
      .toBe(false);
    expect(LocalPolicyRuleCreateSchema.safeParse({ ...rule, pattern: "tool(args)" }).success)
      .toBe(false);
    expect(LocalPolicySubjectAssignSchema.safeParse({ sessionId: "ses_1", memberId: "mbr_1" }).success)
      .toBe(true);
    for (const payload of [{ sessionId: "ses_1" }, { memberId: "mbr_1" },
      { sessionId: "", memberId: "mbr_1" }, { sessionId: "ses_1", memberId: "mbr_1", role: "owner" }]) {
      expect(LocalPolicySubjectAssignSchema.safeParse(payload).success).toBe(false);
    }
  });
});
