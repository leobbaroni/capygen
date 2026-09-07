import "./zodRuntime.js";
import { z } from "zod";

const id = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative();

export const InboxItemKindSchema = z.enum(["permission", "question", "elicitation", "finished", "error"]);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

const inboxItemFields = {
  id,
  sessionId: id,
  turnId: id,
  requestId: id.nullable(),
  kind: InboxItemKindSchema,
  title: z.string().max(200),
  body: z.string().max(8_192),
  dedupeKey: z.string().min(1).max(1_024),
  targetBlockId: id.nullable(),
  createdAt: timestamp,
  resolvedAt: timestamp.nullable(),
  readAt: timestamp.nullable(),
};

function validateDedupe(item: {
  kind: InboxItemKind; requestId: string | null; sessionId: string; turnId: string; dedupeKey: string;
}, context: z.RefinementCtx): void {
  const needsInput = item.kind === "permission" || item.kind === "question" || item.kind === "elicitation";
  const expected = needsInput
    ? item.requestId === null ? null : `${item.kind}:${item.sessionId}:${item.requestId}`
    : `${item.kind}:${item.turnId}`;
  if (expected === null) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "request items require requestId" });
  } else if (item.dedupeKey !== expected) {
    context.addIssue({ code: "custom", path: ["dedupeKey"], message: `dedupeKey must be ${expected}` });
  }
  if (!needsInput && item.requestId !== null) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "terminal items cannot carry requestId" });
  }
}

export const InboxItemSchema = z.object(inboxItemFields).strict().superRefine(validateDedupe);
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxItemDraftSchema = z.object(inboxItemFields).omit({
  id: true,
  resolvedAt: true,
  readAt: true,
}).strict().superRefine((item, context) => validateDedupe({
  kind: item.kind, requestId: item.requestId, sessionId: item.sessionId,
  turnId: item.turnId, dedupeKey: item.dedupeKey,
}, context));
export type InboxItemDraft = z.infer<typeof InboxItemDraftSchema>;
