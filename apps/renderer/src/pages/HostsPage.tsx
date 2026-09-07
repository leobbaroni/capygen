import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { Backend, HarnessInfo } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { hasBridge, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

const BACKENDS: Backend[] = ["claude", "codex", "api"];

export function HostsPage() {
  const harnesses = useAppStore((state) => state.harnesses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      if (!hasBridge()) throw new Error("The desktop bridge is unavailable.");
      useAppStore.setState({ harnesses: await ipc().invoke("harness.list", {}) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (harnesses.length === 0) void refresh(); }, [harnesses.length, refresh]);
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-12" data-testid="hosts-page"><div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Local machine</p><h1 className="mt-1 text-3xl font-normal tracking-[-0.03em]">Hosts</h1><p className="mt-1 max-w-xl text-sm text-muted-foreground">The harnesses available on this machine. capygen does not connect to remote hosts here.</p></div><Button variant="outline" onClick={() => void refresh()} disabled={busy} aria-label="Refresh host status">{busy ? <Loader2Icon className="ui-icon animate-spin" /> : <RefreshCwIcon className="ui-icon" />}{busy ? "Checking…" : "Refresh"}</Button></header>
    {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">Could not refresh host status: {error}</p> : null}
    <section aria-labelledby="host-list-heading" className="space-y-3"><h2 id="host-list-heading" className="text-sm font-medium">Harness status</h2><div className="divide-y divide-border rounded-lg border border-border bg-card">{BACKENDS.map((backend) => <HostRow key={backend} backend={backend} info={harnesses.find((candidate) => candidate.backend === backend)} />)}</div></section>
    <p className="text-sm text-muted-foreground">Need to sign in or configure a provider? Open <Link className="text-foreground underline underline-offset-2" to="/settings/harnesses">Harnesses</Link> or <Link className="text-foreground underline underline-offset-2" to="/settings/api-keys">Providers &amp; API keys</Link>.</p>
  </div></div>;
}

function HostRow({ backend, info }: { backend: Backend; info?: HarnessInfo }) {
  const label = backend === "claude" ? "Claude Code" : backend === "codex" ? "Codex" : "API models";
  const available = info?.available === true;
  return <article className="flex flex-wrap items-center gap-3 p-4" data-testid={`host-row-${backend}`}><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{info?.label ?? label}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{info ? <span data-testid={`host-model-count-${backend}`}>{info.models.length} {info.models.length === 1 ? "model" : "models"}</span> : "Not checked"}{info?.defaultModel ? ` · Default: ${info.defaultModel}` : ""}</p></div><div data-testid={`host-status-${backend}`} className={available ? "flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success" : "flex items-center gap-1 break-words rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning"}>{available ? <CheckCircle2Icon className="size-3" /> : <CircleAlertIcon className="size-3" />}{info ? (available ? "Available" : info.reason ?? "Unavailable") : "Not checked"}</div></article>;
}
