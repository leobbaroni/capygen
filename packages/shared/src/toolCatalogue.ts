import "./zodRuntime.js";
import { z } from "zod";

/** Runtime metadata only. Exact identities survive or the response is refused. */
const name = z.string().min(1).max(512).regex(
  /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/,
);

export const AgentCatalogueServerSchema = z.object({
  name,
  state: z.enum(["connected", "failed", "needsAuth", "pending", "disabled",
    "notStarted", "cancelled", "unknown"]),
  tools: z.array(name).max(250),
  truncated: z.boolean(),
}).strict();

export const AgentToolCatalogueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), servers: z.array(AgentCatalogueServerSchema).max(100),
    truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal("unsupported") }).strict(),
  z.object({ kind: z.literal("notStarted") }).strict(),
  z.object({ kind: z.literal("error") }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("stale") }).strict(),
]).refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
  "The tool catalogue exceeds its metadata limit");

export type AgentToolCatalogue = z.infer<typeof AgentToolCatalogueSchema>;
export type AgentCatalogueServer = z.infer<typeof AgentCatalogueServerSchema>;
