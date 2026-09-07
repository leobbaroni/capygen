import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Agent, Automation, AutomationRun, Project, Session } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";

type Filter = "all" | "active" | "paused";
const presets = {
  everyminute: "FREQ=MINUTELY;INTERVAL=1",
  hour: "FREQ=HOURLY;INTERVAL=1",
  day: "FREQ=DAILY;INTERVAL=1",
  week: "FREQ=WEEKLY;INTERVAL=1",
} as const;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const minuteAnchor = () => Math.floor(Date.now() / 60_000) * 60_000;

export function AutomationsPage() {
  const [items, setItems] = useState<Automation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Automation | "new" | null>(null);
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [rows, ps, ss] = await Promise.all([
        ipc().invoke("automations.list", {}),
        ipc().invoke("projects.list", {}),
        ipc().invoke("sessions.list", { includeArchived: false }),
      ]);
      setItems(rows); setProjects(ps); setSessions(ss); setError("");
      const as = await Promise.all(ss.map((s) => ipc().invoke("agents.list", { sessionId: s.id })));
      setAgents(as.flat());
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); const off = ipc().on("automations.changed", () => void load()); return off; }, []);

  const visible = useMemo(() => items.filter((a) =>
    (filter === "all" || (filter === "active" ? a.enabled : !a.enabled)) &&
    a.name.toLowerCase().includes(search.trim().toLowerCase())), [items, filter, search]);
  async function mutate(action: () => Promise<unknown>) { try { await action(); setError(""); await load(); } catch (e) { setError(String(e)); } }
  async function showRuns(a: Automation) {
    try { const rows = await ipc().invoke("automations.listRuns", { id: a.id, limit: 50 }); setRuns((old) => ({ ...old, [a.id]: rows })); } catch (e) { setError(String(e)); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12" data-testid="automations-page"><div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Automations</h1><p className="mt-1 text-sm text-muted-foreground">Run agent sessions on a recurring schedule.</p></div><Button onClick={() => setDialog("new")}>New automation</Button></header>
    <div className="flex flex-wrap gap-3"><input aria-label="Search automations" placeholder="Search automations" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="flex gap-1">{(["all", "active", "paused"] as Filter[]).map((value) => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</Button>)}</div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading automations…</p> : visible.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">{items.length ? "No automations match your filters." : "No automations yet."}</p> : <div className="divide-y divide-border rounded-lg border border-border">{visible.map((a) => <article key={a.id} className="space-y-3 p-4"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><h2 className="font-medium">{a.name}</h2><p className="mt-1 break-words text-sm text-muted-foreground">{a.prompt}</p><p className="mt-1 text-xs text-muted-foreground">{a.enabled ? "Active" : "Paused"} · {a.timeZone} · {a.rrule}</p></div><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => void mutate(() => ipc().invoke("automations.update", { id: a.id, patch: { enabled: !a.enabled } }))}>{a.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" onClick={() => void mutate(() => ipc().invoke("automations.runNow", { id: a.id }))}>Run now</Button><Button size="sm" variant="ghost" onClick={() => setDialog(a)}>Edit</Button><Button size="sm" variant="destructive" disabled={a.enabled} onClick={() => void mutate(() => ipc().invoke("automations.delete", { id: a.id }))}>Delete</Button></div></div><Button size="sm" variant="ghost" onClick={() => void showRuns(a)}>{runs[a.id] ? "Hide run history" : "Run history"}</Button>{runs[a.id] && <div className="space-y-1 border-t border-border pt-2 text-xs">{runs[a.id]?.length === 0 ? <p className="text-muted-foreground">No runs yet.</p> : runs[a.id]?.map((run) => <div className="flex flex-wrap items-center gap-2" key={run.id}><span>{run.status}</span><span className="text-muted-foreground">{new Date(run.firedAt).toLocaleString()}</span>{run.sessionId && <Link className="text-primary hover:underline" to={`/c/${run.sessionId}`}>Open session</Link>}{run.status === "running" && <Button size="sm" variant="outline" onClick={() => void mutate(() => ipc().invoke("automations.cancelRun", { runId: run.id }))}>Cancel</Button>}</div>)}</div>}</article>)}</div>}
    <AutomationDialog value={dialog} projects={projects} sessions={sessions} agents={agents} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} onError={setError} />
  </div></div>;
}

function AutomationDialog({ value, projects, sessions, agents, onClose, onSaved, onError }: { value: Automation | "new" | null; projects: Project[]; sessions: Session[]; agents: Agent[]; onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const [projectId, setProjectId] = useState(""); const [agentId, setAgentId] = useState(""); const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [rrule, setRrule] = useState<string>(presets.day); const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!value) return; const a = value === "new" ? null : value; const project = a?.projectId || projects[0]?.id || ""; setProjectId(project); setAgentId(a?.agentId || agents.find((x) => sessions.some((s) => s.projectId === project && s.id === x.sessionId))?.id || ""); setName(a?.name || ""); setPrompt(a?.prompt || ""); setRrule(a?.rrule || presets.day); setAdvanced(Boolean(a && !Object.values(presets).includes(a.rrule as never))); }, [value, projects, agents, sessions]);
  if (!value) return null;
  const available = agents.filter((a) => sessions.some((s) => s.projectId === projectId && s.id === a.sessionId)); const editing = value !== "new" ? value : null;
  async function save() { setBusy(true); try { const payload = { projectId, agentId, name: name.trim(), prompt: prompt.trim(), rrule: rrule.trim(), timeZone: zone(), scheduleAnchorAt: minuteAnchor() }; if (editing === null) await ipc().invoke("automations.create", payload); else await ipc().invoke("automations.update", { id: editing.id, patch: { agentId, name: payload.name, prompt: payload.prompt, rrule: payload.rrule, timeZone: payload.timeZone, scheduleAnchorAt: payload.scheduleAnchorAt } }); onSaved(); } catch (e) { onError(String(e)); } finally { setBusy(false); } }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-background p-5 shadow-lg"><h2 className="text-lg font-semibold">{value === "new" ? "New automation" : "Edit automation"}</h2><label className="block text-sm">Project<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(e) => { setProjectId(e.target.value); setAgentId(""); }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="block text-sm">Agent<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{available.map((a) => <option key={a.id} value={a.id}>{a.displayName} ({a.backend})</option>)}</select></label><label className="block text-sm">Name<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="block text-sm">Prompt<textarea className="mt-1 min-h-24 w-full rounded-md border border-border bg-background px-3 py-2" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label><label className="block text-sm">Recurrence<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={advanced ? "advanced" : rrule} onChange={(e) => { const v = e.target.value; if (v === "advanced") setAdvanced(true); else { setAdvanced(false); setRrule(v); } }}>{Object.entries(presets).map(([key, v]) => <option key={key} value={v}>{key === "everyminute" ? "Every minute" : `Every ${key}`}</option>)}<option value="advanced">Advanced RRULE</option></select></label>{advanced && <input aria-label="Advanced RRULE" className="w-full rounded-md border border-border bg-background px-3 py-2" value={rrule} onChange={(e) => setRrule(e.target.value)} placeholder="FREQ=..." />}<div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !projectId || !agentId || !name.trim() || !prompt.trim() || !rrule.trim()} onClick={() => void save()}>Save</Button></div></div></div>;
}
