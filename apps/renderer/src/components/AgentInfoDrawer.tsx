/**
 * Agent info drawer (SPEC R13, item B2.3): an agent's Claude-Code-style usage
 * description — description, capabilities, tools, model/backend, usage so
 * far, and the session's other agents — fetched via `agents.describe`.
 * `AgentsPane` pushes this into view in place of the tree (no separate
 * route/dialog for it, matching the reference's in-rail `AgentInfo` panel,
 * simplified to capygen's `AgentDescribe` shape rather than porting its
 * full MCP-server/policy-editing surface, which capygen does not have yet).
 *
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { AgentConfigSchema, type Agent, type AgentDescribe } from "@capygen/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCostUsd, formatCount } from "@/components/blocks/blockFormat";
import { BACKEND_LABEL, modelDisplayName, supportedEfforts, agentEffort, withAgentEffort } from "@/lib/agentDisplay";
import { useAppStore } from "@/store/appStore";

export function AgentInfoDrawer({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const harnesses = useAppStore((s) => s.harnesses);
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
          <Badge variant="outline">{modelDisplayName(harnesses, agent.backend, agent.model)}</Badge>
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
            {agent.backend === "api" ? <ApiCapacitySection agent={agent} /> : null}
            <EffortSection agent={agent} />
            {/* Two different things, both of which R13 asks for: the note the
                user wrote when they added this agent, and the usage
                description the backend's own facts produce. Folding them into
                one `||` hid whichever came second — a user who typed "Writes
                and reviews the prose." never saw it again once the harness
                started reporting. */}
            {agent.description ? (
              <Section title="Description">
                <p className="text-foreground" data-testid="agent-info-description">
                  {agent.description}
                </p>
              </Section>
            ) : null}

            {/* Until an agent has taken a turn there is no harness snapshot,
                so `describeCore`'s fallback returns the user's own note back
                as the usage description — and the drawer printed the same
                sentence twice under two headings. Show the second section
                only when it actually says something else. */}
            {agent.description && info.description.trim() === agent.description.trim() ? null : (
              <Section title={agent.description ? "What it can do" : "Description"}>
                <p className="text-foreground" data-testid="agent-info-usage-description">
                  {info.description || "Not reported yet."}
                </p>
              </Section>
            )}

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

function ApiCapacitySection({ agent }: { agent: Agent }) {
  const updateAgent = useAppStore((s) => s.updateAgent);
  const custom = useAppStore((s) => s.sessions.some((session) => session.id === agent.sessionId && session.mode === "custom"));
  const existing = (agent.config as { api?: { contextWindowTokens?: number } } | null)?.api?.contextWindowTokens;
  const [value, setValue] = useState(existing ? String(existing) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(existing ? String(existing) : ""); setError(null); }, [agent.id, existing]);
  async function save() {
    if (custom || saving) return;
    const trimmed = value.trim();
    const parsed = trimmed ? Number(trimmed) : undefined;
    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 10_000_000)) {
      setError("Enter an integer from 1024 to 10000000."); return;
    }
    setSaving(true); setError(null);
    try {
      const config = AgentConfigSchema.parse(agent.config ?? {});
      const api = { ...config.api };
      if (parsed === undefined) delete api.contextWindowTokens;
      else api.contextWindowTokens = parsed;
      await updateAgent(agent.id, { config: { ...config, api } });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Could not save API capacity."); }
    finally { setSaving(false); }
  }
  return <Section title="API context capacity">
    <div className="flex flex-col gap-1.5" data-testid="agent-info-api-capacity">
      <p className="text-xs text-muted-foreground">Enter the provider’s stated context window for this model to enable automatic summaries. Leave blank if unknown.</p>
      {custom ? <p className="text-xs text-muted-foreground">Edit this agent through Custom mode.</p> : null}
      <input aria-label="API context window tokens" data-testid="agent-info-api-capacity-input" value={value} disabled={custom || saving} onChange={(e) => setValue(e.target.value)} placeholder="1024–10000000" className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
      <Button variant="outline" size="sm" disabled={custom || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save capacity"}</Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  </Section>;
}

function EffortSection({ agent }: { agent: Agent }) {
  const harnesses = useAppStore((state) => state.harnesses);
  const updateAgent = useAppStore((state) => state.updateAgent);
  const custom = useAppStore((state) => state.sessions.some((session) => session.id === agent.sessionId && session.mode === "custom"));
  const existing = agentEffort(agent);
  const [effort, setEffort] = useState(existing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setEffort(existing); setError(""); }, [agent.id, existing]);
  const efforts = supportedEfforts(harnesses, agent.backend, agent.model);
  if (!efforts.length && !existing) return null;
  async function save() {
    if (custom || saving || effort && !efforts.includes(effort)) return;
    setSaving(true); setError("");
    try { await updateAgent(agent.id, { config: withAgentEffort(agent.config, agent.backend, effort) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  return <Section title="Model effort"><div className="space-y-2"><select aria-label="Agent effort" value={effort} disabled={custom || saving || !efforts.length} onChange={(event) => setEffort(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="">Backend default</option>{existing && !efforts.includes(existing) && <option value={existing} disabled>{existing} (not currently offered)</option>}{efforts.map((value) => <option key={value} value={value}>{value}</option>)}</select>{custom ? <p className="text-xs text-muted-foreground">Edit this agent’s effort through Custom mode.</p> : <Button size="sm" variant="outline" disabled={saving || effort === existing || !efforts.length} onClick={() => void save()}>{saving ? "Saving…" : "Save effort"}</Button>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div></Section>;
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
