/**
 * Settings ▸ Tools (Task B2 item 2, SPEC R28-R29): a per-backend policy table
 * (`ToolPolicyEntry`: pattern → allow/deny/ask, scoped global/project/session)
 * with a pattern editor, plus Claude's permission modes explained — the same
 * vocabulary `HarnessesSection`'s Claude Defaults card edits at the
 * *backend* level; this table is the finer-grained per-tool-pattern layer on
 * top of it.
 */
import { useState } from "react";
import type { Backend, ToolPolicyDecision, ToolPolicyScope } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrivesLaterNote,
  RowError,
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingInput,
  SettingSelect,
} from "@/components/settings/primitives";
import { useIntegrations, useRowActions } from "@/components/settings/useIntegrations";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";

const BACKENDS: Backend[] = ["claude", "codex", "api"];
const DECISION_OPTIONS: { value: ToolPolicyDecision; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
  { value: "ask", label: "Ask" },
];
/**
 * [review] `session` is deliberately absent.
 *
 * Only a `claude` policy at `global`/`project` scope is written where a turn
 * ever reads it: `IntegrationsService.setToolPolicy` sends exactly those to
 * `ClaudeConfigStore`, which puts them in Claude's own
 * `permissions.{allow,deny,ask}` arrays, so the CLI honours them too. Every
 * other combination — a `session` rule, and anything at all for `codex` or
 * `api` — becomes a row in capygen's SQLite `policies` table that **nothing
 * consults**: grep `toolPolicies` outside this page and `SyncCoordinator` and
 * there is no reader, and neither harness mentions it. Phase 9 owns the
 * permission engine that will (PLAN: "a `codex`/`api` tool policy is capygen's
 * own SQLite row enforced by capygen's permission cards"). Until then the
 * editor is offered only where it is real, and the other tabs say so instead
 * of looking authoritative.
 */
const SCOPE_OPTIONS: { value: ToolPolicyScope; label: string }[] = [
  { value: "global", label: "Global" },
  { value: "project", label: "Project" },
];

/** Whether a policy written on this backend actually reaches a turn (see above). */
export function policiesAreEnforced(backend: Backend): boolean {
  return backend === "claude";
}

const CLAUDE_PERMISSION_MODES = [
  { mode: "default", blurb: "Ask before a risky tool call (file writes, shell commands, …)." },
  { mode: "acceptEdits", blurb: "File edits are auto-approved; everything else still asks." },
  { mode: "bypassPermissions", blurb: "Nothing is asked — every tool call runs immediately." },
  { mode: "plan", blurb: "Read-only: no tool call may change anything on disk or run a command." },
];

export function ToolsSection() {
  const [tab, setTab] = useState<Backend>("claude");
  return (
    <div data-testid="settings-tools">
      <SectionIntro title="Tools" description="Allow/deny/ask policy per tool-name pattern, per backend." />
      <div className="mb-4 flex gap-1 border-b border-border-weak" role="tablist" aria-label="Backend">
        {BACKENDS.map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={tab === b}
            data-testid={`tools-tab-${b}`}
            onClick={() => setTab(b)}
            className={`px-3 py-2 text-sm ${tab === b ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {BACKEND_LABEL[b]}
          </button>
        ))}
      </div>
      {tab === "claude" ? <ClaudePermissionModesNote /> : null}
      <ToolsBackendPanel backend={tab} />
    </div>
  );
}

function ClaudePermissionModesNote() {
  return (
    <div data-testid="claude-permission-modes" className="mb-4 rounded-lg border border-border-weak bg-card/50 p-3.5">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Claude permission modes
      </p>
      <dl className="flex flex-col gap-1.5">
        {CLAUDE_PERMISSION_MODES.map((m) => (
          <div key={m.mode} className="flex gap-2 text-sm">
            <dt className="w-40 shrink-0 font-mono text-xs text-foreground">{m.mode}</dt>
            <dd className="text-muted-foreground">{m.blurb}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Set the default mode under Harnesses; the table below writes per-pattern exceptions into
        Claude&apos;s own <code className="font-mono">permissions</code> arrays, so the{" "}
        <code className="font-mono">claude</code> CLI honours them too.
      </p>
    </div>
  );
}

function ToolsBackendPanel({ backend }: { backend: Backend }) {
  const { data, loading, error, reload } = useIntegrations(backend);
  // [review] Each row's own failure, kept next to the row: `updateDecision` and
  // `remove` were bare `void` calls, so a store's refusal produced an unhandled
  // rejection and a row that silently did not change.
  const rows = useRowActions();
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<ToolPolicyDecision>("ask");
  const [scope, setScope] = useState<ToolPolicyScope>("global");
  const enforced = policiesAreEnforced(backend);

  async function add(): Promise<void> {
    if (pattern.trim() === "") return;
    await rows.run("add", async () => {
      await ipc().invoke("integrations.tools.setPolicy", { backend, scope, pattern: pattern.trim(), decision });
      setPattern("");
      await reload();
    });
  }

  async function updateDecision(
    existingPattern: string,
    existingScope: ToolPolicyScope,
    newDecision: ToolPolicyDecision,
  ): Promise<void> {
    await ipc().invoke("integrations.tools.setPolicy", {
      backend,
      scope: existingScope,
      pattern: existingPattern,
      decision: newDecision,
    });
    await reload();
  }

  async function remove(existingPattern: string, existingScope: ToolPolicyScope): Promise<void> {
    await ipc().invoke("integrations.tools.removePolicy", { backend, scope: existingScope, pattern: existingPattern });
    await reload();
  }

  if (error) return <SectionError message={error} />;
  if (loading && !data) return <SectionLoading />;

  const policies = data?.tools ?? [];

  return (
    <div data-testid={`tools-panel-${backend}`} className="flex flex-col gap-3">
      {!enforced ? (
        <div data-testid="tools-not-enforced">
          <ArrivesLaterNote phase="Phase 9" what={`${BACKEND_LABEL[backend]} tool policies`} />
          <p className="mt-2 text-sm text-muted-foreground">
            {BACKEND_LABEL[backend]} has no per-tool permission list of its own, so a rule here
            would have to be enforced by capygen&apos;s own permission cards — which Phase 9 builds.
            Rows below were stored by an earlier build and no turn consults them; you can remove
            them.
          </p>
        </div>
      ) : null}
      {policies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool policies set — every tool follows the default mode.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-weak text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Pattern</th>
                <th className="py-1.5 pr-3 font-medium">Scope</th>
                <th className="py-1.5 pr-3 font-medium">Decision</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const key = `${p.scope}:${p.pattern}`;
                const rowEnforced = enforced && p.scope !== "session";
                return (
                  <tr key={key} data-testid={`tool-policy-row-${p.pattern}`} className="border-b border-border-weak last:border-b-0">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {p.pattern}
                      {rows.errorFor(key) ? (
                        <RowError
                          message={rows.errorFor(key) as string}
                          testId={`tool-policy-error-${p.pattern}`}
                        />
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline">{p.scope}</Badge>
                        {!rowEnforced ? (
                          <Badge variant="warning" data-testid={`tool-policy-unenforced-${p.pattern}`}>
                            not enforced yet
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <SettingSelect
                        value={p.decision}
                        disabled={rows.busy(key)}
                        onChange={(v) =>
                          void rows.run(key, () =>
                            updateDecision(p.pattern, p.scope, v as ToolPolicyDecision),
                          )
                        }
                        options={DECISION_OPTIONS}
                        data-testid={`tool-policy-decision-${p.pattern}`}
                        aria-label={`Decision for ${p.pattern}`}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="icon-sm"
                        variant="outline"
                        disabled={rows.busy(key)}
                        data-testid={`tool-policy-remove-${p.pattern}`}
                        onClick={() => void rows.run(key, () => remove(p.pattern, p.scope))}
                      >
                        ×
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {enforced ? (
      <div className="flex items-end gap-2 border-t border-border-weak pt-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Pattern</span>
          <SettingInput
            value={pattern}
            onChange={setPattern}
            placeholder="Bash(rm *)"
            data-testid="tool-policy-input-pattern"
            aria-label="Tool pattern"
          />
        </label>
        <label className="flex w-32 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Decision</span>
          <SettingSelect
            value={decision}
            onChange={(v) => setDecision(v as ToolPolicyDecision)}
            options={DECISION_OPTIONS}
            data-testid="tool-policy-input-decision"
            aria-label="New policy decision"
          />
        </label>
        <label className="flex w-32 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Scope</span>
          <SettingSelect
            value={scope}
            onChange={(v) => setScope(v as ToolPolicyScope)}
            options={SCOPE_OPTIONS}
            data-testid="tool-policy-input-scope"
            aria-label="New policy scope"
          />
        </label>
        <Button
          size="sm"
          disabled={rows.busy("add") || pattern.trim() === ""}
          data-testid="tool-policy-add"
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      ) : null}
      {rows.errorFor("add") ? (
        <RowError message={rows.errorFor("add") as string} testId="tool-policy-add-error" />
      ) : null}
    </div>
  );
}
