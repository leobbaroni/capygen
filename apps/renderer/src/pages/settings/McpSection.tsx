/**
 * Settings ▸ MCP servers (Task B2 item 2, SPEC R28-R29): per-backend tabs,
 * a list with scope/source/status badges, an add/edit dialog for
 * `stdio`/`http` servers, a Test button (`integrations.mcp.test`) and remove.
 * A `claudeai-proxy` entry (claude.ai connectors) is read-only here — a note
 * says so instead of offering Edit/Remove for a server the app cannot manage.
 */
import { useState, type ReactNode } from "react";
import { PlugZapIcon, TrashIcon } from "lucide-react";
import type { Backend, McpServerEntry, McpServerScope, McpTransport } from "@capygen/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  SectionError,
  SectionIntro,
  SectionLoading,
  SettingInput,
  SettingSelect,
  SettingsCard,
} from "@/components/settings/primitives";
import { useIntegrations } from "@/components/settings/useIntegrations";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { ipc } from "@/lib/ipc";

const BACKENDS: Backend[] = ["claude", "codex", "api"];
const SCOPE_OPTIONS: { value: McpServerScope; label: string }[] = [
  { value: "user", label: "User" },
  { value: "project", label: "Project" },
  { value: "local", label: "Local" },
];

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
  const { data, loading, error, reload } = useIntegrations(backend);
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; entry: McpServerEntry } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  async function remove(entry: McpServerEntry): Promise<void> {
    await ipc().invoke("integrations.mcp.remove", { backend, scope: entry.scope, name: entry.name });
    await reload();
  }

  async function test(entry: McpServerEntry): Promise<void> {
    const key = `${entry.scope}:${entry.name}`;
    const result = await ipc().invoke("integrations.mcp.test", { backend, name: entry.name, scope: entry.scope });
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
      <div className="flex justify-end">
        <Button size="sm" data-testid="mcp-add-button" onClick={() => setDialog({ mode: "add" })}>
          Add server
        </Button>
      </div>
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP servers registered for this backend yet.</p>
      ) : (
        servers.map((entry) => {
          const key = `${entry.scope}:${entry.name}`;
          const managedElsewhere = entry.transport === "claudeai-proxy";
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
                  {!managedElsewhere ? (
                    <>
                      <Button
                        size="icon-sm"
                        variant="outline"
                        title="Test connection"
                        data-testid={`mcp-test-${entry.name}`}
                        onClick={() => void test(entry)}
                      >
                        <PlugZapIcon className="size-3.5" />
                      </Button>
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
                        data-testid={`mcp-remove-${entry.name}`}
                        onClick={() => void remove(entry)}
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            >
              {managedElsewhere ? (
                <p className="text-xs text-muted-foreground">
                  Managed on claude.ai — connectors like this one are configured there, not in capygen.
                </p>
              ) : null}
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

interface McpFormState {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  scope: McpServerScope;
}

function toFormState(entry: McpServerEntry | null): McpFormState {
  return {
    name: entry?.name ?? "",
    transport: entry?.transport === "http" ? "http" : "stdio",
    command: entry?.command ?? "",
    args: entry?.args?.join(" ") ?? "",
    url: entry?.url ?? "",
    scope: entry?.scope ?? "user",
  };
}

/** Add/edit dialog — `stdio` and `http` only (Task B2 item 2's own scope; a
 *  `sse`/`claudeai-proxy` entry is never created from this form). */
function McpDialog({
  backend,
  initial,
  onClose,
  onSaved,
}: {
  backend: Backend;
  initial: McpServerEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<McpFormState>(() => toFormState(initial));
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
    setSaving(true);
    setSubmitError(null);
    try {
      if (initial) {
        await ipc().invoke("integrations.mcp.update", {
          backend,
          scope: initial.scope,
          name: initial.name,
          patch: {
            name: form.name.trim(),
            transport: form.transport,
            command: form.transport === "stdio" ? form.command.trim() : undefined,
            args: form.transport === "stdio" && form.args.trim() !== "" ? form.args.trim().split(/\s+/) : undefined,
            url: form.transport === "http" ? form.url.trim() : undefined,
          },
        });
      } else {
        await ipc().invoke("integrations.mcp.add", {
          backend,
          scope: form.scope,
          entry: {
            name: form.name.trim(),
            transport: form.transport,
            command: form.transport === "stdio" ? form.command.trim() : undefined,
            args: form.transport === "stdio" && form.args.trim() !== "" ? form.args.trim().split(/\s+/) : undefined,
            url: form.transport === "http" ? form.url.trim() : undefined,
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
        <div className="flex flex-col gap-3">
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
                options={SCOPE_OPTIONS}
                data-testid="mcp-select-scope"
                aria-label="Scope"
              />
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
                <SettingInput
                  value={form.args}
                  onChange={(v) => setForm((f) => ({ ...f, args: v }))}
                  placeholder="-y some-mcp-server"
                  data-testid="mcp-input-args"
                  aria-label="Arguments"
                />
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
          <Button disabled={!valid || saving} onClick={() => void save()} data-testid="mcp-dialog-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
