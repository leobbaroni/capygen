/**
 * Small shared building blocks every Settings ▸ * section is built from —
 * kept here rather than duplicated per section (`HarnessConfigControls.tsx`'s
 * `ConfigRow` in the reference plays the same role, adapted to capygen's
 * hand-rolled `ui/*` primitives instead of Radix Select/Switch, which this
 * codebase does not depend on — see `ui/dialog.tsx`'s doc comment for why).
 */
import type { ReactNode } from "react";
import { CircleAlertIcon, Folder, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

/** Section heading + one-line description, the same shape every section opens with. */
export function SectionIntro({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-medium text-foreground">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** A labelled configuration row: label + sub-description on the left, the control on the right. */
export function ConfigRow({
  label,
  description,
  children,
  testId,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-1.5 border-b border-border-weak py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
    >
      <div className="min-w-0 sm:pt-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      <div className="w-full shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

/** Plain `<select>` styled to match the rest of the hub — no Radix dependency (see above). */
export function SettingSelect({
  value,
  onChange,
  options,
  "data-testid": testId,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  "data-testid"?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      aria-label={ariaLabel}
      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A single-line text input, styled to match. */
export function SettingInput({
  value,
  onChange,
  placeholder,
  "data-testid": testId,
  "aria-label": ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "data-testid"?: string;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-foreground-tertiary focus:border-ring",
        className,
      )}
    />
  );
}

/** Hand-rolled switch (no Radix `Switch`) — a labelled checkbox styled as a toggle track. */
export function SettingToggle({
  checked,
  onChange,
  "data-testid": testId,
  "aria-label": ariaLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  "data-testid"?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-secondary",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** Used by every section that ports an Omnigent surface capygen has not built
 *  yet (Import, Updates, Members, Policies, Sharing) — SPEC R19's own nav
 *  list plus Task B2's instruction to "render the reference layout with a
 *  clear 'arrives with …' note and no dead controls." */
export function ArrivesLaterNote({ phase, what }: { phase: string; what: string }) {
  return (
    <div
      data-testid="arrives-later-note"
      className="flex items-start gap-2.5 rounded-lg border border-dashed border-border bg-card/50 px-3.5 py-3 text-sm text-muted-foreground"
    >
      <CircleAlertIcon className="size-4 shrink-0 translate-y-0.5" />
      <p>
        {what} arrives with <span className="font-medium text-foreground">{phase}</span>. This
        page shows the reference layout now so the section is not empty; nothing here is wired to
        a real backend yet.
      </p>
    </div>
  );
}

/**
 * Which project the integrations sections on this page are reading and writing
 * (Phase 7-P0).
 *
 * The scope is explicit now — this window sends its selected project id on
 * every `integrations.*` call and the main process resolves nothing by
 * recency — so the page has to say which project that is. Without a project
 * selected the sections show the **global** configuration only, which is a
 * different (and correct) answer rather than a missing one, and the note says
 * so instead of leaving the user to guess.
 */
export function SelectedProjectNote() {
  const projectId = useAppStore((s) => s.selectedProjectId);
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  return (
    <p
      data-testid="settings-scope-note"
      data-project-id={project?.id ?? ""}
      className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Folder className="ui-icon shrink-0" aria-hidden />
      {project ? (
        <>
          <span>Project:</span>
          <span className="max-w-80 truncate font-medium text-foreground" title={project.path}>
            {project.name}
          </span>
        </>
      ) : (
        <span>No project selected — showing the global configuration only.</span>
      )}
    </p>
  );
}

export function SectionLoading() {
  return (
    <div data-testid="section-loading" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      Loading…
    </div>
  );
}

export function SectionError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      data-testid="section-error"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-card px-3.5 py-3 text-sm text-destructive"
    >
      <CircleAlertIcon className="size-4 shrink-0 translate-y-0.5" />
      {message}
    </div>
  );
}

/**
 * The message an inline row action failed with.
 *
 * [review] Every inline button in the hub used to be `onClick={() => void
 * remove(entry)}` — an unhandled rejection, a row that did not change, and
 * nothing on screen. A store refusing a write (a plugin-scope MCP server, an
 * inherited `api` row, a Codex project scope) is a normal answer, not an
 * impossible one, so it is rendered next to the control that asked.
 */
export function RowError({ message, testId }: { message: string; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * "synced 12s ago" + a Refresh button, for the sections whose truth lives in a
 * backend's files (SPEC R29).
 *
 * [review] `useIntegrations.refreshFromBackend` and `integrations.list`'s
 * `lastSync` both existed and neither was rendered anywhere, so a watcher that
 * missed a change left the user with no way to ask again and no way to tell
 * how old the list was — both of which Claude Code's own `/mcp` gives.
 */
export function SyncStatus({
  lastSync,
  onRefresh,
  busy,
  testId,
}: {
  lastSync: number | null | undefined;
  onRefresh: () => void;
  busy?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span data-testid={testId ? `${testId}-age` : undefined} className="text-xs text-muted-foreground">
        {lastSync ? `Synced ${relativeTime(lastSync)}` : "Not synced yet"}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onRefresh}
        data-testid={testId ? `${testId}-button` : undefined}
        className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

/** Coarse on purpose: this line answers "is the list stale?", not "when exactly". */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** A card wrapping one logical group of rows (a backend's Defaults, one MCP server, …). */
export function SettingsCard({
  title,
  subtitle,
  action,
  children,
  testId,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-lg border border-border-weak bg-card px-4 py-3.5"
    >
      {title ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{title}</p>
            {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
