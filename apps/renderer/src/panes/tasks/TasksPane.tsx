/**
 * Tasks pane (SPEC R16): list grouped by status (pending / in progress /
 * completed, plus cancelled — a real `TaskStatus`, so it gets its own group
 * rather than silently vanishing), fed by `tasks.list` + `tasks.updated`;
 * agent badges; edit/complete via `tasks.update`. Visual language matches
 * `reference/omnigent/web/src/shell/TodoPanel.tsx` / `ChatPlanAccordion.tsx`
 * (status icon + strike-through on completion).
 *
 * Scoped to one session (`params.sessionId` — the Workspace host only opens
 * inside an open chat session, `WorkspaceHost.params`), not the whole
 * project: the cross-session view is the Tasks *page* (P10, Phase 8), a
 * different surface with its own IPC needs.
 *
 * Manual "add" is a known gap, not an oversight: `TasksRepo.create` exists
 * (`packages/db/src/repos.ts`), but no `tasks.create` IPC channel wires it up
 * yet — only `tasks.list`/`tasks.update` are in `@capygen/shared/ipc.ts`, and
 * `tasks.update` throws `unknown task: <id>` for an id that does not already
 * exist (it is a merge-patch, not an upsert). The input below stays disabled
 * with that explanation rather than pretending to work.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CircleDotIcon, CircleIcon, ListTodoIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import type { Agent, Task, TaskStatus } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

const GROUPS: { status: TaskStatus; label: string }[] = [
  { status: "in_progress", label: "In progress" },
  { status: "pending", label: "Pending" },
  { status: "completed", label: "Completed" },
  { status: "cancelled", label: "Cancelled" },
];

const STATUS_ICON: Record<TaskStatus, typeof CircleIcon> = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckCircle2Icon,
  cancelled: XCircleIcon,
};

const STATUS_ICON_CLASS: Record<TaskStatus, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-info",
  completed: "text-success",
  cancelled: "text-destructive",
};

/** Clicking the status icon cycles a task forward; cancelled is reachable
 *  only from the explicit "Cancel" action, never from the cycle, so it is
 *  never one accidental click away from every other state. */
function nextStatus(current: TaskStatus): TaskStatus {
  if (current === "pending") return "in_progress";
  if (current === "in_progress") return "completed";
  return "pending";
}

const SOURCE_LABEL: Record<Task["source"], string> = {
  todo_write: "todo",
  codex_plan: "plan",
  manual: "manual",
};

export function TasksPane({ params }: WorkspacePaneProps) {
  const { sessionId } = params;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agentsById, setAgentsById] = useState<Record<string, Agent>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addTitle, setAddTitle] = useState("");

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [list, agents] = await Promise.all([
        ipc().invoke("tasks.list", { sessionId }),
        ipc().invoke("agents.list", { sessionId }),
      ]);
      setTasks(list);
      setAgentsById(Object.fromEntries(agents.map((a) => [a.id, a])));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Whole-roster replace, same pattern `agents.updated` uses.
  useEffect(() => {
    return ipc().on("tasks.updated", (evt) => {
      if (evt.sessionId !== sessionId) return;
      setTasks(evt.tasks);
    });
  }, [sessionId]);

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const group of GROUPS) map.set(group.status, []);
    for (const task of tasks) {
      const bucket = map.get(task.status);
      if (bucket) bucket.push(task);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    return map;
  }, [tasks]);

  async function setStatus(task: Task, status: TaskStatus): Promise<void> {
    setBusyId(task.id);
    try {
      const updated = await ipc().invoke("tasks.update", { id: task.id, patch: { status } });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(task: Task): void {
    setEditingId(task.id);
    setEditingTitle(task.title);
  }

  async function commitEdit(task: Task): Promise<void> {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title || title === task.title) return;
    setBusyId(task.id);
    try {
      const updated = await ipc().invoke("tasks.update", { id: task.id, patch: { title } });
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-pane">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border-weak px-3">
        <ListTodoIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-foreground">
          Tasks{total > 0 ? ` (${completed}/${total})` : ""}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh tasks"
          title="Refresh"
          data-testid="tasks-refresh"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="tasks-error" className="shrink-0 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loading && total === 0 ? (
          <p data-testid="tasks-empty" className="px-2 py-3 text-sm text-muted-foreground">
            No tasks yet.
          </p>
        ) : (
          GROUPS.map((group) => {
            const items = grouped.get(group.status) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={group.status} data-testid={`tasks-group-${group.status}`} className="mb-3">
                <h3 className="mb-1 px-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label} ({items.length})
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {items.map((task) => {
                    const Icon = STATUS_ICON[task.status];
                    const agent = task.agentId ? agentsById[task.agentId] : undefined;
                    return (
                      <li
                        key={task.id}
                        data-testid="task-row"
                        data-task-id={task.id}
                        className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/40"
                      >
                        <button
                          type="button"
                          data-testid="task-status-toggle"
                          aria-label={`Mark "${task.title}" ${nextStatus(task.status).replace("_", " ")}`}
                          disabled={busyId === task.id}
                          onClick={() => void setStatus(task, nextStatus(task.status))}
                          className="mt-0.5 shrink-0 disabled:opacity-50"
                        >
                          <Icon className={cn("size-3.5", STATUS_ICON_CLASS[task.status])} />
                        </button>
                        <div className="min-w-0 flex-1">
                          {editingId === task.id ? (
                            <input
                              autoFocus
                              value={editingTitle}
                              data-testid="task-title-input"
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onBlur={() => void commitEdit(task)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="w-full rounded border border-input bg-transparent px-1 py-0.5 text-sm outline-none focus-visible:border-ring"
                            />
                          ) : (
                            <button
                              type="button"
                              data-testid="task-title"
                              onClick={() => startEdit(task)}
                              className={cn(
                                "block w-full truncate text-left text-sm text-foreground",
                                (task.status === "completed" || task.status === "cancelled") &&
                                  "text-muted-foreground line-through",
                              )}
                              title={task.title}
                            >
                              {task.title}
                            </button>
                          )}
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <Badge variant="outline">{SOURCE_LABEL[task.source]}</Badge>
                            {agent ? (
                              <Badge variant="outline" data-testid="task-agent-badge">
                                @{agent.mentionName}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        {task.status !== "cancelled" && task.status !== "completed" ? (
                          <button
                            type="button"
                            data-testid="task-cancel"
                            aria-label={`Cancel "${task.title}"`}
                            title="Cancel"
                            disabled={busyId === task.id}
                            onClick={() => void setStatus(task, "cancelled")}
                            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent/50 hover:text-destructive group-hover:opacity-100 disabled:opacity-50"
                          >
                            <XCircleIcon className="size-3.5" />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-border-weak p-2">
        <input
          value={addTitle}
          onChange={(e) => setAddTitle(e.target.value)}
          placeholder="Add a task…"
          disabled
          title="Manual task creation needs a tasks.create IPC channel, not yet in this build's contract (packages/shared/src/ipc.ts only has tasks.list/tasks.update)."
          data-testid="tasks-add-input"
          className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}

registerPane({ kind: "tasks", title: "Tasks", icon: ListTodoIcon, component: TasksPane });
