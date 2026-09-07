/**
 * Settings ▸ MCP servers (Task B2 item 2, SPEC R28-R29): per-backend tabs,
 * a list with scope/source/status badges, an add/edit dialog for
 * `stdio`/`http` servers, a Test button (`integrations.mcp.test`) and remove.
 *
 * Rows the owning store refuses to write are read-only here rather than
 * offered and then rejected: a `claudeai-proxy` entry (a claude.ai connector),
 * a `plugin`-scope entry (it belongs to the plugin), an `api` row inherited
 * from another backend, and an `sse` entry (this form cannot express one — see
 * `toFormState`). Each says why.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlugZapIcon, TrashIcon } from "lucide-react";
import type { Backend, McpServerEntry, McpServerScope, McpTransport } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

/**
 * [review] The scope select used to offer User/Project/Local on every tab, and
 * only Save found out: `CodexConfigStore.assertUserScope` and
 * `ApiConfigStore.assertOwnScope` both accept `user` and nothing else, and
 * Claude's project/local scopes need an open project
 * (`assertWritableMcpScope`). The options are derived from that instead.
 */
export function scopeOptionsFor(
  backend: Backend,
  hasProject: boolean,
): { value: McpServerScope; label: string }[] {
  const user = { value: "user" as const, label: "User" };
  if (backend !== "claude") return [user];
  if (!hasProject) return [user];
  return [
    user,
    { value: "project", label: "Project (.mcp.json)" },
    { value: "local", label: "Local (this project only)" },
  ];
}

/** Why this row has no Edit/Remove, or null when it is capygen's to write. */
export function readOnlyReason(entry: McpServerEntry): string | null {
  if (entry.transport === "claudeai-proxy") {
    return "Managed on claude.ai — connectors like this one are configured there, not in capygen.";
  }
  if (entry.inherited === true) {
    return "Inherited from another backend — edit it on the backend whose config declares it.";
  }
  if (entry.scope === "plugin") {
    return "Shipped by a plugin — disable the plugin instead of editing its files.";
  }
  if (entry.transport === "sse") {
    // [review] The edit form has no SSE mode, and `toFormState` used to fall
    // back to stdio: opening an sse server showed an empty Command box and
    // saving rewrote the entry as stdio, destroying the registration.
    return "SSE servers are shown read-only — capygen's editor cannot express one yet.";
  }
  return null;
}

export function McpSection() {
  const [tab, setTab] = useState<Backend>("claude");
  return (
    <div data-testid="settings-mcp">
      <SectionIntro title="MCP servers" description="Model Context Protocol servers each backend can reach." />
      <div className="mb-4 flex gap-1 border-b border-border-weak" role="tablist" aria-label="Backend">
        {BACKENDS.map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            aria-selected={tab === b}
            data-testid={`mcp-tab-${b}`}
            onClick={() => setTab(b)}
            className={`px-3 py-2 text-sm ${tab === b ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {BACKEND_LABEL[b]}
          </button>
        ))}
      </div>
      <McpBackendPanel backend={tab} />
    </div>
  );
}

function McpBackendPanel({ backend }: { backend: Backend }) {
  const { data, loading, error, reload, refreshFromBackend, projectId, scopeArgs } =
    useIntegrations(backend);
  const rows = useRowActions();
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; entry: McpServerEntry } | null>(null);
  // The rows the dialog was opened from belong to the scope that was showing;
  // once the window moves to another project or backend tab, that dialog is
  // about data this panel no longer displays, so it closes with it.
  useEffect(() => {
    setDialog(null);
  }, [backend, projectId]);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // 7-P0: the project scopes are offered only when this window actually has a
  // project selected — `project`/`local` writes are refused without an explicit
  // id, so offering them with nothing selected would offer a guaranteed error.
  const hasProject = projectId !== null;
  const scopeOptions = useMemo(() => scopeOptionsFor(backend, hasProject), [backend, hasProject]);

  async function remove(entry: McpServerEntry): Promise<void> {
    await ipc().invoke("integrations.mcp.remove", {
      backend,
      scope: entry.scope,
      name: entry.name,
      ...scopeArgs,
    });
    await reload();
  }

  async function setEnabled(entry: McpServerEntry, enabled: boolean): Promise<void> {
    await ipc().invoke("integrations.mcp.update", {
      backend,
      scope: entry.scope,
      name: entry.name,
      patch: { enabled },
      ...scopeArgs,
    });
    await reload();
  }

  async function test(entry: McpServerEntry): Promise<void> {
    const key = `${entry.scope}:${entry.name}`;
    const result = await ipc().invoke("integrations.mcp.test", {
      backend,
      name: entry.name,
      scope: entry.scope,
      ...scopeArgs,
    });
    setTestResult((prev) => ({
      ...prev,
      [key]: {
        ok: result.ok,
        message: result.ok ? `Connected — ${result.tools?.length ?? 0} tools` : (result.error ?? "Failed"),
      },
    }));
  }

  if (error) return <SectionError message={error} />;
  if (loading && !data) return <SectionLoading />;

  const servers = data?.mcpServers ?? [];

  return (
    <div data-testid={`mcp-panel-${backend}`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SyncStatus
          lastSync={data?.lastSync}
          busy={rows.busy("refresh")}
          onRefresh={() => void rows.run("refresh", refreshFromBackend)}
          testId="mcp-sync"
        />
        <Button size="sm" data-testid="mcp-add-button" onClick={() => setDialog({ mode: "add" })}>
          Add server
        </Button>
      </div>
      {rows.errorFor("refresh") ? (
        <RowError message={rows.errorFor("refresh") as string} testId="mcp-refresh-error" />
      ) : null}
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP servers registered for this backend yet.</p>
      ) : (
        servers.map((entry) => {
          const key = `${entry.scope}:${entry.name}`;
          const readOnly = readOnlyReason(entry);
          const rowError = rows.errorFor(key);
          return (
            <SettingsCard
              key={key}
              testId={`mcp-row-${entry.name}`}
              title={entry.name}
              subtitle={entry.command ?? entry.url ?? entry.source}
              action={
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline">{entry.scope}</Badge>
                  <Badge variant={entry.status === "connected" ? "success" : entry.status === "failed" ? "destructive" : "default"}>
                    {entry.status ?? "unknown"}
                  </Badge>
                  {entry.transport !== "claudeai-proxy" ? (
                    <Button
                      size="icon-sm"
                      variant="outline"
                      title="Test connection"
                      disabled={rows.busy(key)}
                      data-testid={`mcp-test-${entry.name}`}
                      onClick={() => void rows.run(key, () => test(entry))}
                    >
                      <PlugZapIcon className="size-3.5" />
                    </Button>
                  ) : null}
                  {!readOnly ? (
                    <>
                      <SettingToggle
                        checked={entry.enabled}
                        disabled={rows.busy(key)}
                        onChange={(checked) => void rows.run(key, () => setEnabled(entry, checked))}
                        data-testid={`mcp-enabled-${entry.name}`}
                        aria-label={`Enable ${entry.name}`}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`mcp-edit-${entry.name}`}
                        onClick={() => setDialog({ mode: "edit", entry })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        title="Remove"
                        disabled={rows.busy(key)}
                        data-testid={`mcp-remove-${entry.name}`}
                        onClick={() => void rows.run(key, () => remove(entry))}
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            >
              {readOnly ? <p className="text-xs text-muted-foreground">{readOnly}</p> : null}
              {rowError ? <RowError message={rowError} testId={`mcp-row-error-${entry.name}`} /> : null}
              {testResult[key] ? (
                <p
                  data-testid={`mcp-test-result-${entry.name}`}
                  className={`text-xs ${testResult[key]!.ok ? "text-success" : "text-destructive"}`}
                >
                  {testResult[key]!.message}
                </p>
              ) : null}
            </SettingsCard>
          );
        })
      )}
      {dialog ? (
        <McpDialog
          backend={backend}
          projectId={projectId}
          scopeOptions={scopeOptions}
          initial={dialog.mode === "edit" ? dialog.entry : null}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

interface EnvPair {
  key: string;
  value: string;
}

interface McpFormState {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  cwd: string;
  scope: McpServerScope;
  env: EnvPair[];
  headers: EnvPair[];
}

function toFormState(entry: McpServerEntry | null, scope: McpServerScope): McpFormState {
  return {
    name: entry?.name ?? "",
    // Only the two transports this form can express reach it — `readOnlyReason`
    // keeps every other kind out of the edit path entirely.
    transport: entry?.transport === "http" ? "http" : "stdio",
    command: entry?.command ?? "",
    args: entry?.args?.join("\n") ?? "",
    url: entry?.url ?? "",
    cwd: entry?.cwd ?? "",
    scope: entry?.scope ?? scope,
    env: (entry?.envKeys ?? []).map((key) => ({ key, value: "" })),
    headers: (entry?.headerKeys ?? []).map((key) => ({ key, value: "" })),
  };
}

/** `env` pairs → the record the contract carries; blank keys are dropped. */
export function envRecord(pairs: EnvPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key === "") continue;
    out[key] = pair.value;
  }
  return out;
}

/** One argument per line, so spaces and Windows paths round-trip exactly. */
export function parseArgs(value: string): string[] {
  return value === "" ? [] : value.split(/\r?\n/).filter((arg) => arg.length > 0);
}

/** Build an edit mutation without ever needing an existing secret value. */
export function secretMutation(
  pairs: EnvPair[],
  originalKeys: readonly string[],
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  const currentKeys = new Set(pairs.map((pair) => pair.key.trim()).filter(Boolean));
  for (const key of originalKeys) if (!currentKeys.has(key)) out[key] = null;
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    if (!originalKeys.includes(key) || pair.value !== "") out[key] = pair.value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Add/edit dialog — `stdio` and `http`. */
function McpDialog({
  backend,
  projectId,
  scopeOptions,
  initial,
  onClose,
  onSaved,
}: {
  backend: Backend;
  /** This window's selected project **when the dialog opened**; see `captured`. */
  projectId: string | null;
  scopeOptions: { value: McpServerScope; label: string }[];
  initial: McpServerEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<McpFormState>(() =>
    toFormState(initial, scopeOptions[0]?.value ?? "user"),
  );
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * [review] The scope this dialog is *about*, frozen when it opened.
   *
   * The form is filled in over seconds; the selected project (or the backend
   * tab) can move under it in another part of the window in that time. Reading
   * the live scope at submit meant the row the user was looking at in project A
   * was written into project B — silently, and into a file they never opened.
   * The captured pair is what the write is addressed to, and if the page has
   * moved on the dialog refuses rather than guessing which one the user meant.
   */
  const captured = useRef({ backend, projectId });
  const scopeArgs = captured.current.projectId === null ? {} : { projectId: captured.current.projectId };
  const drifted = captured.current.backend !== backend || captured.current.projectId !== projectId;

  const nameError = form.name.trim() === "" ? "Name is required." : null;
  const commandError =
    form.transport === "stdio" && form.command.trim() === "" ? "Command is required for a stdio server." : null;
  const urlError =
    form.transport === "http" && !/^https?:\/\/\S+/.test(form.url.trim())
      ? "A valid http(s):// URL is required for an HTTP server."
      : null;
  const valid = !nameError && !commandError && !urlError;

  async function save(): Promise<void> {
    if (!valid) return;
    if (drifted) {
      setSubmitError(
        "The selected project or backend changed while this dialog was open, so nothing " +
          "was written. Close it and start again on the project you meant.",
      );
      return;
    }
    setSaving(true);
    setSubmitError(null);
    const stdio = form.transport === "stdio";
    // [review] `args: []`, never `undefined`, when the field is cleared: both
    // stores merge with `patch.args ?? existing.args`, so an `undefined` here
    // silently restored the arguments the user had just deleted.
    const args = stdio ? parseArgs(form.args) : undefined;
    try {
      if (initial) {
        await ipc().invoke("integrations.mcp.update", {
          backend: captured.current.backend,
          ...scopeArgs,
          scope: initial.scope,
          name: initial.name,
          patch: {
            name: form.name.trim(),
            transport: form.transport,
            command: stdio ? form.command.trim() : "",
            args,
            url: form.transport === "http" ? form.url.trim() : "",
            cwd: form.cwd.trim(),
            env: secretMutation(form.env, initial.envKeys ?? []),
            headers: secretMutation(stdio ? [] : form.headers, initial.headerKeys ?? []),
          },
        });
      } else {
        await ipc().invoke("integrations.mcp.add", {
          backend: captured.current.backend,
          ...scopeArgs,
          scope: form.scope,
          entry: {
            name: form.name.trim(),
            transport: form.transport,
            command: stdio ? form.command.trim() : undefined,
            args,
            url: form.transport === "http" ? form.url.trim() : undefined,
            cwd: form.cwd.trim() || undefined,
            env: envRecord(form.env),
            headers: envRecord(form.headers),
            source: "capygen",
          },
        });
      }
      await onSaved();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="mcp-dialog">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit ${initial.name}` : "Add MCP server"}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          <Field label="Name" error={nameError} testId="mcp-field-name">
            <SettingInput
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              data-testid="mcp-input-name"
              aria-label="Server name"
            />
          </Field>
          <Field label="Transport" testId="mcp-field-transport">
            <SettingSelect
              value={form.transport}
              onChange={(v) => setForm((f) => ({ ...f, transport: v as McpTransport }))}
              options={[
                { value: "stdio", label: "stdio (local command)" },
                { value: "http", label: "HTTP" },
              ]}
              data-testid="mcp-select-transport"
              aria-label="Transport"
            />
          </Field>
          {!initial ? (
            <Field label="Scope" testId="mcp-field-scope">
              <SettingSelect
                value={form.scope}
                onChange={(v) => setForm((f) => ({ ...f, scope: v as McpServerScope }))}
                options={scopeOptions}
                data-testid="mcp-select-scope"
                aria-label="Scope"
              />
              {scopeOptions.length === 1 ? (
                <span className="text-xs text-muted-foreground">
                  {backend === "claude"
                    ? "Project and Local scope need an open project."
                    : `The ${BACKEND_LABEL[backend]} backend keeps every MCP server in one user-scope config.`}
                </span>
              ) : null}
            </Field>
          ) : null}
          {form.transport === "stdio" ? (
            <>
              <Field label="Command" error={commandError} testId="mcp-field-command">
                <SettingInput
                  value={form.command}
                  onChange={(v) => setForm((f) => ({ ...f, command: v }))}
                  placeholder="npx"
                  data-testid="mcp-input-command"
                  aria-label="Command"
                />
              </Field>
              <Field label="Arguments" testId="mcp-field-args">
                <textarea
                  value={form.args}
                  onChange={(event) => setForm((f) => ({ ...f, args: event.target.value }))}
                  placeholder={"-y\nsome-mcp-server\nC:\\path with spaces"}
                  data-testid="mcp-input-args"
                  aria-label="Arguments"
                  rows={4}
                  className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground outline-none placeholder:text-foreground-tertiary focus:border-ring"
                />
                <span className="text-xs text-muted-foreground">One argument per line.</span>
              </Field>
            </>
          ) : (
            <Field label="URL" error={urlError} testId="mcp-field-url">
              <SettingInput
                value={form.url}
                onChange={(v) => setForm((f) => ({ ...f, url: v }))}
                placeholder="https://example.com/mcp"
                data-testid="mcp-input-url"
                aria-label="URL"
              />
            </Field>
          )}
          <Field label="Working directory" testId="mcp-field-cwd">
            <SettingInput value={form.cwd} onChange={(cwd) => setForm((f) => ({ ...f, cwd }))}
              placeholder="Optional" data-testid="mcp-input-cwd" aria-label="Working directory" />
          </Field>
          <SecretEditor label="Environment variables" prefix="env" pairs={form.env}
            onChange={(env) => setForm((f) => ({ ...f, env }))} />
          {form.transport === "http" ? (
            <SecretEditor label="HTTP headers" prefix="header" pairs={form.headers}
              onChange={(headers) => setForm((f) => ({ ...f, headers }))} />
          ) : null}
          {submitError ? (
            <p role="alert" data-testid="mcp-submit-error" className="text-xs text-destructive">
              {submitError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="mcp-dialog-cancel">
            Cancel
          </Button>
          <Button
            disabled={!valid || saving || drifted}
            onClick={() => void save()}
            data-testid="mcp-dialog-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * [review] SPEC R28 names ComfyUI and Higgsfield by example and both are
 * configured with an API key in `env`; the form had no way to set one, so
 * adding either meant dropping to `claude mcp add -e KEY=…`. Values are
 * password inputs so a key is not shoulder-surfable, and they are only ever
 * sent to `integrations.mcp.*`, which writes them into the backend's own
 * config file.
 */
function SecretEditor({
  label,
  prefix,
  pairs,
  onChange,
}: {
  label: string;
  prefix: "env" | "header";
  pairs: EnvPair[];
  onChange: (pairs: EnvPair[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={`mcp-field-${prefix}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <SettingInput
            value={pair.key}
            onChange={(v) => onChange(pairs.map((p, i) => (i === index ? { ...p, key: v } : p)))}
            placeholder="API_KEY"
            data-testid={`mcp-${prefix}-key-${index}`}
            aria-label={`${label} ${index + 1} name`}
          />
          <input
            type="password"
            value={pair.value}
            onChange={(e) =>
              onChange(pairs.map((p, i) => (i === index ? { ...p, value: e.target.value } : p)))
            }
            placeholder={pair.value === "" ? "Leave blank to keep current value" : "value"}
            data-testid={`mcp-${prefix}-value-${index}`}
            aria-label={`${label} ${index + 1} value`}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-foreground-tertiary focus:border-ring"
          />
          <Button
            size="icon-sm"
            variant="outline"
            title="Remove variable"
            data-testid={`mcp-${prefix}-remove-${index}`}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid={`mcp-${prefix}-add`}
          onClick={() => onChange([...pairs, { key: "", value: "" }])}
        >
          Add variable
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
  testId,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}
