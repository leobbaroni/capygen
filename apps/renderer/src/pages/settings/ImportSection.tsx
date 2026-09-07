import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TranscriptImportPreview } from "@capygen/shared";
import { SectionIntro } from "@/components/settings/primitives";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

export function ImportSection() {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const selected = useAppStore((s) => s.selectedProjectId);
  const [projectId, setProjectId] = useState(selected ?? "");
  const [preview, setPreview] = useState<TranscriptImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (handle.current) void ipc().invoke("imports.cancel", { handle: handle.current }).catch(() => {});
    };
  }, []);
  const cancel = async () => {
    if (handle.current) await ipc().invoke("imports.cancel", { handle: handle.current });
    handle.current = null;
    setPreview(null);
  };
  const choose = async () => {
    setBusy(true); setError(null);
    try {
      await cancel();
      const next = await ipc().invoke("imports.pick", { projectId });
      if (!mounted.current) {
        if (next) await ipc().invoke("imports.cancel", { handle: next.handle });
        return;
      }
      handle.current = next?.handle ?? null;
      setPreview(next);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const result = await ipc().invoke("imports.commit", { handle: preview.handle });
      handle.current = null;
      if (mounted.current) navigate(`/c/${result.session.id}`);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div data-testid="settings-import" className="min-w-0 space-y-4">
    <SectionIntro title="Import sessions" description="Read a Claude Code or Codex transcript as a historical snapshot. Continue later in a new session." />
    <label className="flex flex-col gap-2 text-sm">Destination project
      <select aria-label="Destination project" className="min-w-0 rounded-md border border-border bg-background p-2" value={projectId} disabled={busy || Boolean(preview)} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Choose a project</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </label>
    <Button disabled={busy || !projectId} onClick={() => void choose()}>{busy ? "Working…" : "Choose transcript"}</Button>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {preview && <section aria-label="Import preview" className="space-y-3 rounded-lg border border-border p-4 text-sm">
      <h2 className="font-medium">{preview.title || "Untitled transcript"}</h2>
      <p className="break-all text-muted-foreground">{preview.backend} · {preview.sourcePath}</p>
      <p>{preview.counts.messages} messages · {preview.counts.thinking} thinking entries · {preview.counts.activities} activities</p>
      <p>Historical activities are displayed as text. Imported configuration and permissions do not become active.</p>
      {preview.changedSnapshot && <p>This transcript has changed since its earlier import. A separate snapshot will be created.</p>}
      {preview.existingSessionId && <p>This exact snapshot already exists. Import opens the saved copy.</p>}
      {preview.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5">{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void commit()}>{preview.existingSessionId ? "Open saved snapshot" : "Import snapshot"}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void cancel().catch((cause) => setError(String(cause)))}>Cancel</Button>
      </div>
    </section>}
  </div>;
}
