/**
 * Diff pane (SPEC R16, item B2.4): `git.status`'s working-tree list with a
 * badge per entry, click → `git.diff`'s unified patch rendered with
 * `DiffView` (the same component the chat transcript's diff blocks use —
 * SPEC R6 already settled what a diff looks like in this app), and a
 * message box that commits everything currently changed
 * (`git.commit`, `paths` omitted). Matches `GithubPanel`'s status-list +
 * diff-body shape (`reference/omnigent/web/src/shell/GithubPanel.tsx`),
 * reimplemented against capygen's own contract.
 *
 * `projectId` not being a git repository at all is not an error
 * (`git.status`'s `null` — see `GitStatusSchema`'s doc comment) and gets its
 * own quiet message rather than the error banner.
 */
import { useCallback, useEffect, useState } from "react";
import { GitCommitHorizontalIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { GitDiff, GitStatus, GitStatusEntry } from "@capygen/shared";
import { DiffView } from "@/components/blocks/DiffCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

type BadgeVariant = "default" | "outline" | "success" | "warning" | "destructive" | "info";

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

  const loadStatus = useCallback(async () => {
    try {
      const result = await ipc().invoke("git.status", { projectId });
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const unsubscribe = ipc().on("fs.changed", (event) => {
      if (event.projectId !== projectId) return;
      void loadStatus();
    });
    return unsubscribe;
  }, [projectId, loadStatus]);

  async function selectEntry(entry: GitStatusEntry): Promise<void> {
    setSelected(entry.path);
    setDiff(null);
    setError(null);
    try {
      const diffs = await ipc().invoke("git.diff", { projectId, path: entry.path });
      setDiff(diffs[0] ?? { path: entry.path, unified: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function commit(): Promise<void> {
    const trimmed = message.trim();
    if (trimmed === "") return;
    setCommitting(true);
    setError(null);
    try {
      await ipc().invoke("git.commit", { projectId, message: trimmed });
      setMessage("");
      setSelected(null);
      setDiff(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

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
                  <li key={entry.path}>
                    <button
                      type="button"
                      data-testid="diff-status-row"
                      data-path={entry.path}
                      aria-pressed={selected === entry.path}
                      onClick={() => void selectEntry(entry)}
                      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent/40 ${
                        selected === entry.path ? "bg-accent/60" : ""
                      }`}
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
            {selected && diff ? (
              <DiffView
                path={diff.path}
                patch={diff.unified}
                {...countChanges(diff.unified)}
                testId="diff-pane-view"
              />
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
              disabled={committing || message.trim() === "" || status.entries.length === 0}
              data-testid="diff-commit-submit"
              onClick={() => void commit()}
            >
              {committing ? <Loader2Icon className="size-3.5 animate-spin" /> : "Commit"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

registerPane({ kind: "diff", title: "Diff", icon: GitCommitHorizontalIcon, component: DiffPane });
