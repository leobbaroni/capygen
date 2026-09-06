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
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingInput,
  SettingSelect,
} from "@/components/settings/primitives";
import { useIntegrations } from "@/components/settings/useIntegrations";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";

const BACKENDS: Backend[] = ["claude", "codex", "api"];
const DECISION_OPTIONS: { value: ToolPolicyDecision; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
  { value: "ask", label: "Ask" },
];
const SCOPE_OPTIONS: { value: ToolPolicyScope; label: string }[] = [
  { value: "global", label: "Global" },
  { value: "project", label: "Project" },
  { value: "session", label: "Session" },
];

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
        Set the default mode under Harnesses; the table below adds per-pattern exceptions on top.
      </p>
    </div>
  );
}

function ToolsBackendPanel({ backend }: { backend: Backend }) {
  const { data, loading, error, reload } = useIntegrations(backend);
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<ToolPolicyDecision>("ask");
  const [scope, setScope] = useState<ToolPolicyScope>("global");
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    if (pattern.trim() === "") return;
    setBusy(true);
    try {
      await ipc().invoke("integrations.tools.setPolicy", { backend, scope, pattern: pattern.trim(), decision });
      setPattern("");
      await reload();
    } finally {
      setBusy(false);
    }
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
              {policies.map((p) => (
                <tr key={`${p.scope}:${p.pattern}`} data-testid={`tool-policy-row-${p.pattern}`} className="border-b border-border-weak last:border-b-0">
                  <td className="py-2 pr-3 font-mono text-xs">{p.pattern}</td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline">{p.scope}</Badge>
                  </td>
                  <td className="py-2 pr-3">
                    <SettingSelect
                      value={p.decision}
                      onChange={(v) => void updateDecision(p.pattern, p.scope, v as ToolPolicyDecision)}
                      options={DECISION_OPTIONS}
                      data-testid={`tool-policy-decision-${p.pattern}`}
                      aria-label={`Decision for ${p.pattern}`}
                    />
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="icon-sm"
                      variant="outline"
                      data-testid={`tool-policy-remove-${p.pattern}`}
                      onClick={() => void remove(p.pattern, p.scope)}
                    >
                      ×
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        <Button size="sm" disabled={busy || pattern.trim() === ""} data-testid="tool-policy-add" onClick={() => void add()}>
          Add
        </Button>
      </div>
    </div>
  );
}
