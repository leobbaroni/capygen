import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Task, TaskStatus } from "@capygen/shared";
import { ipc } from "@/lib/ipc";

const statuses: TaskStatus[] = ["in_progress", "pending", "completed", "cancelled"];
const label = (status: string) => status.replaceAll("_", " ");

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      try {
        const rows = await ipc().invoke("tasks.list", {});
        if (alive && current === revision) { setTasks(rows); setError(""); }
      } catch (err) { if (alive) setError(String(err)); }
      finally { if (alive) setLoading(false); }
    };
    const off = ipc().on("tasks.updated", () => void load());
    void load();
    return () => { alive = false; off(); };
  }, []);
  const visible = tasks.filter((task) => (filter === "all" || task.status === filter) && task.title.toLowerCase().includes(search.toLowerCase()));
  async function update(task: Task, status: TaskStatus) {
    try {
      const updated = await ipc().invoke("tasks.update", { id: task.id, patch: { status } });
      setTasks((rows) => rows.map((row) => row.id === updated.id ? updated : row));
      setError("");
    } catch (err) { setError(String(err)); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12" data-testid="tasks-page">
    <div className="mx-auto max-w-4xl space-y-6">
      <header><h1 className="text-2xl font-semibold">Tasks</h1><p className="mt-1 text-sm text-muted-foreground">Agent todos and plans across your sessions.</p></header>
      <div className="flex flex-wrap gap-3">
        <input aria-label="Search tasks" placeholder="Search tasks" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label="Task status" className="rounded-md border border-border bg-background px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{label(status)}</option>)}</select>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : visible.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">{tasks.length ? "No tasks match your filters." : "Tasks will appear here when an agent creates a plan."}</p> :
        <div className="divide-y divide-border rounded-lg border border-border">{visible.sort((a, b) => b.updatedAt - a.updatedAt).map((task) => <article className="flex flex-wrap items-center gap-3 p-4" key={task.id}>
          <div className="min-w-0 flex-1"><p className={task.status === "completed" ? "break-words text-sm text-muted-foreground line-through" : "break-words text-sm font-medium"}>{task.title}</p><p className="mt-1 text-xs text-muted-foreground">{task.source === "todo_write" ? "Agent todo" : task.source === "codex_plan" ? "Agent plan" : "Manual task"}</p></div>
          <select aria-label={`Status for ${task.title}`} className="rounded border border-border bg-background p-1 text-xs" value={task.status} onChange={(event) => void update(task, event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status} value={status}>{label(status)}</option>)}</select>
          {task.sessionId && <Link className="rounded px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" to={`/c/${task.sessionId}`}>Open session</Link>}
        </article>)}</div>}
    </div>
  </div>;
}
