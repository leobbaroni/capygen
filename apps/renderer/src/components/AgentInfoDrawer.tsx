/**
 * Agent info drawer (SPEC R13, item B2.3): an agent's Claude-Code-style usage
 * description — description, capabilities, tools, model/backend, usage so
 * far, and the session's other agents — fetched via `agents.describe`.
 * `AgentsPane` pushes this into view in place of the tree (no separate
 * route/dialog for it, matching the reference's in-rail `AgentInfo` panel,
 * simplified to capygen's `AgentDescribe` shape rather than porting its
 * full MCP-server/policy-editing surface, which capygen does not have yet).
 *
 * It is also the one place a live agent's **sub-agent routing** rule (SPEC
 * R12) can be read and changed — see `RoutingSection` at the bottom of this
 * file for why that matters and for the one case where a rule cannot apply.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { AgentConfigSchema, type Agent, type AgentDescribe, type Backend } from "@capygen/shared";
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
            {agent.backend === "api" ? <ApiCapacitySection agent={agent} /> : null}
            <RoutingSection agent={agent} />
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

/**
 * The agent's own sub-agent routing rule (SPEC R12), editable here.
 *
 * The rule was previously write-once, in the Add-agent dialog: nothing in the
 * app read `agent.subagentRouting` back, so a session's lead — created by
 * `sessions.create` from the landing's harness picker, which never asks for one
 * — could never be given a routing rule at all, and a rule set at creation
 * could never be seen or changed.
 *
 * The runtime validates the selected target and supplies the stable delegation
 * tools at the host boundary for each backend. This panel therefore describes
 * the effective target without making a config-file-only claim.
 */
function RoutingSection({ agent }: { agent: Agent }) {
  const updateAgent = useAppStore((s) => s.updateAgent);
  const [backend, setBackend] = useState<Backend | "">(agent.subagentRouting?.backend ?? "");
  const [model, setModel] = useState(agent.subagentRouting?.model ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The row can be replaced under us (`agents.updated` after a save, or an
  // edit from another surface); the fields follow the row, not the mount.
  useEffect(() => {
    setBackend(agent.subagentRouting?.backend ?? "");
    setModel(agent.subagentRouting?.model ?? "");
    setSaveError(null);
  }, [agent.id, agent.subagentRouting?.backend, agent.subagentRouting?.model]);

  const dirty =
    backend !== (agent.subagentRouting?.backend ?? "") ||
    model.trim() !== (agent.subagentRouting?.model ?? "");

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      await updateAgent(agent.id, {
        subagentRouting: {
          ...(backend ? { backend } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
        },
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the routing rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Sub-agent routing">
      <div className="flex flex-col gap-1.5" data-testid="agent-info-routing">
        <div className="flex gap-1.5">
          <select
            aria-label="Sub-agent backend"
            data-testid="agent-info-routing-backend"
            value={backend}
            onChange={(e) => setBackend(e.target.value as Backend | "")}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none"
          >
            <option value="">Inherit ({BACKEND_LABEL[agent.backend]})</option>
            <option value="claude">
              {BACKEND_LABEL.claude}
            </option>
            <option value="codex">{BACKEND_LABEL.codex}</option>
            <option value="api">
              {BACKEND_LABEL.api}
            </option>
          </select>
          <input
            type="text"
            aria-label="Sub-agent model"
            data-testid="agent-info-routing-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model (optional)"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none"
          />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="agent-info-routing-effect">
          {backend || model.trim()
              ? `Sub-agents run on ${BACKEND_LABEL[(backend || agent.backend) as Backend]}${
                  model.trim() ? ` / ${model.trim()}` : ""
                }.`
              : "Sub-agents inherit this agent's own backend and model."}
        </p>
        {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="agent-info-routing-save"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save routing"}
        </Button>
      </div>
    </Section>
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
