/**
 * A received shared bundle, read (P15).
 *
 * A sibling of `ImportedTranscript`, not a variant of it. Both are read-only
 * artifacts and both carry `origin: "import"`, but they are stored in different
 * tables and described by different contracts, so the reader is selected by
 * `session.artifactKind` and this one talks to `sharing.*`. Pointing the native
 * reader at a bundle would ask `imports.get` for a row that does not exist.
 *
 * Everything the sender wrote is shown as *their claim*. A bundle is a file
 * from another machine: its title, its participant labels, its comment authors
 * and its tallies of what was left out were all written by whoever exported it,
 * and this machine verified none of them. The page says so once, plainly, and
 * labels the omission tallies as claims rather than facts.
 *
 * There is deliberately no Continue action. Fresh continuation from a shared
 * bundle is separate work; an action that looked available and then failed
 * would be worse than its absence.
 */
import { useEffect, useRef, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import type { ShareArtifact, ShareComment, ShareEntry } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocalNotes } from "@/components/LocalNotes";
import { SharedContinueDialog } from "@/components/SharedContinueDialog";
import { ipc } from "@/lib/ipc";

const PAGE = 50;

/** What each omission tally means, in the reader's words rather than a key. */
const OMISSION_LABEL: Record<string, string> = {
  droppedThinking: "reasoning",
  droppedInteractive: "questions and approvals",
  droppedWidgets: "widgets",
  droppedUsage: "usage figures",
  redactions: "redacted spans",
};

export function SharedTranscript({ sessionId }: { sessionId: string }) {
  /**
   * One snapshot, replaced whole.
   *
   * Held together with the session it describes: the metadata, entries and
   * comments used to be three independent states, so switching session left the
   * previous bundle's title, sender claims and comments on screen under the new
   * session's identity until each response landed. A snapshot tagged with its
   * own session is either current or not rendered at all.
   */
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    artifact: ShareArtifact | null;
    entries: ShareEntry[];
    comments: ShareComment[];
    entryOffset: number;
    commentOffset: number;
  } | null>(null);
  const [entryOffset, setEntryOffset] = useState(0);
  const [commentOffset, setCommentOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const request = useRef(0);

  // A new session starts at the top of both lists rather than at the previous
  // one's scroll position.
  useEffect(() => {
    setEntryOffset(0);
    setCommentOffset(0);
    setSnapshot(null);
  }, [sessionId]);

  useEffect(() => {
    const mine = (request.current += 1);
    let alive = true;
    setLoading(true);
    setError(null);
    // Serial reads: three concurrent calls are legal here (these are
    // session-scoped, not handle-scoped) but the artifact's counts bound the
    // pages, so the metadata is read first and used.
    void (async () => {
      try {
        const artifact = await ipc().invoke("sharing.get", { sessionId });
        const entries = await ipc().invoke("sharing.entries", { sessionId, offset: entryOffset, limit: PAGE });
        const comments = await ipc().invoke("sharing.comments", { sessionId, offset: commentOffset, limit: PAGE });
        if (!alive || request.current !== mine) return;
        setSnapshot({ sessionId, artifact, entries, comments, entryOffset, commentOffset });
      } catch (cause) {
        if (!alive || request.current !== mine) return;
        setSnapshot(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (alive && request.current === mine) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, entryOffset, commentOffset]);

  // Never render another session's answer under this session's identity.
  const current = snapshot?.sessionId === sessionId ? snapshot : null;
  const artifact = current?.artifact ?? null;
  const entries = current?.entries ?? [];
  const comments = current?.comments ?? [];
  const total = artifact?.entryCount ?? 0;
  const commentTotal = artifact?.commentCount ?? 0;
  const claims = artifact
    ? (Object.entries(OMISSION_LABEL) as [keyof typeof OMISSION_LABEL, string][])
        .map(([key, label]) => ({
          label,
          count: (artifact.counts as unknown as Record<string, number>)[key] ?? 0,
        }))
        .filter((row) => row.count > 0)
    : [];

  return (
    <div data-testid="shared-transcript" className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-normal tracking-[-0.02em]">
            {artifact?.source.title || "Shared session"}
          </h1>
          <Badge variant="outline" data-testid="shared-badge">shared bundle</Badge>
          <Badge variant="outline">read-only</Badge>
          <Button
            size="sm"
            variant="outline"
            data-testid="shared-continue-open"
            onClick={() => setContinuing(true)}
          >
            Continue in a new session
          </Button>
        </div>
        <SenderClaimNote artifact={artifact} />
      </header>

      {error ? (
        <p role="alert" data-testid="shared-error" className="rounded-lg border border-destructive/40 bg-card px-3.5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {claims.length > 0 ? (
        <section
          data-testid="shared-omissions"
          className="rounded-lg border border-border-weak bg-card/50 px-3.5 py-3 text-sm text-muted-foreground"
        >
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide">
            What the sender says was left out
          </p>
          <ul className="flex flex-col gap-0.5">
            {claims.map((row) => (
              <li key={row.label} data-testid={`shared-omission-${row.label.replace(/\s+/g, "-")}`}>
                {row.count} {row.label} — this machine cannot check what is not here.
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex min-w-0 flex-col gap-3">
        {loading && current === null ? (
          <p role="status" data-testid="shared-loading" className="text-sm text-muted-foreground">
            Loading transcript…
          </p>
        ) : entries.length === 0 ? (
          <p data-testid="shared-empty" className="text-sm text-muted-foreground">
            This bundle carries no entries.
          </p>
        ) : (
          entries.map((entry) => (
            <article
              key={entry.index}
              data-testid={`shared-entry-${entry.index}`}
              className="min-w-0 rounded-lg border border-border p-4"
            >
              <p className="mb-2 text-xs text-muted-foreground">
                {entry.label} · {entry.kind}
                {entry.at ? ` · ${entry.at}` : ""}
              </p>
              {/* Text, never markup: a bundle's contents are inert data from
                  another machine and are never rendered as HTML. */}
              <pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">
                {entry.text}
              </pre>
              {entry.truncated ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  The sender truncated this entry.
                </p>
              ) : null}
            </article>
          ))
        )}
      </section>

      <nav aria-label="Transcript pages" className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={loading || entryOffset === 0}
          data-testid="shared-prev"
          onClick={() => setEntryOffset(Math.max(0, entryOffset - PAGE))}
        >
          Previous
        </Button>
        <span className="text-sm" data-testid="shared-range">
          {total === 0 ? "No entries" : `${entryOffset + 1}–${Math.min(entryOffset + PAGE, total)} of ${total}`}
        </span>
        <Button
          variant="outline"
          disabled={loading || entryOffset + PAGE >= total}
          data-testid="shared-next"
          onClick={() => setEntryOffset(entryOffset + PAGE)}
        >
          Next
        </Button>
      </nav>

      <SharedComments
        comments={comments}
        total={commentTotal}
        offset={commentOffset}
        loading={loading}
        onPage={setCommentOffset}
      />
      <LocalNotes sessionId={sessionId} entryCount={total} />
      <SharedContinueDialog sessionId={sessionId} open={continuing} onOpenChange={setContinuing} />
    </div>
  );
}

function SenderClaimNote({ artifact }: { artifact: ShareArtifact | null }) {
  const agents = artifact?.source.agents ?? [];
  return (
    <p data-testid="shared-claim-note" className="text-sm text-muted-foreground">
      Everything below was written by whoever exported this bundle
      {agents.length > 0 ? (
        <>
          {" "}
          — the participant names (
          <span className="text-foreground">{agents.map((a) => a.label).join(", ")}</span>) are
          their labels, not verified identities
        </>
      ) : null}
      . Nothing here has been checked by this machine, and it cannot resume or run anything.
    </p>
  );
}

/**
 * The bundle's own comments, paged.
 *
 * Read-only and never authenticated: `author` is a display label the sender
 * typed. Paged rather than truncated — showing the first page with no way to
 * reach the rest misrepresents what the file contains.
 */
function SharedComments({
  comments,
  total,
  offset,
  loading,
  onPage,
}: {
  comments: ShareComment[];
  total: number;
  offset: number;
  loading: boolean;
  onPage: (offset: number) => void;
}) {
  if (total === 0) {
    return (
      <p data-testid="shared-comments-empty" className="text-sm text-muted-foreground">
        This bundle carries no comments.
      </p>
    );
  }
  return (
    <section data-testid="shared-comments" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <MessageSquareIcon className="size-3.5" aria-hidden />
        Comments from the sender ({total})
      </h2>
      <p className="text-xs text-muted-foreground">
        These names are labels the sender chose. They are not accounts and were not verified.
      </p>
      <ul className="flex flex-col gap-2">
        {comments.map((comment) => (
          <li
            key={comment.id}
            data-testid={`shared-comment-${comment.id}`}
            className="rounded-lg border border-border-weak bg-card px-3.5 py-2.5"
          >
            <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{comment.author}</span>
              <span>{comment.createdAt}</span>
              {comment.entryIndex === null ? (
                <Badge variant="outline">whole session</Badge>
              ) : (
                <Badge variant="outline">entry {comment.entryIndex}</Badge>
              )}
              {comment.replyToId ? <Badge variant="outline">reply</Badge> : null}
              {comment.resolved ? <Badge variant="success">resolved</Badge> : null}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
              {comment.body}
            </p>
          </li>
        ))}
      </ul>
      <nav aria-label="Comment pages" className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset === 0}
          data-testid="shared-comments-prev"
          onClick={() => onPage(Math.max(0, offset - PAGE))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="shared-comments-range">
          {`${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset + PAGE >= total}
          data-testid="shared-comments-next"
          onClick={() => onPage(offset + PAGE)}
        >
          Next
        </Button>
      </nav>
    </section>
  );
}
