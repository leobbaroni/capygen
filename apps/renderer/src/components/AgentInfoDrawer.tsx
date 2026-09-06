/**
 * Agent info drawer (SPEC R13, item B2.3): an agent's Claude-Code-style usage
 * description — description, capabilities, tools, model/backend, usage so
 * far, and the session's other agents — fetched via `agents.describe`.
 * `AgentsPane` pushes this into view in place of the tree (no separate
 * route/dialog for it, matching the reference's in-rail `AgentInfo` panel,
 * simplified to capygen's `AgentDescribe` shape rather than porting its
 * full MCP-server/policy-editing surface, which capygen does not have yet).
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { Agent, AgentDescribe } from "@capygen/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCostUsd, formatCount } from "@/components/blocks/blockFormat";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { useAppStore } from "@/store/appStore";

export function AgentInfoDrawer({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const describeAgent = useAppStore((s) => s.describeAgent);
  const [info, setInfo] = useState<AgentDescribe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    describeAgent(agent.id)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, describeAgent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-info-drawer">
      <div className="flex items-center gap-1.5 border-b border-border-weak px-2 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back to agents"
          data-testid="agent-info-back"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <AgentAvatar agent={agent} size={20} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{agent.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">@{agent.mentionName}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
          <Badge variant="outline">{BACKEND_LABEL[agent.backend]}</Badge>
          <Badge variant="outline">{agent.model}</Badge>
          {agent.role === "lead" ? <Badge variant="warning">Lead</Badge> : null}
        </div>

        {loading ? <p className="text-muted-foreground">Loading…</p> : null}
        {error ? (
          <p className="text-destructive" data-testid="agent-info-error">
            Could not load: {error}
          </p>
        ) : null}

        {info ? (
          <div className="flex flex-col gap-4">
            <Section title="Description">
              <p className="text-foreground">
                {info.description || agent.description || "No description yet."}
              </p>
            </Section>

            <Section title="Capabilities">
              {info.capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {info.capabilities.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">Not reported yet.</p>
              )}
            </Section>

            <Section title="Tools">
              {info.tools.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {info.tools.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">Not reported yet.</p>
              )}
            </Section>

            <Section title="Usage so far">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-foreground">
                <dt className="text-muted-foreground">Input</dt>
                <dd data-testid="agent-info-usage-input">{formatCount(info.usage.input)}</dd>
                <dt className="text-muted-foreground">Output</dt>
                <dd>{formatCount(info.usage.output)}</dd>
                <dt className="text-muted-foreground">Cached</dt>
                <dd>{formatCount(info.usage.cached)}</dd>
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="font-medium">{formatCostUsd(info.usage.costUsd)}</dd>
              </dl>
            </Section>

            <Section title="Other agents in this session">
              {info.others.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {info.others.map((other) => (
                    <li
                      key={other.agentId}
                      data-testid="agent-info-other"
                      className="flex items-center gap-1.5 rounded-md border border-border-weak px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate">@{other.mentionName}</span>
                      <Badge variant="outline">{BACKEND_LABEL[other.backend]}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No other agents in this session.</p>
              )}
            </Section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}
