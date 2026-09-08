/**
 * Start a fresh session from a received bundle (P15).
 *
 * A received bundle cannot be *resumed*. It carries no conversation id, no
 * configuration and no tool authority — by schema, not by convention — so the
 * only thing continuation can mean here is: create a **new** session, with an
 * agent chosen on this machine, and give it a bounded, inert quotation of what
 * was shared as context. The dialog says exactly that, because the alternative
 * reading ("carry on where they left off") is the one an operator would
 * otherwise assume.
 *
 * Modelled on `ImportedTranscript`'s own continuation dialog, which solved the
 * same problem for a native transcript; the harness/model choice, availability
 * gating and "creating the session does not send a model request" guarantee are
 * deliberately identical, so the two artifacts behave the same way.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiProvider, Backend } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

const selectClass =
  "rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring";

export function SharedContinueDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const selected = useAppStore((s) => s.selectedProjectId);
  const harnesses = useAppStore((s) => s.harnesses);
  const [projectId, setProjectId] = useState(selected ?? "");
  const [backend, setBackend] = useState<Backend | "">("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<ApiProvider | "">("");
  const [reference, setReference] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setReference(null);
    setError(null);
    void ipc()
      .invoke("sharing.reference", { sessionId })
      .then((result) => {
        if (alive) setReference(result);
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [open, sessionId]);

  const harness = harnesses.find((candidate) => candidate.backend === backend);
  const ready =
    !busy && projectId !== "" && model !== "" && reference !== null
    && harness?.available === true && (backend !== "api" || provider !== "");

  async function create(): Promise<void> {
    if (!ready || backend === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await ipc().invoke("sharing.continue", {
        sessionId,
        projectId,
        // A brand-new agent row on this machine. Nothing about the sender's
        // participants is reused — a bundle carries only their labels.
        agent: {
          name: "Assistant",
          backend,
          model,
          role: "lead",
          config: backend === "api" && provider ? { api: { provider } } : null,
        },
      });
      onOpenChange(false);
      navigate(`/c/${result.session.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Continue in a new session</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3" data-testid="shared-continue">
          <p className="text-sm text-muted-foreground">
            This starts a <span className="text-foreground">new</span> session on this machine with
            the harness and model you choose. The shared conversation is not resumed — it is quoted
            below as context, and nothing in it can configure a backend or run a tool. Creating the
            session does not send a model request.
          </p>

          <label className="flex flex-col gap-1 text-sm">
            Project
            <select
              aria-label="Project"
              className={selectClass}
              disabled={busy}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Harness
            <select
              aria-label="Harness"
              className={selectClass}
              disabled={busy}
              value={backend}
              onChange={(e) => {
                const next = e.target.value as Backend;
                setBackend(next);
                setModel(harnesses.find((c) => c.backend === next)?.defaultModel ?? "");
              }}
            >
              <option value="">Choose a harness</option>
              {harnesses.map((candidate) => (
                <option key={candidate.backend} value={candidate.backend} disabled={!candidate.available}>
                  {candidate.label}
                  {candidate.available ? "" : ` — ${candidate.reason || "Unavailable"}`}
                </option>
              ))}
            </select>
          </label>

          {backend === "api" ? (
            <label className="flex flex-col gap-1 text-sm">
              API provider
              <select
                aria-label="API provider"
                className={selectClass}
                disabled={busy}
                value={provider}
                onChange={(e) => setProvider(e.target.value as ApiProvider)}
              >
                <option value="">Choose a provider</option>
                {harness?.providers?.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          ) : null}

          <label className="flex flex-col gap-1 text-sm">
            Model
            <select
              aria-label="Model"
              className={selectClass}
              disabled={busy || backend === ""}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Choose a model</option>
              {harness?.models.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>

          {reference ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                Quoted context ({reference.truncated ? "shortened to fit" : "complete"}):
              </p>
              <pre
                data-testid="shared-continue-reference"
                className="max-h-48 overflow-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words"
              >
                {reference.text}
              </pre>
            </div>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">Preparing the quotation…</p>
          )}

          {error ? (
            <p role="alert" data-testid="shared-continue-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={!ready} data-testid="shared-continue-create" onClick={() => void create()}>
            Create new session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
