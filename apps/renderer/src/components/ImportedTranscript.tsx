import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiProvider, Backend, TranscriptImportEntry, TranscriptImportRecord } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

export function ImportedTranscript({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const selected = useAppStore((s) => s.selectedProjectId);
  const harnesses = useAppStore((s) => s.harnesses);
  const [record, setRecord] = useState<TranscriptImportRecord | null>(null);
  const [entries, setEntries] = useState<TranscriptImportEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(selected ?? "");
  const [backend, setBackend] = useState<Backend | "">("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<ApiProvider | "">("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true); setEntries([]); setError(null);
    void Promise.all([
      ipc().invoke("imports.get", { sessionId }),
      ipc().invoke("imports.entries", { sessionId, offset, limit: 50 }),
    ]).then(([metadata, page]) => {
      if (alive) { setRecord(metadata); setEntries(page); }
    }).catch((cause) => { if (alive) setError(String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, offset]);
  useEffect(() => {
    if (!continuing) return;
    let alive = true;
    setReference(null);
    void ipc().invoke("imports.reference", { sessionId }).then((result) => {
      if (alive) setReference(result.text);
    }).catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [continuing, sessionId]);
  const create = async () => {
    if (!backend || !model || !projectId || reference === null || (backend === "api" && !provider)) return;
    setBusy(true); setError(null);
    try {
      const result = await ipc().invoke("imports.continue", {
        sessionId, projectId,
        agent: { name: "Assistant", backend, model, role: "lead", config: backend === "api" && provider ? { api: { provider } } : null },
      });
      navigate(`/c/${result.session.id}`);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const harness = harnesses.find((candidate) => candidate.backend === backend);
  const selectClass = "min-w-0 rounded-md border border-border bg-background p-2";
  return <main data-testid="imported-transcript" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Imported snapshot · Read only</p>
        <h1 className="text-xl font-medium">{record?.title || "Imported transcript"}</h1>
        <p className="text-sm text-muted-foreground">Historical activities and messages are shown as text. Continue with a new harness and model in a separate session.</p>
        <Button disabled={!record} onClick={() => setContinuing(true)}>Continue in new session</Button>
      </header>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {record && <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="cursor-pointer">Source and provenance</summary>
        <dl className="mt-3 space-y-2 break-all">
          <dt>Backend</dt><dd>{record.backend}</dd><dt>Native session</dt><dd>{record.nativeId}</dd>
          <dt>Source file</dt><dd>{record.sourcePath}</dd><dt>SHA-256</dt><dd>{record.sourceSha256}</dd>
          <dt>Imported</dt><dd>{new Date(record.importedAt).toLocaleString()}</dd>
        </dl>
        {record.warnings.map((warning, index) => <p key={index} className="mt-2">{warning.message}</p>)}
      </details>}
      {loading ? <p role="status">Loading transcript…</p> : entries.map((entry) => <article key={entry.index} className="min-w-0 rounded-lg border border-border p-4">
        <p className="mb-2 text-xs text-muted-foreground">{entry.label} · {entry.kind}{entry.at ? ` · ${entry.at}` : ""}</p>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">{entry.text}</pre>
        {entry.truncated && <p className="mt-2 text-xs text-muted-foreground">This entry was truncated during import.</p>}
      </article>)}
      <nav aria-label="Transcript pages" className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
        <span className="text-sm">{record?.counts.entries ? `${offset + 1}–${Math.min(offset + 50, record.counts.entries)} of ${record.counts.entries}` : "No entries"}</span>
        <Button variant="outline" disabled={loading || !record || offset + 50 >= record.counts.entries} onClick={() => setOffset(offset + 50)}>Next</Button>
      </nav>
    </div>
    <Dialog open={continuing} onOpenChange={(open) => { if (!busy) setContinuing(open); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Continue in a new session</DialogTitle></DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <p className="text-sm text-muted-foreground">Choose the destination and current model. The quoted reference below will be included; creating the session does not send a model request.</p>
        <label className="flex flex-col gap-1 text-sm">Project<select aria-label="Project" className={selectClass} disabled={busy} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">Choose a project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-sm">Harness<select aria-label="Harness" className={selectClass} disabled={busy} value={backend} onChange={(e) => { const next = e.target.value as Backend; setBackend(next); setModel(harnesses.find((candidate) => candidate.backend === next)?.defaultModel ?? ""); }}><option value="">Choose a harness</option>{harnesses.map((candidate) => <option key={candidate.backend} value={candidate.backend} disabled={!candidate.available}>{candidate.label}{candidate.available ? "" : ` — ${candidate.reason || "Unavailable"}`}</option>)}</select></label>
        {backend === "api" && <label className="flex flex-col gap-1 text-sm">API provider<select aria-label="API provider" className={selectClass} disabled={busy} value={provider} onChange={(e) => setProvider(e.target.value as ApiProvider)}><option value="">Choose a provider</option>{harness?.providers?.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
        <label className="flex flex-col gap-1 text-sm">Model<select aria-label="Model" className={selectClass} disabled={busy || !backend} value={model} onChange={(e) => setModel(e.target.value)}><option value="">Choose a model</option>{harness?.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">{reference ?? "Loading reference…"}</pre>
        <DialogFooter><Button disabled={busy || !harness?.available || !projectId || !model || reference === null || (backend === "api" && !provider)} onClick={() => void create()}>Create new session</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </main>;
}
