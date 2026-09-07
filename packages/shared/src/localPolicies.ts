/** Local execution restrictions, separate from backend-owned configuration.
 * ADR-0007 defines precedence, capability checks and main-process authority.
 * These schemas describe records; validation alone does not enforce a policy.
 */
import "./zodRuntime.js";
import { z } from "zod";
import type { Backend } from "./domain.js";

const id = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(120).refine((value) => value.trim().length > 0,
  "A display label cannot be blank")
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value),
    "A display label cannot contain control characters");

export const LocalMemberRoleSchema = z.enum(["owner", "editor", "viewer"]);
export type LocalMemberRole = z.infer<typeof LocalMemberRoleSchema>;
export const LocalMemberDraftSchema = z.object({ label, role: LocalMemberRoleSchema }).strict();
export const LocalMemberSchema = LocalMemberDraftSchema.extend({
  id, builtIn: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
export type LocalMemberDraft = z.infer<typeof LocalMemberDraftSchema>;
export type LocalMember = z.infer<typeof LocalMemberSchema>;

export const LocalPolicyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("project"), projectId: id }).strict(),
  z.object({ kind: z.literal("session"), sessionId: id }).strict(),
]);
export type LocalPolicyScope = z.infer<typeof LocalPolicyScopeSchema>;

export const PolicyBoundarySchema = z.enum([
  "api-tool", "claude-pre-tool", "codex-dynamic-tool",
  "codex-command-approval", "codex-file-approval", "codex-permissions-approval",
]);
export type PolicyBoundary = z.infer<typeof PolicyBoundarySchema>;

/** Backend is derived, so a rule cannot name a contradictory backend/boundary. */
export function policyBoundaryBackend(boundary: PolicyBoundary): Backend {
  switch (boundary) {
    case "api-tool": return "api";
    case "claude-pre-tool": return "claude";
    case "codex-dynamic-tool":
    case "codex-command-approval":
    case "codex-file-approval":
    case "codex-permissions-approval": return "codex";
    default: {
      const unsupported: never = boundary;
      void unsupported;
      throw new Error("Unknown policy enforcement boundary");
    }
  }
}

/** Main resolves this from a captured runtime, never from the rule's enabled flag.
 * This is ephemeral UI information, not persisted native configuration authority.
 */
export const PolicyBoundaryAvailabilitySchema = z.object({
  boundary: PolicyBoundarySchema,
  available: z.boolean(),
  reason: z.enum(["unsupported-backend", "native-approval-disabled", "capability-unproven", "harness-unavailable"]).nullable(),
}).strict().refine((value) => value.available === (value.reason === null),
  "Unavailable boundaries require a reason");
export type PolicyBoundaryAvailability = z.infer<typeof PolicyBoundaryAvailabilitySchema>;

export const LocalPolicyDecisionSchema = z.enum(["allow", "deny", "ask"]);
export type LocalPolicyDecision = z.infer<typeof LocalPolicyDecisionSchema>;
/** Tool identifiers plus the sole wildcard, *. No regex/arguments/path syntax. */
export const LocalToolPatternSchema = z.string().min(1).max(256)
  .regex(/^[\p{L}\p{N}_.*:@/-]+$/u, "Use a tool name with optional * wildcards");
export const LocalPolicyRuleDraftSchema = z.object({
  scope: LocalPolicyScopeSchema,
  boundary: PolicyBoundarySchema,
  pattern: LocalToolPatternSchema,
  decision: LocalPolicyDecisionSchema,
  enabled: z.boolean(),
}).strict();
export const LocalPolicyRuleSchema = LocalPolicyRuleDraftSchema.extend({
  id, createdAt: timestamp, updatedAt: timestamp,
}).strict();
export type LocalPolicyRuleDraft = z.infer<typeof LocalPolicyRuleDraftSchema>;
export type LocalPolicyRule = z.infer<typeof LocalPolicyRuleSchema>;
