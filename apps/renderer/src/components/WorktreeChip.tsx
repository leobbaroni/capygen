import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { Project, Worktree, WorktreeBranchChoice } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/lib/ipc";

export function WorktreeChip({ projectId, onSelect }: { projectId: string | null; onSelect: (project: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Worktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<WorktreeBranchChoice["mode"]>("new");
  const [name, setName] = useState("");
  const [base, setBase] = useState("HEAD");
  useEffect(() => {
    let alive = true;
    setItems([]); setError(null);
    if (projectId) void ipc().invoke("worktrees.list", { sourceProjectId: projectId })
      .then((next) => { if (alive) setItems(next); })
      .catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [projectId, open]);
  const selected = items.find((item) => item.projectId === projectId);
  const use = async (item: Worktree) => {
    if (!projectId) return;
    setBusy(true); setError(null);
    try {
      const result = await ipc().invoke("worktrees.register", { sourceProjectId: projectId, path: item.path });
      onSelect(result.project); setOpen(false);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (!projectId) return;
    setBusy(true); setError(null);
    try {
      const branch: WorktreeBranchChoice = mode === "new" ? { mode, name: name.trim(), base: base.trim() } : { mode, name: name.trim() };
      const result = await ipc().invoke("worktrees.create", { sourceProjectId: projectId, branch });
      if (result) { onSelect(result.project); setOpen(false); }
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (item: Worktree) => {
    if (!projectId) return;
    setBusy(true); setError(null);
    try {
      const result = await ipc().invoke("worktrees.remove", { sourceProjectId: projectId, path: item.path });
      if (result.ok) setItems(await ipc().invoke("worktrees.list", { sourceProjectId: projectId }));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const fieldClass = "min-w-0 rounded-md border border-border bg-background p-2";
  return <>
    <button type="button" data-testid="worktree-chip" disabled={!projectId} onClick={() => setOpen(true)} className="flex h-6 items-center gap-1 rounded-full px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
      <GitBranch className="ui-icon" /><span className="max-w-32 truncate">{selected ? selected.branch ?? "Detached HEAD" : "Worktrees"}</span>
    </button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent className="overflow-y-auto">
        <DialogHeader><DialogTitle>Choose a worktree</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">The next session will run in the selected directory.</p>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="space-y-2">{items.map((item) => <div key={item.path} className="rounded-md border border-border p-3 text-sm">
          <p>{item.branch ?? "Detached HEAD"}{item.kind === "main" ? " · Main directory" : ""}{item.projectId === projectId ? " · Selected" : ""}</p>
          <p className="break-all text-xs text-muted-foreground">{item.path}</p>
          {item.locked && <p>Locked{item.lockReason ? `: ${item.lockReason}` : ""}</p>}
          {item.prunable && <p>Unavailable{item.pruneReason ? `: ${item.pruneReason}` : ""}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || item.prunable} onClick={() => void use(item)}>Use {item.branch ?? "detached HEAD"}</Button>
            {item.kind === "linked" && <Button size="sm" variant="ghost" disabled={busy || item.locked || item.projectId === projectId} onClick={() => void remove(item)}>Remove</Button>}
          </div>
        </div>)}</div>
        <h3 className="text-sm font-medium">Create a worktree</h3>
        <label className="flex flex-col gap-1 text-sm">Branch choice<select aria-label="Branch choice" className={fieldClass} disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as WorktreeBranchChoice["mode"])}><option value="new">New branch</option><option value="existing">Existing branch</option></select></label>
        <label className="flex flex-col gap-1 text-sm">Branch name<input aria-label="Branch name" className={fieldClass} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="codex/my-change" /></label>
        {mode === "new" && <label className="flex flex-col gap-1 text-sm">Start from commit or branch<input aria-label="Start from commit or branch" className={fieldClass} disabled={busy} value={base} onChange={(event) => setBase(event.target.value)} /></label>}
        <p className="text-xs text-muted-foreground">Creation starts from committed history. Uncommitted changes stay in their original directory. You will choose the destination in the next dialog.</p>
        <DialogFooter><Button disabled={busy || !projectId || !name.trim() || (mode === "new" && !base.trim())} onClick={() => void create()}>Choose destination and create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
