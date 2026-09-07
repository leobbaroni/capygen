import type { CapygenStore } from "@capygen/db";
import {
  AgentDraftSchema,
  newId,
  type AgentDraft,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type TextBlock,
} from "@capygen/shared";
import type { Broadcast } from "../engine/types.js";
import { type ImportPreview, type ImportStagingService } from "../imports/staging.js";
import {
  buildImportReference,
  IMPORTED_REFERENCE_SPEAKER_LABEL,
} from "@capygen/engine";

export const IMPORT_CHANNELS = [
  "imports.pick",
  "imports.cancel",
  "imports.commit",
  "imports.get",
  "imports.entries",
  "imports.reference",
  "imports.continue",
] as const satisfies readonly InvokeChannel[];

export type ImportChannel = (typeof IMPORT_CHANNELS)[number];
export type ImportHandlers = {
  [C in ImportChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export interface ImportsHandlerDeps {
  store: CapygenStore;
  staging: ImportStagingService;
  ownerId: () => number;
  isOwnerAlive: (ownerId: number) => boolean;
  pickFile: (ownerId: number) => Promise<string | null>;
  broadcast: Broadcast;
  /** Validate and materialize the model/provider before any session row exists. */
  validateAgent: (agent: AgentDraft) => AgentDraft;
}

export function createImportsHandlers(deps: ImportsHandlerDeps): ImportHandlers {
  const { store, staging, broadcast } = deps;

  function decoratedPreview(preview: ImportPreview): InvokeResult<"imports.pick"> {
    const exact = store.db.get<{ session_id: string }>(
      `SELECT session_id FROM transcript_imports
       WHERE backend = ? AND native_id = ? AND source_sha256 = ?`,
      preview.backend,
      preview.nativeId,
      preview.sourceSha256,
    );
    const changed = exact
      ? undefined
      : store.db.get<{ session_id: string }>(
          `SELECT session_id FROM transcript_imports
           WHERE backend = ? AND native_id = ? AND source_sha256 <> ? LIMIT 1`,
          preview.backend,
          preview.nativeId,
          preview.sourceSha256,
        );
    return {
      ...preview,
      ...(exact ? { existingSessionId: exact.session_id } : {}),
      ...(changed ? { changedSnapshot: true } : {}),
    };
  }

  function reference(sessionId: string): InvokeResult<"imports.reference"> {
    if (!store.imports.get(sessionId)) throw new Error(`unknown imported session: ${sessionId}`);
    return buildImportReference(store.imports.tail(sessionId, 100));
  }

  const handlers: ImportHandlers = {
    "imports.pick": async (args) => {
      if (!store.projects.get(args.projectId)) throw new Error(`unknown project: ${args.projectId}`);
      const ownerId = deps.ownerId();
      const sourcePath = await deps.pickFile(ownerId);
      if (sourcePath === null) return null;
      // The owner may have closed while Electron's native dialog was open.
      // Refuse before staging registers an operation or starts a worker.
      if (!deps.isOwnerAlive(ownerId)) throw new Error("the import window was closed");
      const preview = await staging.preview({
        ownerId,
        sourcePath,
        destinationProjectId: args.projectId,
      });
      return decoratedPreview(preview);
    },

    "imports.cancel": async (args) => {
      await staging.cancel(args.handle, deps.ownerId());
      return { ok: true };
    },

    "imports.commit": async (args) => {
      const result = await staging.consume(args.handle, deps.ownerId(), ({
        transcript,
        destinationProjectId,
      }) => store.imports.commit({ projectId: destinationProjectId, snapshot: transcript }));
      broadcast("session.updated", result.session);
      return result;
    },

    "imports.get": (args) => store.imports.get(args.sessionId),
    "imports.entries": (args) =>
      store.imports.entries(args.sessionId, { offset: args.offset, limit: args.limit }),
    "imports.reference": (args) => reference(args.sessionId),

    "imports.continue": (args) => {
      const source = store.imports.get(args.sessionId);
      if (!source) throw new Error(`unknown imported session: ${args.sessionId}`);
      if (!store.projects.get(args.projectId)) throw new Error(`unknown project: ${args.projectId}`);
      const agent = AgentDraftSchema.parse(deps.validateAgent(args.agent));
      const quoted = reference(args.sessionId);

      const committed = store.db.transaction(() => {
        const created = store.sessions.create({
          projectId: args.projectId,
          mode: "solo",
          title: source.title ? `${source.title} (continued)` : "Continued imported transcript",
          agents: [agent],
        });
        const session = store.imports.linkContinuation(created.session.id, args.sessionId);
        const turn = store.turns.create({
          sessionId: session.id,
          role: "system",
          status: "done",
          speakerLabel: IMPORTED_REFERENCE_SPEAKER_LABEL,
        });
        const ts = Date.now();
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
        return { session, agents: created.agents, turn, block };
      });

      // Publish only committed rows: a failed block/link write broadcasts no
      // half-created continuation for another window to cache.
      broadcast("session.updated", committed.session);
      broadcast("agents.updated", { sessionId: committed.session.id, agents: committed.agents });
      broadcast("chat.block", committed.block);
      broadcast("chat.turnStatus", {
        sessionId: committed.session.id,
        turnId: committed.turn.id,
        status: "done",
      });
      return { session: committed.session, agents: committed.agents };
    },
  };

  return handlers;
}
