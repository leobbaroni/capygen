/**
 * Reading just enough of a session to export it.
 *
 * This runs on main, next to SQLite, so it must never load the session. It
 * pages, it selects **only the fields the share whitelist reads**, and it clips
 * text in SQL before the row is transferred. A `tool_call` block's
 * `payload_json` holds the command that ran and everything it printed; that
 * column is never selected, so those bytes are not allocated in any process,
 * let alone exported.
 *
 * Cumulative limits are enforced as pages arrive, so an oversize session is
 * refused *while* it is being read rather than after it has been assembled.
 * What leaves here is a bounded `ShareExportRequest` — a description of the
 * export — which the worker turns into a bundle.
 */
import type { CapygenStore } from "@capygen/db";
import type { ShareComment, ShareEntry, TurnRole } from "@capygen/shared";
import { ShareCodecError } from "./json.js";
import type { ShareDisplayMetadata, ShareProjectionOptions } from "./projection.js";
import type {
  LiveBlockRow,
  ShareEntriesExportRequest,
  ShareExportRequest,
  ShareLiveExportRequest,
} from "./buildBundle.js";

const PAGE = 200;
/** Characters pulled per row: comfortably above the 64 KiB byte cap, so the
 *  clip happens in SQL and the exact byte clip happens once, in the worker. */
const ROW_TEXT_CHARS = 70_000;
/** Entries one export may contain, matching the bundle contract's own cap. */
const MAX_ROWS = 100_000;
/** Characters read across the whole session before the export is refused. */
const MAX_TOTAL_CHARS = 48 * 1024 * 1024;

export type ShareExportOrigin = "live" | "native-transcript" | "shared-bundle";

export interface ShareExportPlan {
  origin: ShareExportOrigin;
  request: ShareExportRequest;
}

interface LiveRow {
  block_id: string;
  kind: string;
  turn_role: string;
  created_at: number;
  text: string | null;
  text_len: number;
  name: string | null;
  status: string | null;
}

/**
 * Only the columns the projection reads, per kind.
 *
 * `json_extract` pulls one value out of the payload inside SQLite; `substr`
 * bounds it before it crosses into JavaScript; `length` reports what was there
 * so truncation is known without carrying the rest. A tool call yields its
 * name and status and nothing else.
 */
const LIVE_ROWS_SQL = `
  SELECT b.id AS block_id,
         b.kind AS kind,
         t.role AS turn_role,
         b.created_at AS created_at,
         substr(CASE b.kind
                  WHEN 'text' THEN json_extract(b.payload_json, '$.text')
                  WHEN 'thinking' THEN json_extract(b.payload_json, '$.text')
                  WHEN 'error' THEN json_extract(b.payload_json, '$.message')
                  ELSE NULL END, 1, ?) AS text,
         length(CASE b.kind
                  WHEN 'text' THEN json_extract(b.payload_json, '$.text')
                  WHEN 'thinking' THEN json_extract(b.payload_json, '$.text')
                  WHEN 'error' THEN json_extract(b.payload_json, '$.message')
                  ELSE NULL END) AS text_len,
         substr(CASE b.kind
                  WHEN 'tool_call' THEN json_extract(b.payload_json, '$.name')
                  WHEN 'subagent' THEN json_extract(b.payload_json, '$.name')
                  ELSE NULL END, 1, 200) AS name,
         substr(json_extract(b.payload_json, '$.status'), 1, 40) AS status
    FROM blocks b
    JOIN turns t ON t.id = b.turn_id
   WHERE b.session_id = ?
   ORDER BY b.created_at, b.block_index, b.id
   LIMIT ? OFFSET ?`;

function refuseOversize(): never {
  throw new ShareCodecError(
    "over-limit",
    "this session is too large to share as one bundle",
  );
}

function readLiveRows(store: CapygenStore, sessionId: string): LiveBlockRow[] {
  const rows: LiveBlockRow[] = [];
  let chars = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = store.db.all<LiveRow>(LIVE_ROWS_SQL, ROW_TEXT_CHARS, sessionId, PAGE, offset);
    if (page.length === 0) break;
    for (const row of page) {
      if (rows.length >= MAX_ROWS) refuseOversize();
      chars += row.text?.length ?? 0;
      if (chars > MAX_TOTAL_CHARS) refuseOversize();
      rows.push({
        blockId: String(row.block_id),
        kind: String(row.kind),
        turnRole: String(row.turn_role) as TurnRole,
        createdAt: Number(row.created_at),
        text: row.text,
        textLength: Number(row.text_len ?? 0),
        name: row.name,
        status: row.status,
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

function readEntries(read: (offset: number) => ShareEntry[]): ShareEntry[] {
  const entries: ShareEntry[] = [];
  let chars = 0;
  for (let offset = 0; ; offset += 100) {
    const page = read(offset);
    if (page.length === 0) break;
    for (const entry of page) {
      if (entries.length >= MAX_ROWS) refuseOversize();
      chars += "text" in entry ? entry.text.length : 0;
      if (chars > MAX_TOTAL_CHARS) refuseOversize();
      entries.push(entry);
    }
    if (page.length < 100) break;
  }
  return entries;
}

/**
 * Plan one export. Read-only: nothing here writes a row or mutates the session.
 *
 * The artifact kind chooses the source table — never `origin`, which a native
 * transcript and a shared bundle share.
 */
export function planShareExport(
  store: CapygenStore,
  sessionId: string,
  options: ShareProjectionOptions,
): ShareExportPlan {
  const session = store.sessions.get(sessionId);
  if (!session) throw new ShareCodecError("schema", "that session no longer exists");

  const metadata: ShareDisplayMetadata = {
    title: session.title === "" ? null : session.title,
    mode: session.mode,
    startedAt: new Date(session.createdAt).toISOString(),
    endedAt: new Date(session.updatedAt).toISOString(),
    agents: store.sessions.agents(sessionId).map((agent) => ({
      label: agent.name, backend: agent.backend, model: agent.model,
    })),
  };

  const kind = store.shares.artifactKindOf(sessionId);

  if (kind === "shared-bundle") {
    const record = store.shares.get(sessionId);
    if (!record) throw new ShareCodecError("schema", "that shared artifact is missing its bundle");
    const entries = readEntries((offset) => store.shares.entries(sessionId, { offset, limit: 100 }));
    // Received comments are data this app already holds. They travel on, are
    // re-anchored against whatever this pass withholds, and are redacted again.
    const received: ShareComment[] = store.shares.comments(sessionId);
    // The operator's own notes travel alongside the sender's. They are handed
    // over in *source* index space so `buildEntriesBundle` re-anchors them
    // through the same map it uses for received comments — one re-anchoring
    // rule, so withholding reasoning cannot move one kind and not the other.
    // A reply to a received comment survives only because that comment is in
    // this same list, ahead of it.
    const comments: ShareComment[] = [
      ...received,
      ...store.localNotes.toShareComments(sessionId, {
        carriedReceivedIds: new Set(received.map((comment) => comment.id)),
      }),
    ];
    const request: ShareEntriesExportRequest = {
      kind: "entries", artifact: "shared-bundle", entries, comments,
      metadata: { ...metadata, title: record.source.title ?? metadata.title,
        mode: record.source.mode, agents: record.source.agents },
      options,
      inherited: {
        droppedInteractive: record.counts.droppedInteractive,
        droppedThinking: record.counts.droppedThinking,
        droppedWidgets: record.counts.droppedWidgets,
        droppedUsage: record.counts.droppedUsage,
        redactions: record.counts.redactions,
      },
    };
    return { origin: "shared-bundle", request };
  }

  if (kind === "native-transcript") {
    const record = store.imports.get(sessionId);
    if (!record) throw new ShareCodecError("schema", "that imported session is missing its transcript");
    const entries = readEntries((offset) => store.imports.entries(sessionId, { offset, limit: 100 }));
    const request: ShareEntriesExportRequest = {
      kind: "entries", artifact: "native-transcript", entries,
      comments: store.localNotes.toShareComments(sessionId),
      metadata: { ...metadata, title: record.title ?? metadata.title },
      options,
      parserOmissions: {
        droppedConfiguration: record.counts.droppedConfiguration,
        unknownRecords: record.counts.unknownRecords,
      },
    };
    return { origin: "native-transcript", request };
  }

  // The anchors come back with the comments so the builder can resolve them
  // against the projection it is about to run.
  let commentBlockAnchors: ReadonlyMap<string, string> = new Map();
  const comments = store.localNotes.toShareComments(sessionId, {
    onBlockAnchors: (anchors) => { commentBlockAnchors = anchors; },
  });
  const request: ShareLiveExportRequest = {
    kind: "live", rows: readLiveRows(store, sessionId), metadata, options,
    comments, commentBlockAnchors,
  };
  return { origin: "live", request };
}
