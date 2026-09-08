import { z } from "zod";
import { TerminalInfoSchema } from "./domain.js";

const RequestSchema = z.object({ requestId: z.string().min(1).max(128) }).strict();
export const LOCAL_INPUT_INVOKE_CHANNELS = {
  "dictation.availability": {
    input: z.object({}).strict(),
    output: z.object({ available: z.boolean(), languages: z.array(z.string().max(64)).max(64), message: z.string().max(1024).nullable(), setupAvailable: z.boolean().optional() }).strict(),
  },
  "dictation.setup": { input: z.object({}).strict(), output: z.object({ ok: z.boolean() }).strict() },
  "dictation.recognize": {
    input: RequestSchema.extend({ language: z.string().min(2).max(64) }).strict(),
    output: z.object({ text: z.string().max(16000), error: z.string().max(1024).nullable(), cancelled: z.boolean() }).strict(),
  },
  "dictation.cancel": { input: RequestSchema, output: z.object({ ok: z.boolean() }).strict() },
  "terminal.attach": {
    input: z.object({
      projectId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256).nullable().default(null),
      backend: z.enum(["claude", "codex"]), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000),
    }).strict(),
    output: TerminalInfoSchema,
  },
} as const;
