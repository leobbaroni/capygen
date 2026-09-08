import type { TurnRole } from "@capygen/shared";
import type { Database } from "./driver.js";

export interface TranscriptTextEntry { id: string; agentId: string | null; role: TurnRole; speakerLabel?: string; text: string }

/** Only text crosses the SQLite boundary. No payload_json/tool output is materialized
 * in JavaScript, and empty settled turns remain present as history watermarks.
 * No arbitrary row limit: the dispatcher owns its existing delta/character budgets. */
export function transcriptTextEntries(db: Database, sessionId: string): TranscriptTextEntry[] {
  const rows = db.all<{ id: string; agentId: string | null; role: TurnRole; speakerLabel: string | null; text: string | null }>(
    `SELECT t.id, t.agent_id AS agentId, t.role, t.speaker_label AS speakerLabel,
            json_extract(b.payload_json, '$.text') AS text
       FROM turns t
       LEFT JOIN blocks b ON b.turn_id = t.id AND b.session_id = t.session_id
         AND b.kind = 'text' AND json_extract(b.payload_json, '$.delegatedFrom') IS NULL
      WHERE t.session_id = ? AND t.status NOT IN ('streaming', 'pending')
      ORDER BY t.created_at, t.rowid, b.block_index, b.rowid`,
    sessionId,
  );
  const entries: TranscriptTextEntry[] = [];
  let current: TranscriptTextEntry | undefined;
  let parts: string[] = [];
  for (const row of rows) {
    if (current?.id !== row.id) {
      if (current) current.text = parts.join("\n").trim();
      current = { id: row.id, agentId: row.agentId, role: row.role,
        ...(row.speakerLabel === null ? {} : { speakerLabel: row.speakerLabel }), text: "" };
      entries.push(current);
      parts = [];
    }
    if (typeof row.text === "string") parts.push(row.text);
  }
  if (current) current.text = parts.join("\n").trim();
  return entries;
}

/** Chaining needs the complete parent text, but never a tool payload or delegated text. */
export function turnText(db: Database, turnId: string): string {
  return db.all<{ text: string }>(
    `SELECT json_extract(payload_json, '$.text') AS text FROM blocks
      WHERE turn_id = ? AND kind = 'text' AND json_extract(payload_json, '$.delegatedFrom') IS NULL
      ORDER BY block_index, rowid`, turnId,
  ).map(row => row.text).join("\n").trim();
}
