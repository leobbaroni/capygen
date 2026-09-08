/**
 * One staged share (an export snapshot or a picked import), owned by a panel.
 *
 * A staged handle is a *reservation* in main's worker: it pins the projected
 * payload, and its memory, until something consumes or releases it. Three rules
 * follow from that, and the first version of this page broke all three:
 *
 *  - **One operation at a time.** `staging.use` admits a single operation per
 *    handle. Fetching entries and comments with `Promise.all` therefore made
 *    the second request fail with "this share is already being saved or
 *    imported", and the page discarded the preview the user had just prepared.
 *    Every read here is serial, and a second read cannot start while one is in
 *    flight.
 *  - **A late answer belongs to the generation that asked for it.** Staging,
 *    paging and picking all resolve after an await, by which time the operator
 *    may have switched session, toggled reasoning, discarded, or left the page.
 *    Each operation carries the generation it began in; a completion from an
 *    older generation updates nothing — and if it produced a *handle*, that
 *    handle is released rather than leaked, because nothing else will ever
 *    hold it.
 *  - **A handle is consumed or released, never dropped.** `sharing.export.save`
 *    does not consume the handle in main, so a page that merely forgot it left
 *    the reservation pinned until expiry. Saving releases it explicitly;
 *    committing does not, because commit consumes it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareComment, ShareEntry } from "@capygen/shared";
import { ipc } from "@/lib/ipc";

export const SHARE_PAGE = 25;

export type StagedKind = "export" | "import";

export const shareErrorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : "Something went wrong.";

/**
 * The read-only slice a pager needs.
 *
 * Separate from `StagedShare<TPreview>` because that type is invariant in
 * `TPreview` (its `stage` takes a callback), so a component that only reads
 * pages cannot accept `StagedShare<unknown>`.
 */
export interface StagedPages {
  entries: ShareEntry[];
  comments: ShareComment[];
  entryOffset: number;
  commentOffset: number;
  busy: boolean;
  pageEntries: (offset: number) => Promise<void>;
  pageComments: (offset: number) => Promise<void>;
}

export interface StagedShare<TPreview> extends StagedPages {
  preview: TPreview | null;
  error: string | null;
  setError: (message: string | null) => void;
  /** Stage a new snapshot, replacing and releasing whatever this panel held. */
  stage: (load: () => Promise<{ handle: string; preview: TPreview } | null>) => Promise<void>;
  /**
   * Run an exclusive operation on the held handle (save or commit).
   *
   * `consumes` says whether main retires the handle itself: a commit does, a
   * save does not. When it does not and the operation succeeded, the handle is
   * released here so its reservation is not held to expiry.
   */
  exclusive: <T>(
    run: (handle: string) => Promise<T>,
    options: { consumes: boolean; keepOn?: (result: T) => boolean },
  ) => Promise<T | undefined>;
  discard: () => void;
}

export function useStagedShare<TPreview>(kind: StagedKind): StagedShare<TPreview> {
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [entries, setEntries] = useState<ShareEntry[]>([]);
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [entryOffset, setEntryOffset] = useState(0);
  const [commentOffset, setCommentOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The handle this panel holds, and the generation that put it there. */
  const held = useRef<string | null>(null);
  /**
   * Which *snapshot* an answer belongs to. Bumped whenever the staged content
   * changes, so a late completion can tell it is answering a question nobody is
   * asking any more.
   */
  const generation = useRef(0);
  /**
   * Which *operation* owns the exclusive lock, and therefore owns `busy`.
   *
   * Deliberately separate from `generation`. They were one thing, and a
   * successful save bumped the generation before its own `finally` ran — so the
   * `generation === mine` guard failed, `setBusy(false)` never happened, and
   * every button on the panel stayed disabled after a successful export. A
   * completion must be able to release the lock it took even when the snapshot
   * it was working on is deliberately gone.
   *
   * `running` was also cleared unconditionally, so a stale completion could
   * unlock an operation that had started after it. Only the operation that took
   * the lock may release it.
   */
  const operationSeq = useRef(0);
  const lockedBy = useRef<number | null>(null);

  const release = useCallback(
    (handle: string | null) => {
      if (handle === null) return;
      // Fire and forget: an already-expired or already-consumed handle is not a
      // failure worth putting on screen.
      void ipc().invoke(`sharing.${kind}.cancel`, { handle }).catch(() => {});
    },
    [kind],
  );

  /** Abandon the current generation; nothing older may write after this. */
  const invalidate = useCallback(() => {
    generation.current += 1;
    return generation.current;
  }, []);

  const discard = useCallback(() => {
    invalidate();
    release(held.current);
    held.current = null;
    // Abandoning the panel's content abandons whatever held the lock with it;
    // an in-flight completion will find the lock is no longer its own.
    lockedBy.current = null;
    setPreview(null);
    setEntries([]);
    setComments([]);
    setEntryOffset(0);
    setCommentOffset(0);
    setBusy(false);
  }, [invalidate, release]);

  // Leaving the page must not leave a reservation pinned in the worker.
  useEffect(
    () => () => {
      generation.current += 1;
      release(held.current);
      held.current = null;
    },
    [release],
  );

  const stage = useCallback(
    async (load: () => Promise<{ handle: string; preview: TPreview } | null>) => {
      if (lockedBy.current !== null) return;
      const op = (operationSeq.current += 1);
      lockedBy.current = op;
      // Replacing a snapshot releases the old one first, and takes a new
      // generation so the outgoing one can no longer write.
      release(held.current);
      held.current = null;
      const mine = invalidate();
      setPreview(null);
      setEntries([]);
      setComments([]);
      setEntryOffset(0);
      setCommentOffset(0);
      setError(null);
      setBusy(true);
      try {
        const staged = await load();
        if (generation.current !== mine) {
          // The operator moved on while this was in flight. The handle is real
          // and nothing else will hold it, so release it rather than leak it.
          if (staged !== null) release(staged.handle);
          return;
        }
        // A null result is a cancelled native dialog, not a failure.
        if (staged === null) return;
        held.current = staged.handle;
        setPreview(staged.preview);

        // Serial, never Promise.all: one operation at a time per handle.
        const firstEntries = await ipc().invoke(`sharing.${kind}.entries`, {
          handle: staged.handle, offset: 0, limit: SHARE_PAGE,
        });
        if (generation.current !== mine) return;
        setEntries(firstEntries);

        const firstComments = await ipc().invoke(`sharing.${kind}.comments`, {
          handle: staged.handle, offset: 0, limit: SHARE_PAGE,
        });
        if (generation.current !== mine) return;
        setComments(firstComments);
      } catch (cause) {
        if (generation.current !== mine) return;
        // A partly staged snapshot is not usable; release what was reserved.
        release(held.current);
        held.current = null;
        setPreview(null);
        setEntries([]);
        setComments([]);
        setError(shareErrorMessage(cause));
      } finally {
        // Owned by this operation, not by the snapshot: a stage that ends by
        // discarding its own snapshot must still release the lock it took.
        if (lockedBy.current === op) {
          lockedBy.current = null;
          setBusy(false);
        }
      }
    },
    [invalidate, kind, release],
  );

  /** Both pagers share one shape; only the channel and the setter differ. */
  const pageBoth = useCallback(
    async (channel: "entries" | "comments", offset: number) => {
      const handle = held.current;
      if (handle === null || lockedBy.current !== null) return;
      const op = (operationSeq.current += 1);
      lockedBy.current = op;
      const mine = generation.current;
      setBusy(true);
      try {
        const page = await ipc().invoke(`sharing.${kind}.${channel}`, {
          handle, offset, limit: SHARE_PAGE,
        });
        // An old page must never land on a newer snapshot.
        if (generation.current !== mine) return;
        if (channel === "entries") {
          setEntries(page as ShareEntry[]);
          setEntryOffset(offset);
        } else {
          setComments(page as ShareComment[]);
          setCommentOffset(offset);
        }
      } catch (cause) {
        // An old rejection must not discard a newer preview.
        if (generation.current !== mine) return;
        setError(shareErrorMessage(cause));
      } finally {
        if (lockedBy.current === op) {
          lockedBy.current = null;
          setBusy(false);
        }
      }
    },
    [kind],
  );

  const pageEntries = useCallback((offset: number) => pageBoth("entries", offset), [pageBoth]);
  const pageComments = useCallback((offset: number) => pageBoth("comments", offset), [pageBoth]);

  const exclusive = useCallback(
    async <T,>(
      run: (handle: string) => Promise<T>,
      options: { consumes: boolean; keepOn?: (result: T) => boolean },
    ): Promise<T | undefined> => {
      const handle = held.current;
      if (handle === null || lockedBy.current !== null) return undefined;
      const op = (operationSeq.current += 1);
      lockedBy.current = op;
      const mine = generation.current;
      setBusy(true);
      setError(null);
      try {
        const result = await run(handle);
        // A completion for a snapshot that is gone reports nothing: the caller
        // would otherwise announce "Saved …" over the snapshot that replaced
        // it, or navigate away on a commit the operator had abandoned.
        if (generation.current !== mine) return undefined;
        // `keepOn` covers a cancelled save dialog: the reviewed snapshot stays
        // so another format can still be written from it.
        if (options.keepOn?.(result) === true) return result;
        if (!options.consumes) {
          // Main does not retire a saved handle; dropping it here would pin the
          // reservation until it expired.
          release(handle);
        }
        held.current = null;
        generation.current += 1;
        setPreview(null);
        setEntries([]);
        setComments([]);
        setEntryOffset(0);
        setCommentOffset(0);
        return result;
      } catch (cause) {
        if (generation.current !== mine) return undefined;
        setError(shareErrorMessage(cause));
        return undefined;
      } finally {
        // A successful save intentionally retires its own snapshot above, so
        // the generation has already moved on; the lock is still this
        // operation's to release.
        if (lockedBy.current === op) {
          lockedBy.current = null;
          setBusy(false);
        }
      }
    },
    [release],
  );

  return {
    preview, entries, comments, entryOffset, commentOffset, busy, error, setError,
    stage, pageEntries, pageComments, exclusive, discard,
  };
}
