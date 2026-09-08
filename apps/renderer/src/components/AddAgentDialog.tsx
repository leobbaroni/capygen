/**
 * "Add agent" dialog (SPEC items B2.1/B2.3): backend, model, display name,
 * mention name (auto-derived from the display name, editable), role, an
 * supported model effort and description — field set ported from
 * reference/omnigent/web/src/shell/AddAgentDialog.tsx + CreateAgentDialog.tsx,
 * adapted to capygen's backend/model shape (no agent catalog to pick from —
 * `harness.list` is the whole picker).
 *
 * Two modes, because the IPC surface for the two callers is different:
 *
 *   - `mode="draft"` — the New Session landing, before a session exists.
 *     `onAdd` receives a fully-formed `AgentDraft`; the caller appends it to
 *     its own local roster and it rides along in `sessions.create`'s own
 *     `agents` array, whose `AgentDraftSchema` accepts every field below
 *     directly. Nothing is sent over IPC from here.
 *   - `mode="live"` — an open round-table session's Agents pane. Calls
 *     `store.addAgent`, which itself composes two IPC calls because
 *     `agents.add`'s channel only accepts
 *     `{backend, model, displayName, mentionName, role, config}` —
 *     `description`/`color` go through a follow-up
 *     `agents.update` (`AgentPatchSchema`, which does carry them) once the
 *     agent exists. See `appStore.ts`'s `addAgent` for that composition.
 *
 * Validation (SPEC item B2.5's "unique mention names"): display name and a
 * mention name matching `MentionNameSchema` are required; the mention name
 * must not already be used by another agent in this session/draft roster.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MentionNameSchema, deriveMentionName, type AgentDraft, type Backend, type HarnessInfo } from "@capygen/shared";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supportedEfforts, withAgentEffort } from "@/lib/agentDisplay";
import { useAppStore } from "@/store/appStore";

export interface AddAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  harnesses: HarnessInfo[];
  /** Lowercase mention names already taken in this session (or draft
   *  roster) — the uniqueness check compares against this, case-insensitively. */
  existingMentionNames: string[];
  mode: "draft" | "live";
  /** Required when `mode === "live"`. */
  sessionId?: string;
  /** Draft mode only: whether "Make this the lead agent" starts checked
   *  (the caller passes `true` for the first agent in an empty roster). */
  defaultLead?: boolean;
  /** Draft mode only: called with the finished `AgentDraft` on submit. */
  onAdd?: (draft: AgentDraft) => void;
}

function firstAvailable(harnesses: HarnessInfo[]): HarnessInfo | null {
  return harnesses.find((h) => h.available) ?? null;
}

function initialModel(harness: HarnessInfo | null): string {
  return harness?.models.find((model) => model.id === harness.defaultModel)?.id ?? harness?.models[0]?.id ?? "";
}

export function AddAgentDialog({
  open,
  onOpenChange,
  harnesses,
  existingMentionNames,
  mode,
  sessionId,
  defaultLead = false,
  onAdd,
}: AddAgentDialogProps) {
  const addAgent = useAppStore((s) => s.addAgent);
  const available = useMemo(() => harnesses.filter((h) => h.available), [harnesses]);

  const [backend, setBackend] = useState<Backend | "">(() => firstAvailable(harnesses)?.backend ?? "");
  const [model, setModel] = useState<string>(() => initialModel(firstAvailable(harnesses)));
  const [displayName, setDisplayName] = useState("");
  const [mentionName, setMentionName] = useState("");
  const [mentionEdited, setMentionEdited] = useState(false);
  const [makeLead, setMakeLead] = useState(defaultLead);
  const [description, setDescription] = useState("");
  const [effort, setEffort] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentHarness = available.find((h) => h.backend === backend) ?? null;
  const efforts = backend ? supportedEfforts(harnesses, backend, model) : [];

  // Auto-derive the mention name from the display name until the user edits
  // it directly — the same "auto, then sticky once touched" pattern the
  // reference dialogs use for slugs.
  useEffect(() => {
    if (!mentionEdited) setMentionName(deriveMentionName(displayName));
  }, [displayName, mentionEdited]);

  function resetFields(): void {
    const first = firstAvailable(harnesses);
    setBackend(first?.backend ?? "");
    setModel(initialModel(first));
    setDisplayName("");
    setMentionName("");
    setMentionEdited(false);
    setMakeLead(defaultLead);
    setDescription("");
    setEffort("");
    setError(null);
    setSubmitting(false);
  }

  /**
   * Seed the form when the dialog is **shown**, not when it is dismissed.
   *
   * Both of this component's inputs change after mount, and resetting on close
   * read them one render too early:
   *   - `harnesses` is empty at mount (`harness.list` is deliberately not
   *     awaited by the bootstrap), so the first open rendered a Backend select
   *     displaying "Claude Code" over a `backend` of `""` and a Model select
   *     with no options at all. Add then refused with "Choose a backend.", and
   *     on a machine with one backend re-picking the shown option fires no
   *     `change` event — the only way out was Cancel and reopen;
   *   - `defaultLead` flips to false once the caller's roster has an agent,
   *     but `resetFields` ran from the closure of the render that submitted,
   *     where it was still true — so the second agent drafted on the landing
   *     silently stole the lead crown.
   */
  useEffect(() => {
    if (open) resetFields();
    // Keyed on `open` alone on purpose: this means "the dialog was shown".
    // Re-running it whenever a dependency moved would wipe what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // `harness.list` can also land *while* the dialog is open. Fill in only what
  // is still unset, so this can never overwrite a choice the user has made.
  useEffect(() => {
    if (backend) return;
    const first = firstAvailable(harnesses);
    if (!first) return;
    setBackend(first.backend);
    setModel(initialModel(first));
  }, [harnesses, backend]);

  function handleOpenChange(next: boolean): void {
    onOpenChange(next);
  }

  function validate(): string | null {
    if (!backend) return "Choose a backend.";
    if (!model.trim() || !currentHarness?.models.some((entry) => entry.id === model)) return "Choose an available model.";
    if (effort && !efforts.includes(effort)) return "Choose a supported effort.";
    if (!displayName.trim()) return "Enter a display name.";
    const parsed = MentionNameSchema.safeParse(mentionName);
    if (!parsed.success) {
      return "Mention name must be lowercase letters, numbers, - or _, starting with a letter or number.";
    }
    if (existingMentionNames.includes(mentionName.toLowerCase())) {
      return "That mention name is already used in this session.";
    }
    return null;
  }

  async function handleSubmit(): Promise<void> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    // `validate()` above already refused an empty `backend`.
    const chosenBackend = backend as Backend;
    const trimmedDisplayName = displayName.trim();

    if (mode === "draft") {
      onAdd?.({
        name: trimmedDisplayName,
        displayName: trimmedDisplayName,
        mentionName,
        backend: chosenBackend,
        model,
        role: makeLead ? "lead" : "member",
        ...(description.trim() ? { description: description.trim() } : {}),
        config: effort ? withAgentEffort(null, chosenBackend, effort) : null,
      });
      handleOpenChange(false);
      return;
    }

    if (!sessionId) return;
    setSubmitting(true);
    setError(null);
    try {
      await addAgent(sessionId, {
        backend: chosenBackend,
        model,
        displayName: trimmedDisplayName,
        mentionName,
        role: makeLead ? "lead" : "member",
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(effort ? { config: withAgentEffort(null, chosenBackend, effort) } : {}),
      });
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the agent. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="add-agent-dialog">
        <DialogHeader>
          <DialogTitle>Add agent</DialogTitle>
        </DialogHeader>

        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
          {available.length === 0 ? (
            <p data-testid="add-agent-empty" className="text-sm text-muted-foreground">
              No backends are available on this machine yet — check Settings ▸ Harnesses.
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <Field label="Backend" htmlFor="add-agent-backend">
                  <select
                    id="add-agent-backend"
                    data-testid="add-agent-backend"
                    value={backend}
                    onChange={(e) => {
                      const nextBackend = e.target.value as Backend;
                      setBackend(nextBackend);
                      const harness = available.find((h) => h.backend === nextBackend);
                      setModel(initialModel(harness ?? null));
                      setEffort("");
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
                  >
                    {/* A controlled select with no matching option still
                        *displays* its first one, so an unseeded `backend` read
                        as a choice the state did not actually hold. */}
                    <option value="">Choose a backend…</option>
                    {available.map((h) => (
                      <option key={h.backend} value={h.backend}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model" htmlFor="add-agent-model">
                  <select
                    id="add-agent-model"
                    data-testid="add-agent-model"
                    value={model}
                    onChange={(e) => { setModel(e.target.value); setEffort(""); }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
                  >
                    {(currentHarness?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {efforts.length > 0 ? <Field label="Effort" htmlFor="add-agent-effort"><select id="add-agent-effort" data-testid="add-agent-effort" value={effort} onChange={(event) => setEffort(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"><option value="">Backend default</option>{efforts.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field> : null}

              <Field label="Display name" htmlFor="add-agent-name">
                <input
                  id="add-agent-name"
                  data-testid="add-agent-name-input"
                  type="text"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setError(null);
                  }}
                  placeholder="Name this agent"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
                />
              </Field>

              <Field label="Mention name" htmlFor="add-agent-mention">
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">@</span>
                  <input
                    id="add-agent-mention"
                    data-testid="add-agent-mention-input"
                    type="text"
                    value={mentionName}
                    onChange={(e) => {
                      setMentionEdited(true);
                      setMentionName(e.target.value.toLowerCase());
                      setError(null);
                    }}
                    placeholder="mention-name"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring"
                  />
                </div>
              </Field>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  data-testid="add-agent-lead"
                  checked={makeLead}
                  onChange={(e) => setMakeLead(e.target.checked)}
                />
                Make this the lead agent
              </label>

              <Field label="Description (shown in its info card)" htmlFor="add-agent-description">
                <Textarea
                  id="add-agent-description"
                  data-testid="add-agent-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this agent is for…"
                  rows={2}
                  className="min-h-16 rounded-md border border-input bg-background px-3 py-2"
                />
              </Field>


            </>
          )}

          {error !== null ? (
            <p data-testid="add-agent-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            data-testid="add-agent-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting || available.length === 0}
          >
            {submitting ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
