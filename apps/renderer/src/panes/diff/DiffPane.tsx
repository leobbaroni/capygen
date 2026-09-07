/**
 * Diff pane (SPEC R16, item B2.4): `git.status`'s working-tree list with a
 * badge and a tick-box per entry, click → the file's patch rendered with
 * `DiffView` (the same component the chat transcript's diff blocks use —
 * SPEC R6 already settled what a diff looks like in this app), and a message
 * box that commits **the ticked files** (`git.commit`'s `paths`, which the
 * service `git add`s first, so a brand-new file is committable from here).
 * Matches `GithubPanel`'s status-list + diff-body shape
 * (`reference/omnigent/web/src/shell/GithubPanel.tsx`), reimplemented against
 * capygen's own contract.
 *
 * [C] Three things the naive version got wrong, all of them "the pane says
 * nothing is there when something is":
 *   - it committed with `paths` omitted, i.e. `git commit --all`, while the
 *     list showed one row selected — every modified tracked file went in,
 *     including files the user never looked at, and a working tree of only
 *     untracked files had nothing to commit at all;
 *   - `git diff -- <path>` prints nothing for an **untracked** file, so a new
 *     file rendered as an empty `+0 −0` card. Untracked entries are read
 *     through `fs.read` and shown as an all-added patch instead;
 *   - the `staged` flag exists on the contract and was never sent, so
 *     anything already `git add`-ed rendered empty too. A tracked file whose
 *     working tree is clean is now asked for its staged half before being
 *     called unchanged. (Which half it *is* cannot be read off
 *     `GitStatusEntry.status`: `GitService.status` joins and trims git's two
 *     porcelain columns, so " M" and "M " both arrive as "M". Asking for both
 *     needs no contract change and gives the same answer.)
 *   - a binary change was `unified: ""` plus `binary: true`, and the pane read
 *     only the first half — so a changed PNG also rendered as `+0 −0`.
 *
 * `projectId` not being a git repository at all is not an error
 * (`git.status`'s `null` — see `GitStatusSchema`'s doc comment) and gets its
 * own quiet message rather than the error banner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GitCommitHorizontalIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { GitDiff, GitStatus, GitStatusEntry } from "@capygen/shared";
import { DiffView } from "@/components/blocks/DiffCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

type BadgeVariant = "default" | "outline" | "success" | "warning" | "destructive" | "info";

/** How long a burst of `fs.changed` batches is allowed to pile up before one
 *  `git status` runs. `FsService` already emits at most one batch per 250 ms;
 *  without this, sustained file activity spawned one `git.exe` per batch. */
const REFRESH_DEBOUNCE_MS = 300;

function isUntracked(status: string): boolean {
  return status.includes("?");
}

/** An all-added unified patch for a file git will not diff (an untracked
 *  one): the same shape `DiffView` renders for a real patch, built from the
 *  bytes `fs.read` returns. */
function patchForNewFile(path: string, content: string): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return [
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function statusMeta(status: string): { label: string; variant: BadgeVariant } {
  const code = status.trim();
  if (code === "") return { label: "Changed", variant: "default" };
  if (code.includes("?")) return { label: "Untracked", variant: "success" };
  if (code.includes("A")) return { label: "Added", variant: "success" };
  if (code.includes("D")) return { label: "Deleted", variant: "destructive" };
  if (code.includes("R")) return { label: "Renamed", variant: "info" };
  if (code.includes("M")) return { label: "Modified", variant: "warning" };
  return { label: code, variant: "default" };
}

function countChanges(unified: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of unified.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function DiffPane({ params }: WorkspacePaneProps) {
  const { projectId } = params;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which rows go into the next commit. Until the user touches a checkbox
   *  every entry is ticked, so the default is still "commit what I changed" —
   *  visibly, and untickable. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  /** Set the first time the user ticks or unticks anything. After that a
   *  refresh keeps their selection and a newly discovered file arrives
   *  *unticked*: silently adding one would commit a file they never saw. */
  const userChose = useRef(false);
  /** Rising id per `git.status` request; a response from an older one is
   *  dropped rather than allowed to overwrite a newer working tree (the same
   *  guard `FilesPane`'s search uses). */
  const statusSeq = useRef(0);
  /** The same guard for `git.diff`/`fs.read`: clicking b while a is in flight
   *  must not render a's patch under b's name. */
  const diffSeq = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The project every in-flight request and the current selection belong to.
   *  Read at commit time so a selection made before a project switch can never
   *  be sent against the new project. */
  const activeProject = useRef(projectId);
  const projectEpoch = useRef(0);

  const loadStatus = useCallback(async () => {
    const seq = ++statusSeq.current;
    try {
      const result = await ipc().invoke("git.status", { projectId });
      // Stale, or answered after the pane moved to another project: dropping it
      // is what stops one project's file list appearing under another's name.
      if (statusSeq.current !== seq || activeProject.current !== projectId) return;
      setStatus(result);
      const paths = (result?.entries ?? []).map((entry) => entry.path);
      setChecked((prev) =>
        userChose.current
          ? // Keep what is still there, drop what git no longer reports, add
            // nothing: a file that appeared since the user chose stays off.
            new Set(paths.filter((path) => prev.has(path)))
          : new Set(paths),
      );
      setError(null);
    } catch (err) {
      if (statusSeq.current !== seq || activeProject.current !== projectId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (statusSeq.current === seq && activeProject.current === projectId) setLoaded(true);
    }
  }, [projectId]);

  // A different project is a different working tree: every piece of state here
  // describes the old one. Invalidating the sequence numbers also discards any
  // response still in flight for it.
  useEffect(() => {
    activeProject.current = projectId;
    projectEpoch.current += 1;
    setCommitting(false);
    statusSeq.current += 1;
    diffSeq.current += 1;
    userChose.current = false;
    setStatus(null);
    setLoaded(false);
    setChecked(new Set());
    setSelected(null);
    setDiff(null);
    setMessage("");
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // [C] Debounced, because every `git.status` is an OS process spawn
  // (simple-git runs the user's real `git.exe`). `FsService` flushes a batch
  // roughly every 250 ms under sustained activity — a formatter, a build
  // writing outside the ignore list — and the undebounced version answered
  // each one with its own `git status`, unbounded and overlapping.
  useEffect(() => {
    const unsubscribe = ipc().on("fs.changed", (event) => {
      if (event.projectId !== projectId) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void loadStatus();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [projectId, loadStatus]);

  /**
   * The patch for one row. An untracked file is read rather than diffed
   * (git prints nothing for it); a tracked file whose working tree is clean
   * is asked for its *staged* half before being called unchanged.
   */
  async function selectEntry(entry: GitStatusEntry): Promise<void> {
    const seq = ++diffSeq.current;
    const forProject = projectId;
    const fresh = (): boolean => diffSeq.current === seq && activeProject.current === forProject;
    setSelected(entry.path);
    setDiff(null);
    setError(null);
    try {
      if (isUntracked(entry.status)) {
        const file = await ipc().invoke("fs.read", { projectId, path: entry.path });
        if (!fresh()) return;
        setDiff({
          path: entry.path,
          unified: file.binary ? "" : patchForNewFile(entry.path, file.content),
          ...(file.binary ? { binary: true } : {}),
        });
        return;
      }
      const worktree = await ipc().invoke("git.diff", { projectId, path: entry.path });
      if (!fresh()) return;
      const first = worktree[0];
      if (first && (first.unified !== "" || first.binary)) {
        setDiff(first);
        return;
      }
      const staged = await ipc().invoke("git.diff", {
        projectId,
        path: entry.path,
        staged: true,
      });
      if (!fresh()) return;
      setDiff(staged[0] ?? { path: entry.path, unified: "" });
    } catch (err) {
      if (!fresh()) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleChecked(path: string): void {
    userChose.current = true;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function commit(): Promise<void> {
    const trimmed = message.trim();
    // Derived from the rendered list, so only paths git currently reports can
    // be sent — and `activeProject` pins them to the project they were chosen
    // in, so a switch mid-edit cannot commit them against the new one.
    const forProject = activeProject.current;
    const epoch = projectEpoch.current;
    const fresh = () => activeProject.current === forProject && projectEpoch.current === epoch;
    const paths = (status?.entries ?? [])
      .map((entry) => entry.path)
      .filter((path) => checked.has(path));
    if (trimmed === "" || paths.length === 0 || forProject !== projectId) return;
    setCommitting(true);
    setError(null);
    try {
      // Named paths, never `--all`: `GitService.commit` stages exactly these
      // first, which is also what makes an untracked file committable here.
      await ipc().invoke("git.commit", { projectId: forProject, message: trimmed, paths });
      if (!fresh()) return;
      setMessage("");
      setSelected(null);
      setDiff(null);
      await loadStatus();
    } catch (err) {
      if (fresh()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fresh()) setCommitting(false);
    }
  }

  const checkedCount = (status?.entries ?? []).filter((entry) => checked.has(entry.path)).length;

  return (
    <div className="flex h-full flex-col" data-testid="diff-pane">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-weak px-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" data-testid="diff-branch">
          {status ? status.branch : loaded ? "Not a git repository" : "Loading…"}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) ? (
          <span className="shrink-0 tabular-nums">
            {status.ahead > 0 ? `↑${status.ahead}` : ""} {status.behind > 0 ? `↓${status.behind}` : ""}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh"
          data-testid="diff-refresh"
          onClick={() => void loadStatus()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {error ? (
        <p role="alert" data-testid="diff-error" className="shrink-0 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {!status ? (
        loaded ? (
          <p className="px-2 py-3 text-xs text-muted-foreground" data-testid="diff-not-a-repo">
            This project is not a git repository.
          </p>
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
        )
      ) : (
        <>
          <ul
            className="max-h-40 shrink-0 overflow-y-auto border-b border-border-weak"
            data-testid="diff-status-list"
          >
            {status.entries.length === 0 ? (
              <li className="px-2 py-2 text-xs text-muted-foreground">No changes.</li>
            ) : (
              status.entries.map((entry) => {
                const meta = statusMeta(entry.status);
                return (
                  <li
                    key={entry.path}
                    className={`flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-accent/40 ${
                      selected === entry.path ? "bg-accent/60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(entry.path)}
                      onChange={() => toggleChecked(entry.path)}
                      aria-label={`Include ${entry.path} in the commit`}
                      data-testid="diff-status-check"
                      data-path={entry.path}
                      className="size-3 shrink-0 accent-[var(--brand-accent)]"
                    />
                    <button
                      type="button"
                      data-testid="diff-status-row"
                      data-path={entry.path}
                      aria-pressed={selected === entry.path}
                      onClick={() => void selectEntry(entry)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">{entry.path}</span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="diff-body">
            {selected && diff?.binary ? (
              <p className="text-xs text-muted-foreground" data-testid="diff-binary-notice">
                {diff.path} — binary file, not shown.
              </p>
            ) : selected && diff ? (
              <>
                <DiffView
                  path={diff.path}
                  patch={diff.unified}
                  {...countChanges(diff.unified)}
                  testId="diff-pane-view"
                />
                {diff.unified === "" ? (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="diff-empty-notice">
                    No textual changes in the working tree or the index.
                  </p>
                ) : null}
              </>
            ) : selected ? (
              <p className="text-xs text-muted-foreground">Loading diff…</p>
            ) : (
              <p className="text-xs text-muted-foreground">Select a file to see its diff.</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 border-t border-border-weak p-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message…"
              aria-label="Commit message"
              data-testid="diff-commit-message"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
            />
            <Button
              size="sm"
              // Enabled only when there is something ticked to commit — the
              // old `entries.length > 0` let an untracked-only tree arm a
              // `git commit -a` that could only ever fail.
              disabled={committing || message.trim() === "" || checkedCount === 0}
              data-testid="diff-commit-submit"
              onClick={() => void commit()}
            >
              {committing ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                `Commit ${checkedCount}`
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

registerPane({ kind: "diff", title: "Diff", icon: GitCommitHorizontalIcon, component: DiffPane });
