/**
 * Settings ▸ Sharing (P15).
 *
 * Two halves, both driven by main: exporting a session to a file, and importing
 * one back. The renderer never sees a filesystem path, the file's bytes or the
 * bundle itself — it holds an opaque handle and a small preview, and main keeps
 * the payload in its worker until a commit or a cancel retires it.
 *
 * Three things this page is careful about:
 *
 *  - **Sizes are measured, not estimated.** The preview carries the exact
 *    encoded byte count of each format. When HTML will not fit, the page says
 *    so *before* opening a save dialog and offers the JSON that was already
 *    reviewed, rather than discovering the limit after a file write.
 *  - **Handles are released.** A staged export or import holds worker memory,
 *    so leaving the page, closing the panel, switching session or hitting an
 *    error cancels the handle it was holding.
 *  - **Sender claims are labelled.** An incoming bundle's tallies of what it
 *    left out are the sender's word; the preview shows them as claims.
 */
import { useState } from "react";
import { DownloadIcon, FileJsonIcon, FileTextIcon, UploadIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type {
  ShareComment,
  ShareEntry,
  ShareExportPreview,
  ShareImportPreview,
  ShareOmissionClaim,
  ShareSaveResult,
} from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  RowError,
  SectionIntro,
  SettingSelect,
  SettingToggle,
  SettingsCard,
} from "@/components/settings/primitives";
import {
  SHARE_PAGE,
  useStagedShare,
  type StagedPages,
  type StagedShare,
} from "@/components/settings/useStagedShare";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function SharingSection() {
  return (
    <div data-testid="settings-sharing" className="flex flex-col gap-8">
      <SectionIntro
        title="Sharing"
        description="Export a session as a file someone else can read, or open one you were sent."
      />
      <ExportPanel />
      <ImportPanel />
    </div>
  );
}

// -- Export -------------------------------------------------------------------

function ExportPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const [sessionId, setSessionId] = useState("");
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [saved, setSaved] = useState<ShareSaveResult | null>(null);
  const staged = useStagedShare<ShareExportPreview>("export");

  async function stage() {
    if (sessionId === "") return;
    setSaved(null);
    await staged.stage(async () => {
      const preview = await ipc().invoke("sharing.export.preview", { sessionId, includeReasoning });
      return { handle: preview.handle, preview };
    });
  }

  async function save(format: "json" | "html") {
    const result = await staged.exclusive(
      (handle) => ipc().invoke("sharing.export.save", { handle, format }),
      // A cancelled dialog returns null and is not a failure: the reviewed
      // snapshot survives so another format can still be written from it.
      { consumes: false, keepOn: (value) => value === null },
    );
    if (result != null) setSaved(result);
  }

  /** Any change to what would be exported retires the snapshot that answered
   *  the old question, rather than leaving a stale preview on screen. */
  function reset(): void {
    staged.discard();
    setSaved(null);
  }

  const live = sessions.filter((s) => !s.archived);

  return (
    <SettingsCard title="Export a session" testId="share-export">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Session</span>
            <SettingSelect
              value={sessionId}
              onChange={(value) => {
                setSessionId(value);
                reset();
              }}
              options={[
                { value: "", label: live.length === 0 ? "No sessions yet" : "Select a session…" },
                ...live.map((s) => ({ value: s.id, label: s.title || "Untitled session" })),
              ]}
              data-testid="share-export-session"
              aria-label="Session to export"
            />
          </label>
          <Button
            size="sm"
            disabled={sessionId === "" || staged.busy}
            data-testid="share-export-stage"
            onClick={() => void stage()}
          >
            {staged.busy && staged.preview === null ? "Preparing…" : "Prepare export"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-weak pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Include reasoning</p>
            <p className="text-xs text-muted-foreground">
              Off by default. Reasoning is the model&apos;s working, not its answer, and it is
              never shared unless you turn this on.
            </p>
          </div>
          <SettingToggle
            checked={includeReasoning}
            onChange={(value) => {
              setIncludeReasoning(value);
              // The staged snapshot was projected under the old setting, so it
              // no longer answers the question being asked.
              reset();
            }}
            data-testid="share-export-reasoning"
            aria-label="Include reasoning in the export"
          />
        </div>

        {saved ? (
          <p data-testid="share-export-saved" className="text-sm text-success">
            Saved {saved.fileName} ({formatBytes(saved.bytes)}).
          </p>
        ) : null}
        {staged.error ? <RowError message={staged.error} testId="share-export-error" /> : null}

        {staged.preview ? (
          <ExportPreview preview={staged.preview} staged={staged} onSave={(f) => void save(f)} />
        ) : null}
      </div>
    </SettingsCard>
  );
}

function ExportPreview({
  preview,
  staged,
  onSave,
}: {
  preview: ShareExportPreview;
  staged: StagedShare<ShareExportPreview>;
  onSave: (format: "json" | "html") => void;
}) {
  return (
    <div data-testid="share-export-preview" className="flex flex-col gap-3 border-t border-border-weak pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{preview.origin}</Badge>
        <span className="text-sm text-foreground">{preview.source.title ?? "Untitled session"}</span>
        <span className="text-xs text-muted-foreground">
          {preview.entryCount} entries · {preview.commentCount} comments
        </span>
        {preview.includesReasoning ? (
          <Badge variant="warning" data-testid="share-export-includes-reasoning">
            includes reasoning
          </Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        This is a fixed snapshot. Editing the session from here on does not change what these
        buttons will write.
      </p>

      <OmissionClaims omissions={preview.omissions} testId="share-export-omissions" />

      <div className="flex flex-col gap-2">
        <FormatRow
          icon={<FileJsonIcon className="size-4 shrink-0" aria-hidden />}
          label="JSON"
          size={preview.json}
          busy={staged.busy}
          testId="json"
          onSave={() => onSave("json")}
        />
        <FormatRow
          icon={<FileTextIcon className="size-4 shrink-0" aria-hidden />}
          label="Web page"
          size={preview.html}
          busy={staged.busy}
          testId="html"
          onSave={() => onSave("html")}
        />
        {!preview.html.withinLimit ? (
          <p data-testid="share-export-html-fallback" className="text-xs text-muted-foreground">
            The web page would be {formatBytes(preview.html.bytes)}, over the{" "}
            {formatBytes(preview.html.limit)} limit, so it cannot be written. The JSON above is the
            same reviewed content and{" "}
            {preview.json.withinLimit ? "does fit" : "is also over its own separate limit"}.
          </p>
        ) : null}
      </div>

      <PagedPreview
        staged={staged}
        entryTotal={preview.entryCount}
        commentTotal={preview.commentCount}
        testId="share-export"
      />

      <Button size="sm" variant="outline" className="w-fit" data-testid="share-export-discard" onClick={staged.discard}>
        Discard this export
      </Button>
    </div>
  );
}

function FormatRow({
  icon,
  label,
  size,
  busy,
  testId,
  onSave,
}: {
  icon: React.ReactNode;
  label: string;
  size: ShareExportPreview["json"];
  busy: boolean;
  testId: string;
  onSave: () => void;
}) {
  return (
    <div
      data-testid={`share-export-format-${testId}`}
      className="flex items-center justify-between gap-3 rounded-md border border-border-weak px-3 py-2"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {icon}
        <span className="text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground" data-testid={`share-export-size-${testId}`}>
          {formatBytes(size.bytes)} of {formatBytes(size.limit)}
        </span>
        {!size.withinLimit ? (
          <Badge variant="destructive" data-testid={`share-export-over-${testId}`}>
            over the limit
          </Badge>
        ) : null}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !size.withinLimit}
        data-testid={`share-export-save-${testId}`}
        onClick={onSave}
      >
        <DownloadIcon className="size-3.5" aria-hidden />
        Save
      </Button>
    </div>
  );
}

// -- Import -------------------------------------------------------------------

function ImportPanel() {
  const navigate = useNavigate();
  const projectId = useAppStore((s) => s.selectedProjectId);
  const staged = useStagedShare<ShareImportPreview>("import");

  async function pick() {
    if (projectId === null) return;
    await staged.stage(async () => {
      const preview = await ipc().invoke("sharing.import.pick", { projectId });
      // Null is a cancelled file dialog; the hook treats it as "nothing staged".
      return preview === null ? null : { handle: preview.handle, preview };
    });
  }

  async function commit() {
    const result = await staged.exclusive(
      (handle) => ipc().invoke("sharing.import.commit", { handle }),
      // Commit consumes the handle in main, so it must not be cancelled here.
      { consumes: true },
    );
    if (result !== undefined) navigate(`/c/${result.session.id}`);
  }

  const preview = staged.preview;

  return (
    <SettingsCard title="Open a shared session" testId="share-import">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          A received bundle is read-only. It cannot resume a conversation, run a tool or configure
          a backend.
        </p>

        {projectId === null ? (
          <p data-testid="share-import-no-project" className="text-sm text-muted-foreground">
            Select a project first — an imported session has to belong to one.
          </p>
        ) : (
          <Button
            size="sm"
            className="w-fit"
            disabled={staged.busy}
            data-testid="share-import-pick"
            onClick={() => void pick()}
          >
            <UploadIcon className="size-3.5" aria-hidden />
            {staged.busy && preview === null ? "Opening…" : "Choose a file"}
          </Button>
        )}

        {staged.error ? <RowError message={staged.error} testId="share-import-error" /> : null}

        {preview ? (
          <div data-testid="share-import-preview" className="flex flex-col gap-3 border-t border-border-weak pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-foreground">
                {preview.source.title ?? "Shared session"}
              </span>
              <span className="text-xs text-muted-foreground">
                {preview.entryCount} entries · {preview.commentCount} comments · sent{" "}
                {preview.createdAt}
              </span>
            </div>

            <p data-testid="share-import-claim-note" className="text-xs text-muted-foreground">
              Everything in this file was written by whoever sent it, including the participant
              names and the tallies below. Nothing here has been verified by this machine.
            </p>

            <OmissionClaims omissions={preview.omissions} testId="share-import-omissions" />

            {preview.existingSessionId ? (
              <p data-testid="share-import-duplicate" className="text-sm text-muted-foreground">
                This exact bundle is already open here. Committing will just take you to it.
              </p>
            ) : null}
            {preview.conflictingBundleId ? (
              <p role="alert" data-testid="share-import-conflict" className="text-sm text-destructive">
                A different bundle is already stored under this id, so this one cannot be imported.
                The same id must always carry the same content.
              </p>
            ) : null}

            <PagedPreview
              staged={staged}
              entryTotal={preview.entryCount}
              commentTotal={preview.commentCount}
              testId="share-import"
            />

            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={staged.busy || preview.conflictingBundleId === true}
                data-testid="share-import-commit"
                onClick={() => void commit()}
              >
                {preview.existingSessionId ? "Open the existing session" : "Add to this project"}
              </Button>
              <Button size="sm" variant="outline" data-testid="share-import-discard" onClick={staged.discard}>
                Discard
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

// -- Shared pieces ------------------------------------------------------------

function OmissionClaims({
  omissions,
  testId,
}: {
  omissions: ShareOmissionClaim[];
  testId: string;
}) {
  if (omissions.length === 0) return null;
  return (
    <ul data-testid={testId} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {omissions.map((claim) => (
        <li key={claim.kind} data-testid={`${testId}-${claim.kind}`}>
          <Badge variant="outline" className="mr-1.5">
            claimed
          </Badge>
          {claim.count} · {claim.description}
        </li>
      ))}
    </ul>
  );
}

/**
 * A page of entries and, separately, a page of comments.
 *
 * Comments get their own pager rather than riding along with the entries: a
 * bundle may carry up to a thousand of them, and showing the first twenty-five
 * with no way to reach the rest — and no honest total — misrepresents what is
 * in the file. Both pagers are bounded and both go through the same serial
 * handle, so neither can overlap the other.
 *
 * Entries render as text, never as markup: a bundle is a document from another
 * machine, and its contents are inert data.
 */
function PagedPreview({
  staged,
  entryTotal,
  commentTotal,
  testId,
}: {
  staged: StagedPages;
  entryTotal: number;
  commentTotal: number;
  testId: string;
}) {
  const { entries, comments, entryOffset, commentOffset, busy } = staged;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-md border border-border-weak p-2">
        {entries.length === 0 ? (
          <p data-testid={`${testId}-entries-empty`} className="p-2 text-sm text-muted-foreground">
            No entries.
          </p>
        ) : (
          entries.map((entry) => (
            <article key={entry.index} data-testid={`${testId}-entry-${entry.index}`} className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {entry.label} · {entry.kind}
              </p>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">
                {entry.text}
              </pre>
            </article>
          ))
        )}
      </div>

      <nav aria-label="Preview pages" className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || entryOffset === 0}
          data-testid={`${testId}-prev`}
          onClick={() => void staged.pageEntries(Math.max(0, entryOffset - SHARE_PAGE))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-range`}>
          {entryTotal === 0
            ? "No entries"
            : `${entryOffset + 1}–${Math.min(entryOffset + SHARE_PAGE, entryTotal)} of ${entryTotal}`}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || entryOffset + SHARE_PAGE >= entryTotal}
          data-testid={`${testId}-next`}
          onClick={() => void staged.pageEntries(entryOffset + SHARE_PAGE)}
        >
          Next
        </Button>
      </nav>

      {commentTotal > 0 ? (
        <details data-testid={`${testId}-comments`} className="rounded-md border border-border-weak px-3 py-2">
          <summary className="cursor-pointer text-sm text-foreground">
            Comments ({commentTotal})
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {comments.map((comment) => (
              <li key={comment.id} className="text-sm">
                <span className="text-xs text-muted-foreground">{comment.author} · </span>
                <span className="[overflow-wrap:anywhere]">{comment.body}</span>
              </li>
            ))}
          </ul>
          <nav aria-label="Comment pages" className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || commentOffset === 0}
              data-testid={`${testId}-comments-prev`}
              onClick={() => void staged.pageComments(Math.max(0, commentOffset - SHARE_PAGE))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-comments-range`}>
              {`${commentOffset + 1}–${Math.min(commentOffset + SHARE_PAGE, commentTotal)} of ${commentTotal}`}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || commentOffset + SHARE_PAGE >= commentTotal}
              data-testid={`${testId}-comments-next`}
              onClick={() => void staged.pageComments(commentOffset + SHARE_PAGE)}
            >
              Next
            </Button>
          </nav>
        </details>
      ) : null}
    </div>
  );
}
