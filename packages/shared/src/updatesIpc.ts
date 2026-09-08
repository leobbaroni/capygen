import { z } from "zod";
export const UpdateStatusSchema = z.object({
  phase: z.enum(["idle", "checking", "available", "downloading", "ready", "installing", "unavailable", "error"]),
  currentVersion: z.string().max(80), version: z.string().max(80).nullable(),
  progress: z.number().min(0).max(100), message: z.string().max(512),
  hasCredential: z.boolean(), portable: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
const empty = z.object({}).strict();
export const UPDATES_INVOKE_CHANNELS = {
  "updates.status": { input: empty, output: UpdateStatusSchema },
  "updates.check": { input: empty, output: UpdateStatusSchema },
  "updates.download": { input: empty, output: UpdateStatusSchema },
  "updates.cancel": { input: empty, output: z.object({ ok: z.boolean() }) },
  "updates.clear": { input: empty, output: UpdateStatusSchema },
  "updates.install": { input: empty, output: UpdateStatusSchema },
  "updates.savePortable": { input: empty, output: z.object({ ok: z.boolean() }) },
  "updates.setCredential": { input: z.object({ value: z.string().trim().min(1).max(4096).refine((value) => !/[\r\n]/.test(value)) }).strict(), output: UpdateStatusSchema },
  "updates.deleteCredential": { input: empty, output: UpdateStatusSchema },
} as const;
export const UPDATES_EVENT_CHANNELS = { "updates.changed": UpdateStatusSchema } as const;
