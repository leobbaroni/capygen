import { z } from "zod";
export const ContextSnapshotSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  capacityTokens: z.number().int().positive().nullable(),
  source: z.enum(["last-request", "unknown"]),
  updatedAt: z.number().int().nonnegative().nullable(),
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export const AgentContextSnapshotSchema = ContextSnapshotSchema.extend({
  displayName: z.string().optional(), parentAgentId: z.string().optional(),
  agentId: z.string(), backend: z.enum(["claude", "codex", "api"]), model: z.string(),
});
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>;
export const UNKNOWN_CONTEXT: ContextSnapshot = { inputTokens: null, capacityTokens: null, source: "unknown", updatedAt: null };
