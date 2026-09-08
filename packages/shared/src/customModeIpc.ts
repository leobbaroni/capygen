import { z } from "zod";
import { CustomModeDocumentSchema, CrewTargetSchema } from "./customMode.js";
import { AgentSchema, SessionSchema, HarnessInfoSchema } from "./domain.js";

export const CUSTOM_MODE_INVOKE_CHANNELS = {
  "customMode.generate": {
    input: z.object({ requestId: z.string().min(1).max(128), sessionId: z.string().min(1).max(256),
      target: CrewTargetSchema, prompt: z.string().min(1).max(8192) }).strict(),
    output: z.object({ draft: z.string().max(65536), authoringSessionId: z.string(),
      issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).max(256) }),
  },
  "customMode.cancel": {
    input: z.object({ requestId: z.string().min(1).max(128) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  "customMode.capabilities": {
    input: z.object({}).strict(),
    output: z.array(HarnessInfoSchema),
  },
  "customMode.apply": {
    input: z.object({ sessionId: z.string().min(1).max(256), crew: CustomModeDocumentSchema }).strict(),
    output: z.object({ session: SessionSchema, agents: z.array(AgentSchema), restartError: z.string().nullable() }),
  },
} as const;
