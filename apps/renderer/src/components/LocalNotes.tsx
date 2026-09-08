/**
 * Notes this machine wrote on a session (P15).
 *
 * Distinct from the sender's own comments in every way that matters: these are
 * editable, they are stored in a separate table, and writing one cannot change
 * the artifact's content identity — so a re-import of the same file is still a
 * duplicate afterwards. The two are rendered apart, and labelled apart, because
 * conflating "what they said" with "what we wrote" is exactly the confusion a
 * reviewer cannot afford.
 *
 * The author is main's to decide. There is no name field here: a note is
 * written by whoever is operating this machine, and letting the renderer supply
 * an author would make the label a claim rather than a fact about where the
 * note came from. It is still an unauthenticated display label, and the note
 * says so once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PencilIcon, ReplyIcon } from "lucide-react";
import type { LocalNoteAnchorDto, LocalNoteDto } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

const PAGE = 25;

export interface LocalNotesProps {
  sessionId: string;
  /** Bounds an entry anchor, so a note cannot be filed past the artifact's end. */
  entryCount: number;
  /** Set when replying to one of the sender's comments. */
  replyTo?: { receivedId: string; author: string } | null;
  onReplyHandled?: () => void;
}

export function LocalNotes({ sessionId, entryCount, replyTo, onReplyHandled }: LocalNotesProps) {
  const [notes, setNotes] = useState<LocalNoteDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<LocalNoteAnchorDto>({ kind: "session" });
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (at: number) => {
      const mine = (request.current += 1);
      try {
        const page = await ipc().invoke("sharing.notes.list", { sessionId, offset: at, limit: PAGE });
        // A page for a session we have since left must not land here.
        if (request.current !== mine) return;
        setNotes(page.notes);
        setTotal(page.total);
        setOffset(at);
        setError(null);
      } catch (cause) {
        if (request.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setOffset(0);
    setNotes([]);
    setTotal(0);
    void load(0);
  }, [sessionId, load]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load(offset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const body = draft.trim();

  return (
    <section data-testid="local-notes" className="flex flex-col gap-2 border-t border-border-weak pt-4">
      <h2 className="text-sm font-medium text-foreground">Your notes ({total})</h2>
      <p className="text-xs text-muted-foreground">
        Notes you write here stay on this machine. They are not part of the received bundle and do
        not change it.
      </p>

      {error ? (
        <p role="alert" data-testid="local-notes-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {notes.map((note) => (
          <li
            key={note.id}
            data-testid={`local-note-${note.id}`}
            className="rounded-lg border border-border-weak bg-card px-3.5 py-2.5"
          >
            <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{note.authorLabel}</span>
              <Badge variant="outline">yours</Badge>
              {note.anchor.kind === "entry" ? (
                <Badge variant="outline">entry {note.anchor.entryIndex}</Badge>
              ) : note.anchor.kind === "block" ? (
                <Badge variant="outline">message</Badge>
              ) : (
                <Badge variant="outline">whole session</Badge>
              )}
              {note.replyToReceivedId ? (
                <Badge variant="outline" data-testid={`local-note-reply-${note.id}`}>
                  reply to sender
                </Badge>
              ) : null}
              {note.resolved ? <Badge variant="success">resolved</Badge> : null}
            </p>

            {editing?.id === note.id ? (
              <div className="flex flex-col gap-1.5">
                <textarea
                  value={editing.body}
                  onChange={(event) => setEditing({ id: note.id, body: event.target.value })}
                  aria-label={`Edit your note`}
                  data-testid={`local-note-edit-${note.id}`}
                  className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={busy || editing.body.trim() === ""}
                    data-testid={`local-note-save-${note.id}`}
                    onClick={() =>
                      void run(async () => {
                        await ipc().invoke("sharing.notes.update", {
                          noteId: note.id, body: editing.body.trim(),
                        });
                        setEditing(null);
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                {note.body}
              </p>
            )}

            {editing?.id === note.id ? null : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid={`local-note-edit-open-${note.id}`}
                  onClick={() => setEditing({ id: note.id, body: note.body })}
                >
                  <PencilIcon className="size-3" aria-hidden />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid={`local-note-resolve-${note.id}`}
                  onClick={() =>
                    void run(() =>
                      ipc().invoke("sharing.notes.update", {
                        noteId: note.id, resolved: !note.resolved,
                      }),
                    )
                  }
                >
                  {note.resolved ? "Reopen" : "Resolve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid={`local-note-delete-${note.id}`}
                  onClick={() => void run(() => ipc().invoke("sharing.notes.remove", { noteId: note.id }))}
                >
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {total > PAGE ? (
        <nav aria-label="Note pages" className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || offset === 0}
            data-testid="local-notes-prev"
            onClick={() => void load(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="local-notes-range">
            {`${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || offset + PAGE >= total}
            data-testid="local-notes-next"
            onClick={() => void load(offset + PAGE)}
          >
            Next
          </Button>
        </nav>
      ) : null}

      <div className="flex flex-col gap-1.5 rounded-lg border border-border-weak px-3.5 py-2.5">
        {replyTo ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="local-notes-replying">
            <ReplyIcon className="size-3" aria-hidden />
            Replying to {replyTo.author}&apos;s comment
            <button
              type="button"
              className="underline underline-offset-2"
              data-testid="local-notes-reply-cancel"
              onClick={() => onReplyHandled?.()}
            >
              cancel
            </button>
          </p>
        ) : null}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a note for yourself"
          aria-label="New note"
          data-testid="local-notes-draft"
          className="min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-foreground-tertiary focus:border-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={anchor.kind === "entry" ? String(anchor.entryIndex) : "session"}
            onChange={(event) =>
              setAnchor(
                event.target.value === "session"
                  ? { kind: "session" }
                  : { kind: "entry", entryIndex: Number(event.target.value) },
              )
            }
            aria-label="What this note is about"
            data-testid="local-notes-anchor"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="session">The whole session</option>
            {Array.from({ length: Math.min(entryCount, 200) }, (_, i) => (
              <option key={i} value={String(i)}>
                Entry {i}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={busy || body === ""}
            data-testid="local-notes-add"
            onClick={() =>
              void run(async () => {
                await ipc().invoke("sharing.notes.create", {
                  sessionId,
                  // A reply is anchored where the comment it answers is, so the
                  // thread stays together; otherwise use the chosen anchor.
                  anchor: replyTo ? { kind: "session" } : anchor,
                  body,
                  ...(replyTo ? { replyToReceivedId: replyTo.receivedId } : {}),
                });
                setDraft("");
                setAnchor({ kind: "session" });
                onReplyHandled?.();
              })
            }
          >
            Add note
          </Button>
        </div>
      </div>
    </section>
  );
}
