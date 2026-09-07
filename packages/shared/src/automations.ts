import "./zodRuntime.js";
import { z } from "zod";

const timestamp = z.number().int().nonnegative();
const id = z.string().min(1).max(256);

export const AutomationLastRunStatusSchema = z.enum([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
]);
export type AutomationLastRunStatus = z.infer<typeof AutomationLastRunStatusSchema>;

export const AutomationRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "interrupted",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunTriggerSchema = z.enum(["scheduled", "manual"]);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTriggerSchema>;

export const AutomationSchema = z.object({
  id,
  projectId: id,
  agentId: id.nullable(),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(65_536),
  rrule: z.string().min(1).max(4_096),
  timeZone: z.string().min(1).max(100),
  scheduleAnchorAt: timestamp,
  nextRunAt: timestamp.nullable(),
  lastRunAt: timestamp.nullable(),
  lastRunStatus: AutomationLastRunStatusSchema.nullable(),
  lastRunSessionId: id.nullable(),
  disabledReason: z.string().min(1).max(1_024).nullable(),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationDraftSchema = AutomationSchema.pick({
  projectId: true,
  name: true,
  prompt: true,
  rrule: true,
  timeZone: true,
  scheduleAnchorAt: true,
}).extend({ agentId: id }).strict();
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;

export const AutomationPatchSchema = AutomationSchema.pick({
  agentId: true,
  name: true,
  prompt: true,
  rrule: true,
  timeZone: true,
  scheduleAnchorAt: true,
  nextRunAt: true,
  enabled: true,
  disabledReason: true,
}).partial().strict();
export type AutomationPatch = z.infer<typeof AutomationPatchSchema>;

export const AutomationRunSchema = z.object({
  id,
  automationId: id,
  trigger: AutomationRunTriggerSchema,
  status: AutomationRunStatusSchema,
  scheduledAt: timestamp.nullable(),
  firedAt: timestamp,
  finishedAt: timestamp.nullable(),
  sessionId: id.nullable(),
  errorCode: z.string().min(1).max(256).nullable(),
}).strict();
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const AutomationLeaseSchema = z.object({
  automationId: id,
  runId: id,
  acquiredAt: timestamp,
}).strict();
export type AutomationLease = z.infer<typeof AutomationLeaseSchema>;
