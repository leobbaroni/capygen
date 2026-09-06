/**
 * The Tasks pane (SPEC R16, P10): an agent's own plan, kept in the `tasks`
 * table so it survives a relaunch and so the Tasks *page* can span sessions.
 *
 * capygen does not ask an agent for its plan — that would cost tokens. It
 * *derives* one from blocks the agent already wrote:
 *
 *   - Claude's `TodoWrite` tool call, whose input is `{todos: [{content,
 *     status, activeForm}]}` → source `todo_write`;
 *   - Codex's plan tool (`update_plan`), whose input is `{plan: [{step,
 *     status}], explanation}` → source `codex_plan`;
 *   - a `subagent` block finishing, which *completes* a matching task rather
 *     than inventing one (see `applySubagent`).
 *
 * ### Why the list is replaced, not merged
 *
 * Both tools re-send the **whole** list on every call, and both may reorder or
 * drop items. So one derivation replaces everything that (session, agent,
 * source) triple owns: rows are upserted under a deterministic id built from
 * `session|agent|source|index`, and any row past the new length is deleted.
 * That is also why `tasks.updated` carries the whole roster — the same reason
 * `agents.updated` does.
 *
 * Manually added tasks (`source: "manual"`) are never touched by derivation.
 *
 * ### Known contract gap
 *
 * `TaskSourceSchema` has three values — `todo_write`, `codex_plan`, `manual` —
 * and none of them means "a sub-agent capygen spawned". Rather than file a
 * delegated sub-agent under a source that would misdescribe it, `applySubagent`
 * only *closes* an existing task whose title matches the sub-agent's
 * description. A dedicated `subagent` source is the fix; it belongs to the
 * shared contract, which this task does not own.
 */
import { createHash } from "node:crypto";
import type { CapygenStore } from "@capygen/db";
import {
  TaskSchema,
  type Block,
  type Task,
  type TaskPatch,
  type TaskSource,
  type TaskStatus,
} from "@capygen/shared";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** Tool names whose input is a whole todo list, lower-cased for matching.
 *  An MCP-hosted copy arrives as `mcp__<server>__TodoWrite`, so the test is a
 *  suffix match on the bare name. */
const TODO_TOOLS = ["todowrite", "todo_write"];
/** Codex's plan tool. */
const PLAN_TOOLS = ["update_plan", "updateplan", "plan"];

/** How many derived tasks one plan may contribute — a model that emits a
 *  thousand-item plan must not become a thousand SQLite rows (R23-R26). */
export const MAX_DERIVED_TASKS = 200;

export interface TasksServiceDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  now?: () => number;
}

export class TasksService {
  constructor(private readonly deps: TasksServiceDeps) {}

  list(args: { sessionId?: string; projectId?: string }): Task[] {
    return this.deps.store.tasks.list({
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });
  }

  update(args: { id: string; patch: TaskPatch }): Task {
    const task = this.deps.store.tasks.update(args.id, args.patch);
    if (task.sessionId) this.broadcastSession(task.sessionId);
    return task;
  }

  /**
   * Called for every persisted block (see `createWorkspaceIpc`'s broadcast
   * tap). Cheap by design: anything that is not a plan-shaped tool call or a
   * finished sub-agent returns on the first `if`.
   */
  observeBlock(block: Block): void {
    try {
      if (block.kind === "tool_call") this.applyToolCall(block);
      else if (block.kind === "subagent") this.applySubagent(block);
    } catch (err) {
      // A malformed plan must never fail the turn that produced it.
      this.deps.log.warn(`[tasks] derivation failed: ${(err as Error).message}`);
    }
  }

  private applyToolCall(block: Extract<Block, { kind: "tool_call" }>): void {
    const source = sourceForTool(block.name);
    if (!source) return;
    const items = source === "todo_write" ? readTodos(block.input) : readPlan(block.input);
    if (items === null) return;
    this.replace(block.sessionId, this.agentOf(block.turnId), source, items);
  }

  /** A block knows its turn, and the turn knows the agent — `blockBase` has no
   *  `agentId` of its own, so the plan's owner is looked up here rather than
   *  guessed from the session's lead (a round table has more than one). */
  private agentOf(turnId: string): string | null {
    return this.deps.store.turns.get(turnId)?.agentId ?? null;
  }

  /**
   * A sub-agent finishing closes the task it was doing, when the plan named
   * one. It never *creates* a task — see this file's header for why.
   */
  private applySubagent(block: Extract<Block, { kind: "subagent" }>): void {
    if (block.status !== "done" && block.status !== "error") return;
    const needle = (block.description || block.name).trim().toLowerCase();
    if (needle === "") return;
    const tasks = this.deps.store.tasks.listBySession(block.sessionId);
    const match = tasks.find(
      (task) => task.status !== "completed" && task.title.trim().toLowerCase() === needle,
    );
    if (!match) return;
    this.deps.store.tasks.update(match.id, {
      status: block.status === "done" ? "completed" : "cancelled",
    });
    this.broadcastSession(block.sessionId);
  }

  /**
   * Replace everything one (session, agent, source) triple owns with `items`.
   * Ids are deterministic so a re-send updates rows instead of duplicating
   * them, and rows past the new length are deleted so a shortened plan does
   * not leave orphans behind.
   */
  private replace(
    sessionId: string,
    agentId: string | null,
    source: TaskSource,
    items: { title: string; status: TaskStatus }[],
  ): void {
    const now = (this.deps.now ?? Date.now)();
    const capped = items.slice(0, MAX_DERIVED_TASKS);
    for (const [index, item] of capped.entries()) {
      const id = derivedTaskId(sessionId, agentId, source, index);
      const existing = this.deps.store.tasks.get(id);
      this.deps.store.tasks.upsert(
        TaskSchema.parse({
          id,
          sessionId,
          agentId,
          title: item.title,
          status: item.status,
          source,
          order: index,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }),
      );
    }
    // Trim what a previous, longer plan left behind. Bounded: it stops at the
    // first id that is not there any more.
    for (let index = capped.length; index < capped.length + MAX_DERIVED_TASKS; index += 1) {
      const id = derivedTaskId(sessionId, agentId, source, index);
      if (!this.deps.store.tasks.remove(id)) break;
    }
    this.broadcastSession(sessionId);
  }

  private broadcastSession(sessionId: string): void {
    this.deps.broadcast("tasks.updated", {
      sessionId,
      tasks: this.deps.store.tasks.listBySession(sessionId),
    });
  }
}

// ---------------------------------------------------------------------------
// derivation
// ---------------------------------------------------------------------------

/** `tsk_` + a hash of the triple and the index; stable across re-sends. */
export function derivedTaskId(
  sessionId: string,
  agentId: string | null,
  source: TaskSource,
  index: number,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}|${agentId ?? ""}|${source}|${index}`)
    .digest("hex");
  return `tsk_${digest.slice(0, 32)}`;
}

/** `TodoWrite` / `mcp__x__TodoWrite` → `todo_write`; `update_plan` →
 *  `codex_plan`; anything else → null. */
export function sourceForTool(name: string): TaskSource | null {
  const bare = (name.split("__").pop() ?? name).toLowerCase();
  if (TODO_TOOLS.includes(bare)) return "todo_write";
  if (PLAN_TOOLS.includes(bare)) return "codex_plan";
  return null;
}

/**
 * `{todos: [{content, status, activeForm}]}`. `activeForm` is preferred while
 * an item is in progress — it is the present-tense phrasing Claude Code shows
 * in its own spinner ("Running the tests") rather than the imperative title.
 */
export function readTodos(input: unknown): { title: string; status: TaskStatus }[] | null {
  if (!isRecord(input) || !Array.isArray(input.todos)) return null;
  const out: { title: string; status: TaskStatus }[] = [];
  for (const raw of input.todos) {
    if (!isRecord(raw)) continue;
    const status = normaliseStatus(raw.status);
    const active = typeof raw.activeForm === "string" ? raw.activeForm.trim() : "";
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const title = status === "in_progress" && active !== "" ? active : content || active;
    if (title === "") continue;
    out.push({ title, status });
  }
  return out;
}

/**
 * Codex's plan: `{plan: [{step, status}]}` (`TurnPlanStep` in the app-server
 * bindings, `docs/spikes/codex-app-server-schema/v0.153.4-ts/v2/TurnPlanStep.ts`
 * — statuses `pending` / `inProgress` / `completed`).
 */
export function readPlan(input: unknown): { title: string; status: TaskStatus }[] | null {
  if (!isRecord(input)) return null;
  const steps = Array.isArray(input.plan) ? input.plan : null;
  if (!steps) return null;
  const out: { title: string; status: TaskStatus }[] = [];
  for (const raw of steps) {
    if (typeof raw === "string") {
      const title = raw.trim();
      if (title !== "") out.push({ title, status: "pending" });
      continue;
    }
    if (!isRecord(raw)) continue;
    const title =
      typeof raw.step === "string"
        ? raw.step.trim()
        : typeof raw.content === "string"
          ? raw.content.trim()
          : "";
    if (title === "") continue;
    out.push({ title, status: normaliseStatus(raw.status) });
  }
  return out;
}

/** Both vocabularies at once: Claude's `in_progress`, Codex's `inProgress`,
 *  and the shared `pending` / `completed`. Anything unknown is `pending` —
 *  the safe reading of "the agent did not say it was done". */
export function normaliseStatus(value: unknown): TaskStatus {
  const text = typeof value === "string" ? value.toLowerCase().replace(/[\s_-]/g, "") : "";
  if (text === "inprogress" || text === "active" || text === "running") return "in_progress";
  if (text === "completed" || text === "complete" || text === "done") return "completed";
  if (text === "cancelled" || text === "canceled" || text === "skipped") return "cancelled";
  return "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
