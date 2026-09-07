import "./zodRuntime.js";
import { z } from "zod";
import { ProjectSchema } from "./domain.js";

const absolutePath = z.string().min(1).max(32_768);
const optionalReason = z.string().max(4096).nullable();

export const WorktreeSchema = z.object({
  /** Canonical concrete execution directory reported by Git. */
  path: absolutePath,
  kind: z.enum(["main", "linked"]),
  /** Null only for an unborn worktree whose HEAD has no commit yet. */
  headCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
  /** Short local branch name; null for detached HEAD. */
  branch: z.string().min(1).max(1024).nullable(),
  detached: z.boolean(),
  locked: z.boolean(),
  lockReason: optionalReason,
  prunable: z.boolean(),
  pruneReason: optionalReason,
  /** Existing capygen project whose canonical path matches this directory. */
  projectId: z.string().min(1).nullable(),
}).strict().superRefine((value, context) => {
  if (value.detached !== (value.branch === null)) {
    context.addIssue({
      code: "custom",
      path: ["detached"],
      message: "Detached state and branch must agree",
    });
  }
  if (!value.locked && value.lockReason !== null) {
    context.addIssue({ code: "custom", path: ["lockReason"], message: "Unlocked worktree has a lock reason" });
  }
  if (!value.prunable && value.pruneReason !== null) {
    context.addIssue({ code: "custom", path: ["pruneReason"], message: "Non-prunable worktree has a prune reason" });
  }
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const WorktreeBranchChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), name: z.string().min(1).max(1024) }).strict(),
  z.object({
    mode: z.literal("new"),
    name: z.string().min(1).max(1024),
    base: z.string().min(1).max(1024),
  }).strict(),
]);
export type WorktreeBranchChoice = z.infer<typeof WorktreeBranchChoiceSchema>;

export const WorktreeCreateResultSchema = z.object({
  worktree: WorktreeSchema,
  project: ProjectSchema,
}).strict();
export type WorktreeCreateResult = z.infer<typeof WorktreeCreateResultSchema>;

export const WorktreeRemoveResultSchema = z.object({
  ok: z.boolean(),
  path: absolutePath,
}).strict();
export type WorktreeRemoveResult = z.infer<typeof WorktreeRemoveResultSchema>;
