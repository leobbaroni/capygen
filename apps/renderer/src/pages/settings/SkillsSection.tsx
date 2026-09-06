/**
 * Settings ▸ Skills (Task B2 item 2, SPEC R28-R29): per-backend list with
 * scope/plugin, enable/disable, a Create-skill dialog (name + markdown
 * editor) and Open (reveals the file — `SessionRunner`'s call, main decides
 * Editor pane vs. OS shell, per `integrations.skill.open`'s own doc comment).
 */
import { useState } from "react";
import type { Backend, SkillScope } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  RowError,
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingInput,
  SettingSelect,
  SettingToggle,
  SettingsCard,
  SyncStatus,
} from "@/components/settings/primitives";
import { useIntegrations, useRowActions } from "@/components/settings/useIntegrations";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";

const BACKENDS: Backend[] = ["claude", "codex", "api"];
const SCOPE_OPTIONS: { value: SkillScope; label: string }[] = [
  { value: "user", label: "User" },
  { value: "project", label: "Project" },
];

export function SkillsSection() {
  const [tab, setTab] = useState<Backend>("claude");
  return (
    <div data-testid="settings-skills">
      <SectionIntro title="Skills" description="Reusable instructions each backend can invoke." />
      <div className="mb-4 flex gap-1 border-b border-border-weak" role="tablist" aria-label="Backend">
        {BACKENDS.map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={tab === b}
            data-testid={`skills-tab-${b}`}
            onClick={() => setTab(b)}
            className={`px-3 py-2 text-sm ${tab === b ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {BACKEND_LABEL[b]}
          </button>
        ))}
      </div>
      <SkillsBackendPanel backend={tab} />
    </div>
  );
}

function SkillsBackendPanel({ backend }: { backend: Backend }) {
  const { data, loading, error, reload, refreshFromBackend, projectId, scopeArgs } =
    useIntegrations(backend);
  // [review] Every inline action here used to be `void toggle(...)`: a store
  // refusing the write (a plugin-scope skill, a project scope with no project
  // open) rejected into nothing and left the row unchanged with no message.
  const rows = useRowActions();
  const [creating, setCreating] = useState(false);

  async function toggle(name: string, scope: SkillScope, enabled: boolean): Promise<void> {
    await ipc().invoke("integrations.skill.setEnabled", { backend, name, enabled, scope, ...scopeArgs });
    await reload();
  }

  async function open(path: string): Promise<void> {
    await ipc().invoke("integrations.skill.open", { path, ...scopeArgs });
  }

  if (error) return <SectionError message={error} />;
  if (loading && !data) return <SectionLoading />;

  const skills = data?.skills ?? [];

  return (
    <div data-testid={`skills-panel-${backend}`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SyncStatus
          lastSync={data?.lastSync}
          busy={rows.busy("refresh")}
          onRefresh={() => void rows.run("refresh", refreshFromBackend)}
          testId="skills-sync"
        />
        <Button size="sm" data-testid="skill-create-button" onClick={() => setCreating(true)}>
          Create skill
        </Button>
      </div>
      {rows.errorFor("refresh") ? (
        <RowError message={rows.errorFor("refresh") as string} testId="skills-refresh-error" />
      ) : null}
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills found for this backend.</p>
      ) : (
        skills.map((skill) => {
          const key = `${skill.scope}:${skill.name}`;
          const rowError = rows.errorFor(key);
          return (
            <SettingsCard
              key={key}
              testId={`skill-row-${skill.name}`}
              title={skill.name}
              subtitle={skill.description ?? skill.path}
              action={
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{skill.scope}</Badge>
                  {skill.pluginName ? <Badge variant="default">{skill.pluginName}</Badge> : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rows.busy(key)}
                    data-testid={`skill-open-${skill.name}`}
                    onClick={() => void rows.run(key, () => open(skill.path))}
                  >
                    Open
                  </Button>
                  <SettingToggle
                    checked={skill.enabled}
                    disabled={rows.busy(key)}
                    onChange={(checked) =>
                      void rows.run(key, () => toggle(skill.name, skill.scope, checked))
                    }
                    data-testid={`skill-toggle-${skill.name}`}
                    aria-label={`Enable ${skill.name}`}
                  />
                </div>
              }
            >
              {rowError ? <RowError message={rowError} testId={`skill-row-error-${skill.name}`} /> : null}
            </SettingsCard>
          );
        })
      )}
      {creating ? (
        <CreateSkillDialog
          backend={backend}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateSkillDialog({
  backend,
  projectId,
  onClose,
  onCreated,
}: {
  backend: Backend;
  /** This window's selected project (7-P0). A `project`-scope skill is written
   *  into `<project>/.claude/skills`, so it is only offered when there is one. */
  projectId: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SkillScope>("user");
  const [markdown, setMarkdown] = useState("---\nname: \ndescription: \n---\n\n");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = name.trim() === "" ? "Name is required." : null;
  const markdownError = markdown.trim() === "" ? "The skill's markdown body cannot be empty." : null;
  const valid = !nameError && !markdownError;

  async function save(): Promise<void> {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await ipc().invoke("integrations.skill.create", {
        backend,
        scope,
        name: name.trim(),
        markdown,
        ...(projectId === null ? {} : { projectId }),
      });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="skill-create-dialog" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create skill</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <SettingInput value={name} onChange={setName} data-testid="skill-input-name" aria-label="Skill name" />
              {nameError ? <span className="text-xs text-destructive">{nameError}</span> : null}
            </label>
            <label className="flex w-40 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Scope</span>
              <SettingSelect
                value={scope}
                onChange={(v) => setScope(v as SkillScope)}
                options={projectId === null ? SCOPE_OPTIONS.filter((o) => o.value === "user") : SCOPE_OPTIONS}
                data-testid="skill-select-scope"
                aria-label="Scope"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Markdown</span>
            <Textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={10}
              data-testid="skill-input-markdown"
              aria-label="Skill markdown"
              className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
            />
            {markdownError ? <span className="text-xs text-destructive">{markdownError}</span> : null}
          </label>
          {error ? (
            <p role="alert" data-testid="skill-create-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="skill-dialog-cancel">
            Cancel
          </Button>
          <Button disabled={!valid || saving} onClick={() => void save()} data-testid="skill-dialog-save">
            {saving ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
