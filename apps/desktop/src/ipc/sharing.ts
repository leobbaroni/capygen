/**
 * Sharing IPC: export a session to a file, and import one back.
 *
 * The renderer never supplies authority. It cannot name a file, hand over
 * bytes, claim a window, or say which project an import lands in at commit
 * time: main opens the dialogs, captures window and project identity when the
 * operation starts, and re-checks that identity immediately before anything
 * irreversible. Everything crossing the bridge afterwards is an opaque handle.
 *
 * The heavy work is not here either. Decoding, projection, redaction, schema
 * validation and encoding all run in the share worker, which owns the payload
 * for the life of the handle; main holds the handle, a small preview and the
 * memory reservation that covers the worker's copy.
 *
 * Two irreversible steps exist — writing a file and writing the database — and
 * both are gated the same way: the dialog runs, then `assertCurrent()` re-checks
 * that this operation is still live, then the write happens with nothing
 * awaited in between.
 *
 * Wiring note for main: the staging service must be built with
 * `releaseJob: (jobId) => worker.release(jobId)` **and**
 * `isWorkerGone: () => worker.isGone()`. Staging keeps a payload's byte and
 * concurrency budget reserved until the worker confirms the release; without
 * the second callback it cannot tell "the release failed" from "there is no
 * worker left to hold it", and a dead child's payload would hold its budget
 * until the process ends.
 */
import { createHash } from "node:crypto";
import type { CapygenStore } from "@capygen/db";
import {
  AgentDraftSchema,
  newId,
  type AgentDraft,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type ShareExportPreview,
  type ShareImportPreview,
  type ShareOmissionClaim,
  type TextBlock,
} from "@capygen/shared";
// The same builder native continuation uses, so both artifacts quote their
// source identically and share one delivered byte budget.
import { buildImportReference, IMPORTED_REFERENCE_SPEAKER_LABEL } from "@capygen/engine";
import type { Broadcast } from "../engine/types.js";
import { SHARE_JSON_MAX_BYTES, ShareCodecError } from "../sharing/json.js";
import { SHARE_HTML_MAX_BYTES } from "../sharing/html.js";
import { shareFileName } from "../sharing/filenames.js";
import { planShareExport, type ShareExportOrigin } from "../sharing/exportSource.js";
import { ShareStagingError, type ShareStagingService } from "../sharing/staging.js";
import type { ShareWorkerClient } from "../sharing/workerClient.js";
import type { ShareJobPreview } from "../sharing/workerHostTypes.js";

export const SHARING_CHANNELS = [
  "sharing.export.preview",
  "sharing.export.entries",
  "sharing.export.comments",
  "sharing.export.save",
  "sharing.export.cancel",
  "sharing.import.pick",
  "sharing.import.entries",
  "sharing.import.comments",
  "sharing.import.cancel",
  "sharing.import.commit",
  "sharing.entries",
  "sharing.get",
  "sharing.comments",
  "sharing.reference",
  "sharing.continue",
  "sharing.notes.list",
  "sharing.notes.create",
  "sharing.notes.update",
  "sharing.notes.remove",
] as const satisfies readonly InvokeChannel[];

export type SharingChannel = (typeof SHARING_CHANNELS)[number];
export type SharingHandlers = {
  [C in SharingChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

/** What main remembers about a staged share; never sent to the renderer. */
export interface ShareStagingMeta {
  kind: "export" | "import";
  sessionId?: string;
  origin?: ShareExportOrigin;
  /** Import: the project captured when the picker opened, not at commit. */
  destinationProjectId?: string;
  includesReasoning: boolean;
  preview: ShareJobPreview;
  /** Canonical content hash, for telling a duplicate from a conflict. */
  contentSha256: string;
}

export interface SharingHandlerDeps {
  store: CapygenStore;
  staging: ShareStagingService<ShareStagingMeta>;
  worker: ShareWorkerClient;
  ownerId: () => number;
  isOwnerAlive: (ownerId: number) => boolean;
  /** Native open dialog. Returns an absolute path main chose, or null. */
  pickFile: (ownerId: number) => Promise<string | null>;
  /** Native save dialog only. The write is a separate, gated step. */
  chooseSaveTarget: (ownerId: number, suggestedName: string) => Promise<string | null>;
  /** The write itself, called only after `assertCurrent()` has passed. */
  writeFile: (filePath: string, text: string) => Promise<void>;
  broadcast: Broadcast;
  appVersion: string;
  now?: () => number;
  newBundleId?: () => string;
  /** The local operator's display label for notes they author. Main-owned:
   *  a renderer must not be able to write a note under another name. */
  noteAuthorLabel?: () => string;
  /**
   * Vet a renderer-chosen agent for a continuation, exactly as native
   * continuation does (`materializeImportedAgent`): no inline MCP credentials,
   * and a model selection this machine can actually run.
   *
   * Optional in the type only so adding this channel could not break a build
   * mid-flight. It is **mandatory at runtime**: without it, `sharing.continue`
   * refuses rather than persisting an agent nobody checked. A renderer picks
   * from what it was offered, and "what it was offered" is not a guarantee —
   * the payload crossed a process boundary.
   */
  validateAgent?: (agent: AgentDraft) => AgentDraft;
}

/** Used until main supplies the operator's own profile label. */
const DEFAULT_NOTE_AUTHOR = "You";

const claimsOf = (preview: ShareJobPreview): ShareOmissionClaim[] => {
  const rows: Array<[ShareOmissionClaim["kind"], number, string]> = [
    ["thinking", preview.counts.droppedThinking, "reasoning blocks the sender says were withheld"],
    ["interactive", preview.counts.droppedInteractive, "approvals and questions the sender says were withheld"],
    ["widgets", preview.counts.droppedWidgets, "app widgets the sender says were withheld"],
    ["usage", preview.counts.droppedUsage, "usage records the sender says were withheld"],
    ["redactions", preview.counts.redactions, "spans the sender says were redacted"],
  ];
  return rows.filter(([, count]) => count > 0)
    .map(([kind, count, description]) => ({ kind, count, claimed: true as const, description }));
};

const baseName = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? "capygen-share";

export function createSharingHandlers(deps: SharingHandlerDeps): SharingHandlers {
  const { store, staging, worker, broadcast } = deps;
  const now = deps.now ?? Date.now;
  const bundleId = deps.newBundleId
    ?? (() => createHash("sha256").update(newId("session")).digest("hex").slice(0, 32));

  const exportPreview = (
    handle: string, sessionId: string, meta: ShareStagingMeta, expiresAt: number,
  ): ShareExportPreview => ({
    handle,
    sessionId,
    origin: meta.origin ?? "live",
    source: meta.preview.source,
    counts: meta.preview.counts,
    omissions: claimsOf(meta.preview),
    entryCount: meta.preview.entryCount,
    commentCount: meta.preview.commentCount,
    includesReasoning: meta.includesReasoning,
    json: {
      bytes: meta.preview.json.bytes,
      withinLimit: meta.preview.json.withinLimit,
      limit: SHARE_JSON_MAX_BYTES,
      suggestedFileName: shareFileName({
        title: meta.preview.source.title, createdAt: meta.preview.createdAt, format: "json" }),
    },
    html: {
      bytes: meta.preview.html.bytes,
      withinLimit: meta.preview.html.withinLimit,
      limit: SHARE_HTML_MAX_BYTES,
      suggestedFileName: shareFileName({
        title: meta.preview.source.title, createdAt: meta.preview.createdAt, format: "html" }),
    },
    expiresAt,
  });

  const handlers: SharingHandlers = {
    "sharing.export.preview": async (args) => {
      const ownerId = deps.ownerId();
      const createdAt = new Date(now()).toISOString();
      // Planning reads bounded pages next to SQLite; the projection, redaction
      // and encoding all happen in the worker.
      const plan = planShareExport(store, args.sessionId, {
        bundleId: bundleId(),
        appVersion: deps.appVersion,
        createdAt,
        includeReasoning: args.includeReasoning,
      });
      const staged = await staging.stage({
        ownerId,
        kind: "export",
        produce: async (jobId) => {
          const preview = await worker.createFromExport(jobId, plan.request);
          return {
            bytes: preview.json.bytes,
            meta: {
              kind: "export" as const,
              sessionId: args.sessionId,
              origin: plan.origin,
              includesReasoning: args.includeReasoning,
              preview,
              contentSha256: "",
            },
          };
        },
      });
      return exportPreview(staged.handle, args.sessionId, staged.meta, staged.expiresAt);
    },

    "sharing.export.entries": async (args) =>
      staging.use(args.handle, deps.ownerId(), (staged) =>
        worker.entries(staged.jobId, args.offset, args.limit)),

    "sharing.export.comments": async (args) =>
      staging.use(args.handle, deps.ownerId(), (staged) =>
        worker.comments(staged.jobId, args.offset, args.limit)),

    "sharing.export.save": async (args) =>
      staging.use(args.handle, deps.ownerId(), async (staged) => {
        const ownerId = deps.ownerId();
        if (args.format === "html" && !staged.meta.preview.html.withinLimit) {
          throw new ShareCodecError(
            "too-large",
            "this session is too large for the readable HTML file; save the JSON bundle instead",
          );
        }
        const suggestedName = shareFileName({
          title: staged.meta.preview.source.title,
          createdAt: staged.meta.preview.createdAt,
          format: args.format,
        });
        const target = await deps.chooseSaveTarget(ownerId, suggestedName);
        if (target === null) return null;
        // The dialog was open for as long as the user took. Re-check *after*
        // it, and encode only then: a cancel or a closed window during the
        // dialog must stop the write, not race it.
        staged.assertCurrent();
        if (!deps.isOwnerAlive(ownerId)) {
          throw new ShareStagingError("cancelled", "the sharing window was closed");
        }
        const encoded = await worker.text(staged.jobId, args.format);
        staged.assertCurrent();
        await deps.writeFile(target, encoded.text);
        return { format: args.format, fileName: baseName(target), bytes: encoded.bytes };
      }),

    "sharing.export.cancel": async (args) => ({
      ok: await staging.cancel(args.handle, deps.ownerId()),
    }),

    "sharing.import.pick": async (args) => {
      if (!store.projects.get(args.projectId)) throw new Error(`unknown project: ${args.projectId}`);
      const ownerId = deps.ownerId();
      const filePath = await deps.pickFile(ownerId);
      if (filePath === null) return null;
      if (!deps.isOwnerAlive(ownerId)) {
        throw new ShareStagingError("cancelled", "the sharing window was closed");
      }
      const staged = await staging.stage({
        ownerId,
        kind: "import",
        produce: async (jobId) => {
          const preview = await worker.createFromFile(jobId, filePath, SHARE_HTML_MAX_BYTES);
          return {
            bytes: preview.json.bytes,
            meta: {
              kind: "import" as const,
              // Captured from the request that opened the picker, never read
              // back from the renderer at commit.
              destinationProjectId: args.projectId,
              includesReasoning: preview.counts.thinking > 0,
              preview,
              contentSha256: preview.contentSha256,
            },
          };
        },
      });

      const existing = store.shares.findByBundleId(staged.meta.preview.bundleId);
      const record = existing ? store.shares.get(existing.id) : null;
      // Duplicate or conflict is decided on the canonical content hash the
      // worker computed while it held the bundle. Main compares 64 hex
      // characters; it never pulls the document across to hash it itself.
      const sameContent = record !== null
        && record.contentSha256 === staged.meta.preview.contentSha256;

      const preview: ShareImportPreview = {
        handle: staged.handle,
        bundleId: staged.meta.preview.bundleId,
        createdAt: staged.meta.preview.createdAt,
        appVersion: staged.meta.preview.appVersion,
        source: staged.meta.preview.source,
        counts: staged.meta.preview.counts,
        omissions: claimsOf(staged.meta.preview),
        entryCount: staged.meta.preview.entryCount,
        commentCount: staged.meta.preview.commentCount,
        destinationProjectId: args.projectId,
        ...(existing && sameContent ? { existingSessionId: existing.id } : {}),
        ...(existing && !sameContent ? { conflictingBundleId: true } : {}),
        expiresAt: staged.expiresAt,
      };
      return preview;
    },

    "sharing.import.entries": async (args) =>
      staging.use(args.handle, deps.ownerId(), (staged) =>
        worker.entries(staged.jobId, args.offset, args.limit)),

    "sharing.import.comments": async (args) =>
      staging.use(args.handle, deps.ownerId(), (staged) =>
        worker.comments(staged.jobId, args.offset, args.limit)),

    "sharing.import.cancel": async (args) => ({
      ok: await staging.cancel(args.handle, deps.ownerId()),
    }),

    "sharing.import.commit": async (args) => {
      const result = await staging.consume(args.handle, deps.ownerId(), async (staged) => {
        const projectId = staged.meta.destinationProjectId;
        if (projectId === undefined) {
          throw new ShareStagingError("unknown-handle", "this share is not an import");
        }
        const bundle = await worker.bundle(staged.jobId);
        // The last gate before the only database write. Nothing awaits between
        // it and `commit`, which re-validates and refuses a conflicting id
        // inside one transaction.
        staged.assertCurrent();
        return store.shares.commit({ projectId, bundle });
      });
      broadcast("session.updated", result.session);
      return result;
    },

    /**
     * A stored bundle's provenance, or null.
     *
     * Null is the answer for a live session *and* for a native transcript
     * import: a shared bundle is a sibling artifact with its own tables, and a
     * reader picks its source by `sessions.artifactKind` rather than by
     * guessing from `origin`.
     */
    "sharing.get": (args) => {
      const record = store.shares.get(args.sessionId);
      if (record === null) return null;
      const stored = store.shares.storedCounts(args.sessionId);
      return {
        sessionId: record.sessionId,
        bundleId: record.bundleId,
        contentSha256: record.contentSha256,
        schemaVersion: record.schemaVersion,
        appVersion: record.appVersion,
        bundleCreatedAt: record.bundleCreatedAt,
        importedAt: record.importedAt,
        source: record.source,
        counts: record.counts,
        // What is actually stored, not what the bundle claimed: this bounds
        // the reader's paging, and the sender's own tallies are shown
        // separately as the claims they are.
        entryCount: stored.entries,
        commentCount: stored.comments,
      };
    },

    "sharing.comments": (args) =>
      store.shares.comments(args.sessionId, { offset: args.offset, limit: args.limit }),

    /**
     * Locally authored notes.
     *
     * Every write goes through the repository, which validates the anchor's
     * ownership and the reply's session before touching a row — a renderer is
     * not a trusted caller, and neither is the schema alone: it can say an
     * entry index is a non-negative integer, not that this artifact has one.
     *
     * Nothing here writes to `share_import_comments`: a received bundle is
     * immutable, and a local reply is a row of its own.
     */
    /**
     * A bounded, inert quotation of the bundle's tail.
     *
     * The same builder native continuation uses, so both artifacts quote their
     * source identically and neither can exceed the delivered byte budget. It
     * is text: a bundle has no configuration, no tool definitions and no
     * conversation id, and nothing here could resume one if it did.
     */
    "sharing.reference": (args) => {
      if (!store.shares.get(args.sessionId)) {
        throw new Error(`unknown shared session: ${args.sessionId}`);
      }
      return buildImportReference(store.shares.tail(args.sessionId, 100));
    },

    /**
     * Start a fresh live session that quotes a received bundle.
     *
     * Everything about the new session is this machine's: a new session id, a
     * new agent row, and whatever backend identity that agent's harness mints
     * when it first runs. The sender's ids are never reused — a bundle carries
     * none — and the only thing that crosses is the quoted text, written as an
     * inert system block the same way a native continuation writes its own.
     *
     * One transaction, so a session is never left half-linked with a reference
     * block and no source, or linked with no reference to show for it.
     */
    "sharing.continue": (args) => {
      const source = store.shares.get(args.sessionId);
      if (!source) throw new Error(`unknown shared session: ${args.sessionId}`);
      if (!store.projects.get(args.projectId)) throw new Error(`unknown project: ${args.projectId}`);
      if (!deps.validateAgent) {
        // Refusing beats bypassing: native continuation runs the credential and
        // model checks, and a shared one that skipped them would be the softer
        // path to starting an agent this machine has not vetted.
        throw new Error(
          "sharing.continue is not available: main has not supplied an agent validator",
        );
      }
      const agent = AgentDraftSchema.parse(deps.validateAgent(args.agent));
      const quoted = buildImportReference(store.shares.tail(args.sessionId, 100));

      const committed = store.db.transaction(() => {
        const created = store.sessions.create({
          projectId: args.projectId,
          mode: "solo",
          title: source.source.title ? `${source.source.title} (continued)` : "Continued shared session",
          agents: [agent],
        });
        const session = store.shares.linkContinuation(created.session.id, args.sessionId);
        const turn = store.turns.create({
          sessionId: session.id,
          role: "system",
          status: "done",
          speakerLabel: IMPORTED_REFERENCE_SPEAKER_LABEL,
        });
        const ts = deps.now?.() ?? Date.now();
        const block: TextBlock = {
          id: newId("block"),
          turnId: turn.id,
          sessionId: session.id,
          kind: "text",
          index: 0,
          text: quoted.text,
          createdAt: ts,
          updatedAt: ts,
        };
        store.blocks.upsert(block);
        store.projects.touch(args.projectId);
        return { session, agents: created.agents };
      });
      deps.broadcast("session.updated", committed.session);
      return committed;
    },

    "sharing.notes.list": (args) => ({
      notes: store.localNotes.list(args.sessionId, { offset: args.offset, limit: args.limit }),
      total: store.localNotes.count(args.sessionId),
    }),

    "sharing.notes.create": (args) => {
      if (!store.sessions.get(args.sessionId)) {
        throw new Error(`unknown session: ${args.sessionId}`);
      }
      return {
        note: store.localNotes.create({
          sessionId: args.sessionId,
          anchor: args.anchor,
          // The author label is main's to decide, never the renderer's: it is
          // the local operator's profile label, and a caller must not be able
          // to write a note under someone else's name.
          authorLabel: deps.noteAuthorLabel?.() ?? DEFAULT_NOTE_AUTHOR,
          body: args.body,
          replyToId: args.replyToId,
          replyToReceivedId: args.replyToReceivedId,
        }),
      };
    },

    "sharing.notes.update": (args) => ({
      note: store.localNotes.update(args.noteId, {
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.resolved === undefined ? {} : { resolved: args.resolved }),
        ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
      }),
    }),

    "sharing.notes.remove": (args) => ({ removed: store.localNotes.remove(args.noteId) }),

    "sharing.entries": (args) => {
      // Only for an artifact that really is a shared bundle: a native
      // transcript is served by `imports.entries`, never by this one.
      if (store.shares.artifactKindOf(args.sessionId) !== "shared-bundle") {
        throw new Error(`not a shared session: ${args.sessionId}`);
      }
      return store.shares.entries(args.sessionId, { offset: args.offset, limit: args.limit });
    },
  };

  return handlers;
}
