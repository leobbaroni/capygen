import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Agent, Automation, AutomationRun, Project, Session } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
  const [dialog, setDialog] = useState<Automation | "new" | null>(null); const [openRunId, setOpenRunId] = useState<string | null>(null); const [pending, setPending] = useState(false);
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const [rows, ps, ss] = await Promise.all([
        ipc().invoke("automations.list", {}),
        ipc().invoke("projects.list", {}),
        ipc().invoke("sessions.list", { includeArchived: true }),
      ]);
      setItems(rows); setProjects(ps); setSessions(ss.filter((session) => session.origin !== "import")); setError("");
      const as = await Promise.all(ss.filter((session) => session.origin !== "import").map((s) => ipc().invoke("agents.list", { sessionId: s.id })));
      setAgents(as.flat());
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); const off = ipc().on("automations.changed", () => void load()); const runOff = ipc().on("automationRun.changed", (run) => { void load(); setRuns((current) => current[run.automationId] ? { ...current, [run.automationId]: [run, ...current[run.automationId]!.filter((row) => row.id !== run.id)].sort((a, b) => b.firedAt - a.firedAt) } : current); }); return () => { off(); runOff(); }; }, []);

  const visible = useMemo(() => items.filter((a) =>
    (filter === "all" || (filter === "active" ? a.enabled : !a.enabled)) &&
    a.name.toLowerCase().includes(search.trim().toLowerCase())), [items, filter, search]);
  async function mutate(action: () => Promise<unknown>) { setPending(true); try { await action(); setError(""); await load(); } catch (e) { setError(String(e)); } finally { setPending(false); } }
  async function showRuns(a: Automation) {
    try { const rows = await ipc().invoke("automations.listRuns", { id: a.id, limit: 50 }); setRuns((old) => ({ ...old, [a.id]: rows })); setOpenRunId(a.id); } catch (e) { setError(String(e)); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12" data-testid="automations-page"><div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Automations</h1><p className="mt-1 text-sm text-muted-foreground">Runs while capygen is open, including in the tray. Missed runs are skipped when you reopen the app.</p></div><Button disabled={loading} onClick={() => setDialog("new")}>New automation</Button></header>
    <div className="flex flex-wrap gap-3"><input aria-label="Search automations" placeholder="Search automations" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="flex gap-1">{(["all", "active", "paused"] as Filter[]).map((value) => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</Button>)}</div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading automations…</p> : visible.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">{items.length ? "No automations match your filters." : "No automations yet."}</p> : <div className="divide-y divide-border rounded-lg border border-border">{visible.map((a) => <article key={a.id} className="space-y-3 p-4"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><h2 className="font-medium">{a.name}</h2><p className="mt-1 break-words text-sm text-muted-foreground">{a.prompt}</p><p className="mt-1 text-xs text-muted-foreground">{a.enabled ? "Active" : "Paused"} · {a.timeZone} · {a.rrule}</p><p className="mt-1 text-xs text-muted-foreground">{a.nextRunAt ? `Next ${new Date(a.nextRunAt).toLocaleString()}` : "No next run"}{a.lastRunStatus ? ` · Last ${a.lastRunStatus}` : ""}</p></div><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" disabled={pending} onClick={() => void mutate(() => ipc().invoke("automations.update", { id: a.id, patch: { enabled: !a.enabled } }))}>{a.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => void mutate(() => ipc().invoke("automations.runNow", { id: a.id }))}>Run now</Button><Button size="sm" variant="ghost" onClick={() => setDialog(a)}>Edit</Button><Button size="sm" variant="destructive" disabled={pending} onClick={() => void mutate(() => ipc().invoke("automations.delete", { id: a.id }))}>Delete</Button></div></div><Button size="sm" variant="ghost" onClick={() => { if (runs[a.id] && openRunId === a.id) setOpenRunId(null); else void showRuns(a); }}>{runs[a.id] && openRunId === a.id ? "Hide run history" : "Run history"}</Button>{runs[a.id] && openRunId === a.id && <div className="space-y-1 border-t border-border pt-2 text-xs">{runs[a.id]?.length === 0 ? <p className="text-muted-foreground">No runs yet.</p> : runs[a.id]?.map((run) => <div className="flex flex-wrap items-center gap-2" key={run.id}><span>{run.status}</span><span className="text-muted-foreground">{new Date(run.firedAt).toLocaleString()}</span>{run.sessionId && <Link className="text-primary hover:underline" to={`/c/${run.sessionId}`}>Open session</Link>}{run.status === "running" && <Button size="sm" variant="outline" onClick={() => void mutate(() => ipc().invoke("automations.cancelRun", { runId: run.id }))}>Cancel</Button>}</div>)}</div>}</article>)}</div>}
    <AutomationDialog value={dialog} projects={projects} sessions={sessions} agents={agents} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} onError={setError} />
  </div></div>;
}

function AutomationDialog({ value, projects, sessions, agents, onClose, onSaved, onError }: { value: Automation | "new" | null; projects: Project[]; sessions: Session[]; agents: Agent[]; onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const [projectId, setProjectId] = useState(""); const [agentId, setAgentId] = useState(""); const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [rrule, setRrule] = useState<string>(presets.day); const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState(""); const initialized = useRef("");
  useEffect(() => { if (!value) { initialized.current = ""; return; } const key = value === "new" ? "new" : value.id; if (initialized.current === key) return; initialized.current = key; const a = value === "new" ? null : value; const project = a?.projectId || projects[0]?.id || ""; setProjectId(project); setAgentId(a?.agentId || agents.find((x) => sessions.some((s) => s.projectId === project && s.id === x.sessionId))?.id || ""); setName(a?.name || ""); setPrompt(a?.prompt || ""); setRrule(a?.rrule || presets.day); setAdvanced(Boolean(a && !Object.values(presets).includes(a.rrule as never))); }, [value, projects, agents, sessions]);
  if (!value) return null;
  const available = agents.filter((a) => sessions.some((s) => s.projectId === projectId && s.id === a.sessionId)); const editing = value !== "new" ? value : null;
  async function save() { setBusy(true); setDialogError(""); try { const payload = { projectId, agentId, name: name.trim(), prompt: prompt.trim(), rrule: rrule.trim(), timeZone: zone(), scheduleAnchorAt: minuteAnchor() }; if (editing === null) await ipc().invoke("automations.create", payload); else await ipc().invoke("automations.update", { id: editing.id, patch: { agentId, name: payload.name, prompt: payload.prompt, rrule: payload.rrule, timeZone: editing.timeZone, scheduleAnchorAt: editing.scheduleAnchorAt } }); onSaved(); } catch (e) { const message = String(e); setDialogError(message); onError(message); } finally { setBusy(false); } }
  return <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{value === "new" ? "New automation" : "Edit automation"}</DialogTitle></DialogHeader>{dialogError && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}<label className="block text-sm">Project<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" disabled={Boolean(editing)} value={projectId} onChange={(e) => { setProjectId(e.target.value); setAgentId(""); }}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="block text-sm">Agent<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{available.length === 0 && <option value="">No existing agent for this project</option>}{available.map((a) => { const source = sessions.find((s) => s.id === a.sessionId); return <option key={a.id} value={a.id}>{a.displayName} · {source?.title || "Source session"} ({a.backend})</option>; })}</select></label><label className="block text-sm">Name<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="block text-sm">Prompt<textarea className="mt-1 min-h-24 w-full rounded-md border border-border bg-background px-3 py-2" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label><label className="block text-sm">Recurrence<select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" value={advanced ? "advanced" : rrule} onChange={(e) => { const v = e.target.value; if (v === "advanced") setAdvanced(true); else { setAdvanced(false); setRrule(v); } }}>{Object.entries(presets).map(([key, v]) => <option key={key} value={v}>{key === "everyminute" ? "Every minute" : `Every ${key}`}</option>)}<option value="advanced">Advanced RRULE</option></select></label>{advanced && <input aria-label="Advanced RRULE" className="w-full rounded-md border border-border bg-background px-3 py-2" value={rrule} onChange={(e) => setRrule(e.target.value)} placeholder="FREQ=..." />}<DialogFooter><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !projectId || !agentId || !name.trim() || !prompt.trim() || !rrule.trim()} onClick={() => void save()}>Save</Button></DialogFooter></DialogContent></Dialog>;
}
