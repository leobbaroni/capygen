import { useEffect, useState } from "react";
import type { AgentContextSnapshot, SessionMode } from "@capygen/shared";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";
import { modelDisplayName } from "@/lib/agentDisplay";

export function ContextMeter({ sessionId, mode }: { sessionId: string; mode: SessionMode }) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<AgentContextSnapshot[]>([]);
  const [error, setError] = useState("");
  const agents = useAppStore((state) => state.agents);
  const harnesses = useAppStore((state) => state.harnesses);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void ipc().invoke("agents.context", { sessionId }).then((result) => {
        if (alive && request === revision) { setRows(result); setError(""); }
      }).catch(() => { if (alive && request === revision) setError("Context information is unavailable."); });
    };
    setRows([]); refresh();
    const timer = expanded ? window.setInterval(refresh, 5000) : null;
    const off = ipc().on("chat.turnStatus", (event) => { if (event.sessionId === sessionId) refresh(); });
    const offAgents = ipc().on("agents.updated", (event) => { if (event.sessionId === sessionId) refresh(); });
    return () => { alive = false; off(); offAgents(); if (timer !== null) window.clearInterval(timer); };
  }, [sessionId, expanded]);
  return <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="mx-4 mb-1 shrink-0 rounded-md border border-border-weak px-2 py-1 text-xs" data-testid="context-meter">
    <summary className="cursor-pointer text-muted-foreground">Context · {rows.length === 1 && rows[0]?.inputTokens != null ? `${rows[0].inputTokens.toLocaleString()} input tokens` : "Per-agent windows"}</summary>
    <div className="max-h-48 space-y-2 overflow-y-auto py-2">
      <p className="text-muted-foreground">Latest request input, including cached tokens. Output and new messages need additional room. Unknown limits are not estimated.</p>
      {mode !== "solo" && <p className="text-muted-foreground">Each agent keeps its own context window. Round-table agents receive new shared conversation text; delegated workers receive their task prompt and return an answer. Windows are not pooled.</p>}
      {error && <p role="status">{error}</p>}
      {rows.map((row) => <div key={row.agentId} className="space-y-1">
        <div className="flex flex-wrap justify-between gap-2"><span>{row.displayName ?? agents.find((agent) => agent.id === row.agentId)?.displayName ?? row.backend} · {modelDisplayName(harnesses, row.backend, row.model)}</span><span>{row.inputTokens == null ? "No request data" : row.inputTokens.toLocaleString()} / {row.capacityTokens == null ? "limit unknown" : row.capacityTokens.toLocaleString()}</span></div>
        {row.inputTokens != null && row.capacityTokens != null && <progress aria-label={`${row.backend} context used`} className="h-1.5 w-full accent-primary" value={Math.min(row.inputTokens, row.capacityTokens)} max={row.capacityTokens} />}
      </div>)}
    </div>
  </details>;
}
