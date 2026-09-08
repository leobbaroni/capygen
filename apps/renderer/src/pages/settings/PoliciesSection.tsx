/**
 * Settings ▸ Policies (P17, ADR-0007).
 *
 * capygen's **own** additional execution restrictions — not a copy of a
 * backend's native permission file, which stays authoritative for its own
 * rules (Settings ▸ Tools edits Claude's). Four things live here, in the order
 * an operator needs them:
 *
 *  - **Restrictions** — bounded literal patterns with `*`, one enforcement
 *    boundary each, allow/deny/ask, at global, project or session scope.
 *  - **Preview** — which restriction would decide a given tool call, answered
 *    by `policy.rules.preview`. The renderer has no matcher of its own: a
 *    preview that ran its own matching could disagree with the main process,
 *    and an operator would trust the wrong one.
 *  - **Grants** — the "allow for this session" authorizations currently held,
 *    revocable. They carry no tool input, no working directory and no
 *    connection identity, by construction (`LocalPolicyGrantSummary`).
 *  - **Activity** — a bounded window of decision metadata. No arguments, no
 *    output, no credentials; the record has nowhere to put them.
 *
 * Every enforcement boundary is per agent and per captured backend lifecycle,
 * so the preview names the agent it asked about and reports what that agent
 * cannot enforce — never a union across a session's agents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { InfoIcon } from "lucide-react";
import type {
  Agent,
  LocalPolicyDecision,
  LocalPolicyEvaluation,
  LocalPolicyRule,
  LocalPolicyScope,
  PolicyBoundary,
  PolicyBoundaryAvailability,
} from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  RowError,
  SectionError,
  SectionLoading,
  SettingInput,
  SettingSelect,
  SettingToggle,
  SettingsCard,
} from "@/components/settings/primitives";
import { PolicyRefusal, PolicyUnavailable } from "@/components/settings/PolicyStates";
import {
  policyErrorMessage,
  usePolicyQuery,
  withPolicyMessage,
} from "@/components/settings/useLocalPolicy";
import { useRowActions } from "@/components/settings/useIntegrations";
import { hasBridge, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

type Tab = "rules" | "preview" | "grants" | "activity";

/**
 * A rule id from the address bar, bounded before it is used for anything.
 *
 * The value is only ever compared against ids this page already loaded, so it
 * cannot select anything that is not a rule — but bounding it keeps an absurd
 * value out of a `data-testid`, an aria label and the address bar itself.
 */
export function boundedRuleId(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 256) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "rules", label: "Restrictions" },
  { id: "preview", label: "Preview" },
  { id: "grants", label: "Grants" },
  { id: "activity", label: "Activity" },
];

/** Each boundary is a place capygen can actually intercept — named, not implied. */
const BOUNDARY_LABEL: Record<PolicyBoundary, string> = {
  "api-tool": "API tool call",
  "claude-pre-tool": "Claude pre-tool hook",
  "codex-dynamic-tool": "Codex dynamic tool",
  "codex-command-approval": "Codex command approval",
  "codex-file-approval": "Codex file approval",
  "codex-permissions-approval": "Codex permissions approval",
};

const BOUNDARY_OPTIONS = (Object.keys(BOUNDARY_LABEL) as PolicyBoundary[]).map((value) => ({
  value,
  label: BOUNDARY_LABEL[value],
}));

const DECISION_OPTIONS: { value: LocalPolicyDecision; label: string }[] = [
  { value: "deny", label: "Deny" },
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
];

const DECISION_BADGE: Record<LocalPolicyDecision, "destructive" | "warning" | "success"> = {
  deny: "destructive",
  ask: "warning",
  allow: "success",
};

/**
 * Where a decided call actually ran.
 *
 * `unknown` is its own answer, not a synonym for `backend`. Historical rows
 * default to `backend`, which is what they were; `unknown` means the decision
 * matched no capture, so the site genuinely was not determined. Reporting that
 * as the backend would invent provenance the record does not hold. The origin
 * backend and boundary keep their own meaning and stay on the row as its title.
 */
const AUDIT_SITE_LABEL: Record<"backend" | "widget-host" | "unknown", string> = {
  backend: "backend",
  "widget-host": "widget host",
  unknown: "not recorded",
};

/** Why an agent cannot enforce a boundary — main's word, said plainly. */
const REASON_TEXT: Record<NonNullable<PolicyBoundaryAvailability["reason"]>, string> = {
  "unsupported-backend": "This agent's backend has no such interception point.",
  "native-approval-disabled": "The backend's own approvals are turned off, so nothing is asked.",
  "capability-unproven": "Coverage here has not been proved, so it is not claimed.",
  "harness-unavailable": "The backend is not running for this agent right now.",
};

export interface ScopeName {
  label: string;
  /** The project or session this scope names, or its raw id when unknown. */
  detail: string;
}

/**
 * A scope's own words.
 *
 * "Project" alone does not say *which* project, and two projects' rules read
 * identically in a list. The name is used when this window knows it, and the id
 * itself is the fallback — never nothing, since a rule filed against a project
 * this window has not loaded still has to be identifiable enough to fix.
 */
function useScopeName(): (scope: LocalPolicyScope) => ScopeName {
  const projects = useAppStore((s) => s.projects);
  const sessions = useAppStore((s) => s.sessions);
  return useCallback(
    (scope: LocalPolicyScope): ScopeName => {
      if (scope.kind === "project") {
        const project = projects.find((item) => item.id === scope.projectId);
        return { label: "Project", detail: project?.name ?? scope.projectId };
      }
      if (scope.kind === "session") {
        const session = sessions.find((item) => item.id === scope.sessionId);
        return { label: "Session", detail: session?.title || scope.sessionId };
      }
      return { label: "Global", detail: "every session" };
    },
    [projects, sessions],
  );
}

export function PoliciesSection() {
  const [tab, setTab] = useState<Tab>("rules");
  /** Set by the preview's "Edit this restriction" link (ADR-0007). */
  const [focusRuleId, setFocusRuleId] = useState<string | null>(null);
  /**
   * A rule named by whoever navigated here — a permission card, the Approve
   * page — as `?rule=<id>`.
   *
   * An **id**, looked up in the rules this page already read; never a selector,
   * a query or anything else that could reach into the DOM. A value that
   * matches no rule is shown as a refusal rather than silently ignored: the
   * restriction that raised the card may have been deleted in the meantime,
   * and "nothing happened" would leave the operator hunting for it.
   */
  const [params, setParams] = useSearchParams();
  const requestedRuleId = boundedRuleId(params.get("rule"));

  return (
    <div data-testid="settings-policies" className="flex flex-col gap-6">
      {/* No heading of our own: `SettingsPage` already renders the section's
          name as the page's `<h1>`. */}
      <AuthorityNote />

      <div className="flex gap-1 overflow-x-auto border-b border-border-weak" role="tablist" aria-label="Policies">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`policies-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`policies-panel-${entry.id}`}
            data-testid={`policies-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={`shrink-0 px-3 py-2 text-sm ${
              tab === entry.id
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`policies-panel-${tab}`} aria-labelledby={`policies-tab-${tab}`}>
        {tab === "rules" ? (
          <RulesPanel
            focusRuleId={focusRuleId ?? requestedRuleId}
            onFocusHandled={() => {
              setFocusRuleId(null);
              // Consume the parameter so a later reload does not silently
              // reopen an editor the operator already closed.
              if (params.has("rule")) {
                const next = new URLSearchParams(params);
                next.delete("rule");
                setParams(next, { replace: true });
              }
            }}
          />
        ) : null}
        {tab === "preview" ? (
          <PreviewPanel
            onEditRule={(ruleId) => {
              setFocusRuleId(ruleId);
              setTab("rules");
            }}
          />
        ) : null}
        {tab === "grants" ? <GrantsPanel /> : null}
        {tab === "activity" ? <ActivityPanel /> : null}
      </div>
    </div>
  );
}

function AuthorityNote() {
  return (
    <p
      data-testid="policies-authority-note"
      className="flex items-start gap-2.5 rounded-lg border border-border-weak bg-card/50 px-3.5 py-3 text-sm text-muted-foreground"
    >
      <InfoIcon className="size-4 shrink-0 translate-y-0.5" aria-hidden />
      <span>
        Each backend&apos;s own configuration stays authoritative for its native rules. A
        restriction here is capygen&apos;s additional check at one named enforcement point — it can
        refuse a call the backend would have allowed, and it can never authorize one the backend
        denies.
      </span>
    </p>
  );
}

// -- Restrictions -------------------------------------------------------------

function RulesPanel({
  focusRuleId,
  onFocusHandled,
}: {
  focusRuleId: string | null;
  onFocusHandled: () => void;
}) {
  const rules = usePolicyQuery(
    () => ipc().invoke("policy.rules.list", {}),
    [],
    { invalidateOn: ["rules"] },
  );
  const rows = useRowActions();
  const scopeName = useScopeName();
  const [editingId, setEditingId] = useState<string | null>(null);
  /** A rule someone navigated to that no longer exists. */
  const [missingRuleId, setMissingRuleId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const list = useMemo(() => rules.data?.rules ?? [], [rules.data]);

  // A preview refusal names its owning rule; arriving here should open that
  // rule's editor and put it in view, not merely switch tabs and leave the
  // operator to find it.
  useEffect(() => {
    if (focusRuleId === null) return;
    // Wait for the first read: "not in an empty list" is not "deleted".
    if (rules.data === null) return;
    if (list.some((rule) => rule.id === focusRuleId)) {
      setMissingRuleId(null);
      setEditingId(focusRuleId);
    } else {
      // The restriction that raised the card is gone. Say so where the operator
      // was sent, rather than opening nothing and looking broken.
      setMissingRuleId(focusRuleId);
      setEditingId(null);
    }
    onFocusHandled();
  }, [focusRuleId, list, rules.data, onFocusHandled]);

  useEffect(() => {
    if (editingId === null) return;
    // Guarded: bringing the editor into view is a convenience, and an
    // environment without `scrollIntoView` must not take the panel down with it.
    const node = editorRef.current;
    if (typeof node?.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [editingId]);

  async function patch(rule: LocalPolicyRule, next: Partial<{ decision: LocalPolicyDecision; enabled: boolean }>) {
    await ipc().invoke("policy.rules.update", { ruleId: rule.id, ...next });
    await rules.reload();
  }

  async function remove(rule: LocalPolicyRule) {
    await ipc().invoke("policy.rules.remove", { ruleId: rule.id });
    await rules.reload();
  }

  if (rules.unavailable) {
    return (
      <PolicyUnavailable
        what="Restrictions"
        busy={rules.loading}
        onRetry={() => void rules.reload()}
        testId="rules-unavailable"
      />
    );
  }
  if (rules.error) return <SectionError message={rules.error} />;
  if (rules.loading && rules.data === null) return <SectionLoading />;

  return (
    <div className="flex flex-col gap-4" data-testid="policies-rules">
      {missingRuleId !== null ? (
        <p
          role="status"
          data-testid="rule-missing"
          className="rounded-lg border border-border-weak bg-card/50 px-3.5 py-3 text-sm text-muted-foreground"
        >
          That restriction no longer exists — it was deleted after the request it
          refused. Nothing here needs changing for it.
        </p>
      ) : null}
      {list.length === 0 ? (
        <p data-testid="rules-empty" className="text-sm text-muted-foreground">
          No restrictions yet — capygen adds no rule of its own, and every tool call follows the
          backend&apos;s native permissions.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Local execution restrictions</caption>
            <thead>
              <tr className="border-b border-border-weak text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Pattern</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Scope</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Boundary</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Decision</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">On</th>
                <th scope="col" className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {list.map((rule) => {
                const scope = scopeName(rule.scope);
                return (
                <tr key={rule.id} data-testid={`rule-row-${rule.id}`} className="border-b border-border-weak last:border-b-0">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {rule.pattern}
                    {rows.errorFor(rule.id) ? (
                      <RowError message={rows.errorFor(rule.id) as string} testId={`rule-error-${rule.id}`} />
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col gap-0.5">
                      <Badge variant="outline" className="w-fit">{scope.label}</Badge>
                      <span
                        data-testid={`rule-scope-detail-${rule.id}`}
                        className="max-w-40 truncate text-xs text-muted-foreground"
                        title={scope.detail}
                      >
                        {scope.detail}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {BOUNDARY_LABEL[rule.boundary]}
                  </td>
                  <td className="py-2 pr-3">
                    <SettingSelect
                      value={rule.decision}
                      disabled={rows.busy(rule.id)}
                      onChange={(value) =>
                        void rows.run(
                          rule.id,
                          withPolicyMessage(() => patch(rule, { decision: value as LocalPolicyDecision })),
                        )
                      }
                      options={DECISION_OPTIONS}
                      data-testid={`rule-decision-${rule.id}`}
                      aria-label={`Decision for ${rule.pattern}`}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <SettingToggle
                      checked={rule.enabled}
                      disabled={rows.busy(rule.id)}
                      onChange={(enabled) =>
                        void rows.run(rule.id, withPolicyMessage(() => patch(rule, { enabled })))
                      }
                      data-testid={`rule-enabled-${rule.id}`}
                      aria-label={`${rule.pattern} enabled`}
                    />
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rows.busy(rule.id)}
                        data-testid={`rule-edit-${rule.id}`}
                        aria-label={`Edit restriction ${rule.pattern}`}
                        onClick={() => setEditingId(editingId === rule.id ? null : rule.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rows.busy(rule.id)}
                        data-testid={`rule-remove-${rule.id}`}
                        aria-label={`Delete restriction ${rule.pattern}`}
                        onClick={() => void rows.run(rule.id, withPolicyMessage(() => remove(rule)))}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editingId !== null ? (
        <div ref={editorRef}>
          <RuleForm
            key={editingId}
            rule={list.find((rule) => rule.id === editingId) ?? null}
            onDone={async () => {
              setEditingId(null);
              await rules.reload();
            }}
            onCancel={() => setEditingId(null)}
          />
        </div>
      ) : null}

      <RuleForm rule={null} onDone={() => rules.reload()} />
    </div>
  );
}

/**
 * One restriction's whole editable shape, used for both creating and editing.
 *
 * Editing exists because a rule's *identity* is what it restricts: the pattern,
 * the enforcement point and the scope. Offering only decision and enabled meant
 * a typo in a pattern could be deleted and re-typed but never corrected, and a
 * rule aimed at the wrong boundary had to be rebuilt.
 */
function RuleForm({
  rule,
  onDone,
  onCancel,
}: {
  rule: LocalPolicyRule | null;
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const editing = rule !== null;
  const rows = useRowActions();
  const projectId = useAppStore((s) => s.selectedProjectId);
  const projects = useAppStore((s) => s.projects);
  const allSessions = useAppStore((s) => s.sessions);
  const sessions = useMemo(() => allSessions.filter((item) => !item.archived), [allSessions]);

  const [kind, setKind] = useState<LocalPolicyScope["kind"]>(rule?.scope.kind ?? "global");
  const [sessionId, setSessionId] = useState(
    rule?.scope.kind === "session" ? rule.scope.sessionId : "",
  );
  const [boundary, setBoundary] = useState<PolicyBoundary>(rule?.boundary ?? "api-tool");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [decision, setDecision] = useState<LocalPolicyDecision>(rule?.decision ?? "deny");
  const trimmed = pattern.trim();
  const key = editing ? `edit:${rule.id}` : "create";

  // A scope names ids, so an id this window cannot supply is not offered: main
  // would refuse it, and an option that always fails is worse than no option.
  // A rule's *own* project stays selectable while editing even when the window
  // is on a different project, so opening the editor cannot silently move it.
  const ownProjectId = rule?.scope.kind === "project" ? rule.scope.projectId : null;
  const scopeProjectId = ownProjectId ?? projectId;
  const projectLabel =
    projects.find((item) => item.id === scopeProjectId)?.name ?? scopeProjectId ?? "";
  const scopeOptions = [
    { value: "global", label: "Global — every session" },
    ...(scopeProjectId === null ? [] : [{ value: "project", label: `Project — ${projectLabel}` }]),
    ...(sessions.length === 0 && sessionId === ""
      ? []
      : [{ value: "session", label: "Session — one session" }]),
  ];

  const scope: LocalPolicyScope | null =
    kind === "project"
      ? scopeProjectId === null
        ? null
        : { kind: "project", projectId: scopeProjectId }
      : kind === "session"
        ? sessionId === ""
          ? null
          : { kind: "session", sessionId }
        : { kind: "global" };

  const sessionOptions = [
    { value: "", label: "Select a session…" },
    ...sessions.map((item) => ({ value: item.id, label: item.title || "Untitled session" })),
    // A rule may name a session this list no longer carries (archived, or
    // created in another window). Keep it selectable by id rather than
    // silently rewriting the rule's scope on save.
    ...(sessionId !== "" && !sessions.some((item) => item.id === sessionId)
      ? [{ value: sessionId, label: sessionId }]
      : []),
  ];

  async function submit() {
    if (scope === null || trimmed === "") return;
    await rows.run(
      key,
      withPolicyMessage(async () => {
        if (rule) {
          await ipc().invoke("policy.rules.update", {
            ruleId: rule.id, scope, boundary, pattern: trimmed, decision,
          });
        } else {
          await ipc().invoke("policy.rules.create", {
            scope, boundary, pattern: trimmed, decision, enabled: true,
          });
          setPattern("");
        }
        await onDone();
      }),
    );
  }

  const t = (name: string) => (editing ? `rule-edit-${name}` : `rule-create-${name}`);

  return (
    <SettingsCard
      title={editing ? "Edit restriction" : "Add a restriction"}
      subtitle={editing ? rule.id : undefined}
      testId={editing ? `rule-editor-${rule.id}` : "rule-create"}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Scope</span>
            <SettingSelect
              value={kind}
              onChange={(value) => setKind(value as LocalPolicyScope["kind"])}
              options={scopeOptions}
              data-testid={t("scope")}
              aria-label="Restriction scope"
            />
          </label>
          {kind === "session" ? (
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Session</span>
              <SettingSelect
                value={sessionId}
                onChange={setSessionId}
                options={sessionOptions}
                data-testid={t("session")}
                aria-label="Session this restriction applies to"
              />
            </label>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Enforcement point</span>
            <SettingSelect
              value={boundary}
              onChange={(value) => setBoundary(value as PolicyBoundary)}
              options={BOUNDARY_OPTIONS}
              data-testid={t("boundary")}
              aria-label="Enforcement boundary"
            />
          </label>
          <label className="flex w-full flex-col gap-1 sm:w-32">
            <span className="text-xs text-muted-foreground">Decision</span>
            <SettingSelect
              value={decision}
              onChange={(value) => setDecision(value as LocalPolicyDecision)}
              options={DECISION_OPTIONS}
              data-testid={t("decision")}
              aria-label="Restriction decision"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Tool name pattern</span>
            <SettingInput
              value={pattern}
              onChange={setPattern}
              placeholder="mcp__docs__*"
              data-testid={t("pattern")}
              aria-label="Tool name pattern"
            />
          </label>
          <div className="flex gap-2">
            {onCancel ? (
              <Button size="sm" variant="outline" data-testid={t("cancel")} onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={trimmed === "" || scope === null || rows.busy(key)}
              data-testid={t("submit")}
              onClick={() => void submit()}
            >
              {editing ? "Save changes" : "Add restriction"}
            </Button>
          </div>
        </div>

        {editing ? null : (
          <p className="text-xs text-muted-foreground">
            A pattern is a tool name with <code className="font-mono">*</code> as the only wildcard —
            no regular expressions and no matching on a tool&apos;s arguments. Where several
            restrictions apply, deny wins, then ask, then allow.
          </p>
        )}
        {rows.errorFor(key) ? (
          <RowError message={rows.errorFor(key) as string} testId={t("error")} />
        ) : null}
      </div>
    </SettingsCard>
  );
}

// -- Preview ------------------------------------------------------------------

/**
 * Which restriction would decide one tool call, and what this agent can
 * actually enforce.
 *
 * Both answers come from main: `policy.rules.preview` runs the real evaluator,
 * and `policy.boundaries.availability` reports the captured lifecycle's own
 * boundaries. The agent is part of the question, never averaged away.
 *
 * A result belongs to the exact question it answered. Every control here can
 * change while a request is in flight, so the answer is stored with the query
 * it was asked for and rendered only while that is still the query on screen —
 * otherwise an answer about one session, agent, boundary or tool name is read
 * under another's label.
 */
function PreviewPanel({ onEditRule }: { onEditRule: (ruleId: string) => void }) {
  const allSessions = useAppStore((s) => s.sessions);
  const sessions = useMemo(() => allSessions.filter((item) => !item.archived), [allSessions]);
  const [sessionId, setSessionId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [boundary, setBoundary] = useState<PolicyBoundary>("api-tool");
  const [toolName, setToolName] = useState("");
  const [answer, setAnswer] = useState<{ query: string; evaluation: LocalPolicyEvaluation } | null>(null);
  const [refusal, setRefusal] = useState<{ query: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const selected = sessionId === "" ? null : sessionId;

  // The session's own agents, from the light list channel — `sessions.get`
  // would drag every turn and block across the bridge to read four fields.
  const agents = usePolicyQuery<Agent[]>(
    async () => (selected === null ? [] : await ipc().invoke("agents.list", { sessionId: selected })),
    [selected],
  );

  const agentList = agents.data ?? [];
  const effectiveAgentId = useMemo(() => {
    if (agentId !== "" && agentList.some((a) => a.id === agentId)) return agentId;
    return agentList[0]?.id ?? "";
  }, [agentId, agentList]);

  const availability = usePolicyQuery(
    async () =>
      selected === null || effectiveAgentId === ""
        ? null
        : await ipc().invoke("policy.boundaries.availability", {
            sessionId: selected,
            agentId: effectiveAgentId,
          }),
    [selected, effectiveAgentId],
    // A restarted harness or replaced connection changes what this agent can
    // enforce, and the answer on screen would otherwise stay stale.
    { invalidateOn: ["runtime"], sessionId: selected },
  );

  /** Everything the answer depends on. Change any of it and the answer is stale. */
  const query = `${selected ?? ""}|${effectiveAgentId}|${boundary}|${toolName.trim()}`;

  async function preview() {
    if (selected === null || toolName.trim() === "") return;
    const mine = (request.current += 1);
    const asked = query;
    setBusy(true);
    setAnswer(null);
    setRefusal(null);
    try {
      const evaluation = await ipc().invoke("policy.rules.preview", {
        sessionId: selected,
        agentId: effectiveAgentId === "" ? null : effectiveAgentId,
        boundary,
        toolName: toolName.trim(),
      });
      if (request.current !== mine) return;
      setAnswer({ query: asked, evaluation });
    } catch (error) {
      if (request.current !== mine) return;
      setRefusal({ query: asked, message: policyErrorMessage(error) });
    } finally {
      if (request.current === mine) setBusy(false);
    }
  }

  // A restriction changed anywhere — including in another window — and the
  // answer on screen was decided under the old set. Retire it rather than
  // leave an attribution that no longer holds; the operator can ask again.
  useEffect(() => {
    if (!hasBridge()) return;
    return ipc().on("policy.changed", (event) => {
      if (event.area !== "rules" && event.area !== "runtime") return;
      request.current += 1;
      setAnswer(null);
      setRefusal(null);
    });
  }, []);

  // Rendered only while it still answers the question on screen.
  const evaluation = answer?.query === query ? answer.evaluation : null;
  const refusalMessage = refusal?.query === query ? refusal.message : null;

  return (
    <div className="flex flex-col gap-4" data-testid="policies-preview">
      {sessions.length === 0 ? (
        <p data-testid="preview-empty" className="text-sm text-muted-foreground">
          No sessions yet — there is nothing to preview a decision against.
        </p>
      ) : (
        <>
          <SettingsCard title="Check a tool call" testId="preview-form">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Session</span>
                <SettingSelect
                  value={sessionId}
                  onChange={(value) => {
                    setSessionId(value);
                    setAgentId("");
                  }}
                  options={[
                    { value: "", label: "Select a session…" },
                    ...sessions.map((s) => ({ value: s.id, label: s.title || "Untitled session" })),
                  ]}
                  data-testid="preview-session"
                  aria-label="Session to preview against"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Agent</span>
                <SettingSelect
                  value={effectiveAgentId}
                  disabled={agentList.length === 0}
                  onChange={setAgentId}
                  options={
                    agentList.length === 0
                      ? [{ value: "", label: agents.loading ? "Loading…" : "No agents" }]
                      : agentList.map((a) => ({ value: a.id, label: a.displayName || a.name }))
                  }
                  data-testid="preview-agent"
                  aria-label="Agent to preview for"
                />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Enforcement point</span>
                <SettingSelect
                  value={boundary}
                  onChange={(value) => setBoundary(value as PolicyBoundary)}
                  options={BOUNDARY_OPTIONS}
                  data-testid="preview-boundary"
                  aria-label="Enforcement boundary to preview"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Tool name</span>
                <SettingInput
                  value={toolName}
                  onChange={setToolName}
                  placeholder="mcp__docs__search"
                  data-testid="preview-tool"
                  aria-label="Tool name to preview"
                />
              </label>
              <Button
                size="sm"
                disabled={selected === null || toolName.trim() === "" || busy}
                data-testid="preview-run"
                onClick={() => void preview()}
              >
                {busy ? "Checking…" : "Check"}
              </Button>
            </div>
            {refusalMessage ? <PolicyRefusal message={refusalMessage} testId="preview-refusal" /> : null}
          </SettingsCard>

          {evaluation ? (
            <SettingsCard title="Result" testId="preview-result">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={DECISION_BADGE[evaluation.decision]} data-testid="preview-decision">
                  {evaluation.decision}
                </Badge>
                {evaluation.source === "default" ? (
                  <span className="text-sm text-muted-foreground" data-testid="preview-source-default">
                    No restriction of capygen&apos;s applies — the backend&apos;s own permissions
                    decide this call.
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground" data-testid="preview-source-rule">
                    Decided by the {evaluation.scopeKind} restriction{" "}
                    <code className="font-mono text-xs text-foreground">{evaluation.ruleId}</code>
                    {evaluation.matchedRuleIds.length > 1
                      ? `, the strongest of ${evaluation.matchedRuleIds.length} that match.`
                      : "."}
                  </span>
                )}
              </div>
              {evaluation.ruleId !== null ? (
                // ADR-0007: an exception is made by editing the owning
                // restriction, so the result has to lead there.
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  data-testid="preview-edit-rule"
                  onClick={() => onEditRule(evaluation.ruleId as string)}
                >
                  Edit this restriction
                </Button>
              ) : null}
              {!evaluation.boundaryAvailable ? (
                <PolicyRefusal
                  testId="preview-boundary-unavailable"
                  message="This agent cannot enforce that point right now, so a restriction there would refuse the session rather than police the call."
                />
              ) : null}
            </SettingsCard>
          ) : null}

          <BoundaryAvailability query={availability} />
        </>
      )}
    </div>
  );
}

function BoundaryAvailability({
  query,
}: {
  query: ReturnType<typeof usePolicyQuery<{ backend: string; boundaries: PolicyBoundaryAvailability[] } | null>>;
}) {
  if (query.unavailable) {
    return (
      <PolicyUnavailable
        what="This agent's enforcement points"
        busy={query.loading}
        onRetry={() => void query.reload()}
        testId="availability-unavailable"
      />
    );
  }
  if (query.error) return <SectionError message={query.error} />;
  const report = query.data;
  if (!report) return null;

  return (
    <SettingsCard
      title="What this agent can enforce"
      subtitle="Capability belongs to one agent and its captured backend, never to the session as a whole."
      testId="preview-availability"
    >
      <ul className="flex flex-col gap-1.5">
        {report.boundaries.map((entry) => (
          <li
            key={entry.boundary}
            data-testid={`availability-${entry.boundary}`}
            className="flex flex-col gap-0.5 border-b border-border-weak pb-1.5 text-sm last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-2"
          >
            <Badge variant={entry.available ? "success" : "outline"} className="shrink-0">
              {entry.available ? "available" : "unavailable"}
            </Badge>
            <span className="text-foreground">{BOUNDARY_LABEL[entry.boundary]}</span>
            {entry.reason ? (
              <span className="text-xs text-muted-foreground">{REASON_TEXT[entry.reason]}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

// -- Grants -------------------------------------------------------------------

function GrantsPanel() {
  const grants = usePolicyQuery(
    () => ipc().invoke("policy.grants.list", {}),
    [],
    // Grants are revoked by policy edits, session shutdown and lifecycle
    // changes, none of which this window necessarily made.
    { invalidateOn: ["grants", "rules", "runtime"] },
  );
  const rows = useRowActions();

  async function revoke(grantId: string) {
    await ipc().invoke("policy.grants.revoke", { grantId });
    await grants.reload();
  }

  if (grants.unavailable) {
    return (
      <PolicyUnavailable
        what="Session grants"
        busy={grants.loading}
        onRetry={() => void grants.reload()}
        testId="grants-unavailable"
      />
    );
  }
  if (grants.error) return <SectionError message={grants.error} />;
  if (grants.loading && grants.data === null) return <SectionLoading />;

  const list = grants.data?.grants ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="policies-grants">
      <p className="text-sm text-muted-foreground">
        &ldquo;Allow for this session&rdquo; authorizes one exact request — one tool, one input, one
        agent, one backend run. Grants are held only while the app is running, and none of them
        outlives a restart. To allow a tool permanently, add an allow restriction instead.
      </p>

      {list.length === 0 ? (
        <p data-testid="grants-empty" className="text-sm text-muted-foreground">
          No session grants are held.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Session grants currently held</caption>
            <thead>
              <tr className="border-b border-border-weak text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Tool</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Backend</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Enforcement point</th>
                <th scope="col" className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {list.map((grant) => (
                <tr
                  key={grant.grantId}
                  data-testid={`grant-row-${grant.grantId}`}
                  className="border-b border-border-weak last:border-b-0"
                >
                  <td className="py-2 pr-3 font-mono text-xs">
                    {grant.toolName}
                    {rows.errorFor(grant.grantId) ? (
                      <RowError
                        message={rows.errorFor(grant.grantId) as string}
                        testId={`grant-error-${grant.grantId}`}
                      />
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline">{grant.backend}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {BOUNDARY_LABEL[grant.boundary]}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rows.busy(grant.grantId)}
                      data-testid={`grant-revoke-${grant.grantId}`}
                      aria-label={`Revoke the grant for ${grant.toolName}`}
                      onClick={() =>
                        void rows.run(grant.grantId, withPolicyMessage(() => revoke(grant.grantId)))
                      }
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        A grant matches one exact request, but what it matches on — the tool&apos;s input, its
        working directory and the backend connection it was given for — is deliberately not shown
        or stored here.
      </p>
    </div>
  );
}

// -- Activity -----------------------------------------------------------------

/**
 * A bounded window over decision metadata.
 *
 * Paging is forward-only by cursor, because that is what the channel offers:
 * the window is an operator aid rather than an archive, and a cursor that has
 * aged out of it is refused rather than silently restarted at the top.
 */
function ActivityPanel() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);

  const page = usePolicyQuery(
    () => ipc().invoke("policy.audit.list", { limit: 25, ...(cursor === null ? {} : { cursor }) }),
    [cursor],
    { invalidateOn: ["rules", "grants", "subjects"] },
  );

  if (page.unavailable) {
    return (
      <PolicyUnavailable
        what="Recent decisions"
        busy={page.loading}
        onRetry={() => void page.reload()}
        testId="audit-unavailable"
      />
    );
  }
  if (page.error) return <SectionError message={page.error} />;
  if (page.loading && page.data === null) return <SectionLoading />;

  const records = page.data?.records ?? [];
  const nextCursor = page.data?.nextCursor ?? null;

  return (
    <div className="flex flex-col gap-3" data-testid="policies-activity">
      <p className="text-sm text-muted-foreground">
        What was decided, and by which restriction. Tool arguments, output and credentials are never
        recorded — the record has no field for them.
      </p>

      {records.length === 0 ? (
        <p data-testid="audit-empty" className="text-sm text-muted-foreground">
          Nothing decided yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Recent policy decisions</caption>
            <thead>
              <tr className="border-b border-border-weak text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Tool</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Decision</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">From</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Ran in</th>
                <th scope="col" className="py-1.5 font-medium">Profile</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr
                  key={record.id}
                  data-testid={`audit-row-${record.id}`}
                  className="border-b border-border-weak last:border-b-0"
                >
                  <td className="py-2 pr-3 font-mono text-xs">{record.toolName}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={DECISION_BADGE[record.decision]}>{record.decision}</Badge>
                  </td>
                  {/* Where the call ran is a different question from which
                      boundary covered it: the backend and boundary columns
                      still name the origin agent and protocol, and this says
                      whether the app's own widget host executed it. */}
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    <span title={`${record.backend} · ${record.boundary}`}>
                      {AUDIT_SITE_LABEL[record.executionSite]}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {record.memberLabel ?? "—"}
                    {record.memberRole ? ` (${record.memberRole})` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={trail.length === 0 || page.loading}
          data-testid="audit-prev"
          onClick={() => {
            const previous = trail[trail.length - 1] ?? null;
            setTrail((t) => t.slice(0, -1));
            setCursor(trail.length === 1 ? null : previous);
          }}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={nextCursor === null || page.loading}
          data-testid="audit-next"
          onClick={() => {
            if (nextCursor === null) return;
            setTrail((t) => [...t, cursor ?? ""]);
            setCursor(nextCursor);
          }}
        >
          Older
        </Button>
        {page.data?.truncated ? (
          <span className="text-xs text-muted-foreground" data-testid="audit-truncated">
            Older decisions have aged out of the window kept in memory.
          </span>
        ) : null}
      </div>
    </div>
  );
}
