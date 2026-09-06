/**
 * Repositories — the only code that writes SQL. Each one maps snake_case rows to
 * the camelCase domain types from `@capygen/shared` and validates on the way out,
 * so a schema drift shows up as a parse error at the boundary instead of a
 * malformed object three layers up.
 */
import {
  AgentSchema,
  BlockSchema,
  DEFAULT_SETTINGS,
  ProjectSchema,
  SessionSchema,
  SessionSettingsSchema,
  SettingsSchema,
  ToolOutputSchema,
  TurnSchema,
  UsageEventSchema,
  deriveMentionName,
  newId,
  type Agent,
  type AgentDraft,
  type AgentPatch,
  type AgentRole,
  type Backend,
  type Block,
  type Project,
  type RoutingTarget,
  type Session,
  type SessionMode,
  type SessionSettings,
  type SessionSettingsPatch,
  type SessionStatus,
  type Settings,
  type ToolOutput,
  type Turn,
  type TurnRole,
  type TurnStatus,
  type UsageEvent,
} from "@capygen/shared";
import {
  boolToInt,
  fromJson,
  intToBool,
  toJson,
  type Database,
  type Row,
  type SqlValue,
} from "./driver.js";

const now = (): number => Date.now();

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

function rowToProject(row: Row): Project {
  return ProjectSchema.parse({
    id: row.id,
    path: row.path,
    name: row.name,
    layout: fromJson<unknown>(row.layout_json, null),
    devServers: fromJson<unknown>(row.dev_servers_json, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

export class ProjectsRepo {
  constructor(private readonly db: Database) {}

  /** Insert or return the existing project for `path` — paths are unique. */
  upsertByPath(input: { path: string; name?: string }): Project {
    const existing = this.getByPath(input.path);
    if (existing) return existing;
    const ts = now();
    const project: Project = {
      id: newId("project"),
      path: input.path,
      name: input.name ?? basename(input.path),
      layout: null,
      devServers: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.run(
      `INSERT INTO projects (id, path, name, layout_json, dev_servers_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      project.id,
      project.path,
      project.name,
      ts,
      ts,
    );
    return project;
  }

  get(id: string): Project | null {
    const row = this.db.get<Row>("SELECT * FROM projects WHERE id = ?", id);
    return row ? rowToProject(row) : null;
  }

  getByPath(path: string): Project | null {
    const row = this.db.get<Row>("SELECT * FROM projects WHERE path = ?", path);
    return row ? rowToProject(row) : null;
  }

  list(): Project[] {
    return this.db
      .all<Row>("SELECT * FROM projects ORDER BY updated_at DESC")
      .map(rowToProject);
  }

  setLayout(id: string, layout: unknown): void {
    this.db.run(
      "UPDATE projects SET layout_json = ?, updated_at = ? WHERE id = ?",
      toJson(layout),
      now(),
      id,
    );
  }

  touch(id: string): void {
    this.db.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), id);
  }
}

/** First-not-taken `base`, `base-2`, `base-3`, … — used both for a brand-new
 *  session's agents (against each other) and for `agents.add`/`updateAgent`
 *  (against a session's existing rows). */
function uniqueMentionName(used: ReadonlySet<string>, base: string): string {
  if (!used.has(base)) return base;
  let n = 2;
  let candidate = `${base}-${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** `agents.add`'s fallback label when the caller names neither a
 *  `displayName` nor a `mentionName` — just the backend, capitalised. */
function defaultAgentDisplayName(backend: Backend): string {
  return `${backend.charAt(0).toUpperCase()}${backend.slice(1)} agent`;
}

/** Last path segment, tolerating both separators and a trailing one. */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// sessions + agents
// ---------------------------------------------------------------------------

function rowToSession(row: Row): Session {
  return SessionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    leadAgentId: row.lead_agent_id ?? null,
    title: row.title ?? "",
    status: row.status,
    // `undefined` (not `{}`) so a NULL/absent column takes SessionSchema's
    // own factory default (SessionSettingsSchema's fully-resolved defaults),
    // not a bare `{}` that would skip them — see SessionSchema's doc comment.
    settings: fromJson<unknown>(row.settings_json, undefined),
    archived: intToBool(row.archived),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/**
 * A pre-migration-0003 row has every new column NULL. `displayName` falls
 * back to `name`, `mentionName` to `deriveMentionName(name)` and `role` to
 * `"member"` unless the legacy free-text column already says `"lead"` — the
 * same values `SessionsRepo.create`/`addAgent` would have written had the
 * agent been created after 0003.
 */
function rowToAgent(row: Row): Agent {
  const name = String(row.name);
  return AgentSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    name,
    displayName: (row.display_name as string | null) ?? name,
    mentionName: (row.mention_name as string | null) ?? deriveMentionName(name),
    backend: row.backend,
    model: row.model,
    role: row.role === "lead" ? "lead" : "member",
    description: (row.description as string | null) ?? undefined,
    subagentRouting: fromJson<RoutingTarget | undefined>(row.subagent_routing_json, undefined),
    color: (row.color as string | null) ?? undefined,
    order: Number(row.order_index ?? 0),
    config: fromJson<unknown>(row.config_json, null),
    createdAt: Number(row.created_at),
  });
}

export class SessionsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Create a session with its agents in one transaction. The first agent is the
   * lead unless another is flagged `role: "lead"`.
   *
   * `displayName` defaults to `name`, and `mentionName` is minted from
   * whichever label is available (`deriveMentionName`) and de-duplicated
   * against its new siblings — the same fallback `rowToAgent` applies to a
   * pre-migration-0003 row, so a brand-new agent and a legacy one that has
   * never been renamed read back identically.
   */
  create(input: {
    projectId: string;
    mode: SessionMode;
    title?: string;
    agents: AgentDraft[];
  }): { session: Session; agents: Agent[] } {
    return this.db.transaction(() => {
      const ts = now();
      const sessionId = newId("session");
      const mentionNames = new Set<string>();
      const agents: Agent[] = input.agents.map((draft, i) => {
        const displayName = draft.displayName ?? draft.name;
        const mentionName = uniqueMentionName(
          mentionNames,
          draft.mentionName ?? deriveMentionName(displayName),
        );
        mentionNames.add(mentionName);
        return {
          id: newId("agent"),
          sessionId,
          name: draft.name,
          displayName,
          mentionName,
          backend: draft.backend,
          model: draft.model,
          role: draft.role,
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          ...(draft.subagentRouting !== undefined
            ? { subagentRouting: draft.subagentRouting }
            : {}),
          ...(draft.color !== undefined ? { color: draft.color } : {}),
          order: draft.order ?? i,
          config: draft.config ?? null,
          createdAt: ts,
        };
      });
      const lead = agents.find((a) => a.role === "lead") ?? agents[0] ?? null;

      this.db.run(
        `INSERT INTO sessions
           (id, project_id, mode, lead_agent_id, title, status, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?)`,
        sessionId,
        input.projectId,
        input.mode,
        lead ? lead.id : null,
        input.title ?? "",
        ts,
        ts,
      );
      for (const agent of agents) this.insertAgent(agent);

      const session = this.get(sessionId);
      if (!session) throw new Error("session vanished immediately after insert");
      return { session, agents };
    });
  }

  private insertAgent(agent: Agent): void {
    this.db.run(
      `INSERT INTO agents
         (id, session_id, name, display_name, mention_name, backend, model, role,
          description, subagent_routing_json, color, order_index, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agent.id,
      agent.sessionId,
      agent.name,
      agent.displayName,
      agent.mentionName,
      agent.backend,
      agent.model,
      agent.role,
      agent.description ?? null,
      toJson(agent.subagentRouting ?? null),
      agent.color ?? null,
      agent.order,
      toJson(agent.config),
      agent.createdAt,
    );
  }

  /**
   * Add a top-level agent to an existing session (`agents.add`). Mirrors
   * `create`'s defaulting exactly, deduplicated against the session's
   * *existing* agents (read from the row, so it also sees a legacy agent
   * whose `mention_name` column is still NULL).
   */
  addAgent(
    sessionId: string,
    input: {
      backend: Backend;
      model: string;
      displayName?: string;
      mentionName?: string;
      role?: AgentRole;
      config?: Agent["config"];
    },
  ): Agent {
    const session = this.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const ts = now();
    const displayName = input.displayName ?? input.mentionName ?? defaultAgentDisplayName(input.backend);
    const mentionName = this.uniqueMentionNameInSession(
      sessionId,
      input.mentionName ?? deriveMentionName(displayName),
    );
    const order = this.nextAgentOrder(sessionId);
    const agent: Agent = {
      id: newId("agent"),
      sessionId,
      name: displayName,
      displayName,
      mentionName,
      backend: input.backend,
      model: input.model,
      role: input.role === "lead" ? "lead" : "member",
      order,
      config: input.config ?? null,
      createdAt: ts,
    };
    this.insertAgent(agent);
    if (agent.role === "lead") this.setLead(sessionId, agent.id);
    return this.agent(agent.id) ?? agent;
  }

  /**
   * Merge-patch one agent (`agents.update`). Refuses `patch.role === "lead"`
   * directly — see `AgentPatchSchema`'s doc comment — because only `setLead`
   * also demotes the session's previous lead in the same write; two
   * independent `updateAgent` calls could otherwise leave a session with two
   * (or zero) leads.
   */
  updateAgent(agentId: string, patch: AgentPatch): Agent {
    const existing = this.agent(agentId);
    if (!existing) throw new Error(`unknown agent: ${agentId}`);
    if (patch.role === "lead") {
      throw new Error("agents.update cannot grant the lead role directly; use agents.setLead");
    }
    const mentionName =
      patch.mentionName && patch.mentionName !== existing.mentionName
        ? this.uniqueMentionNameInSession(existing.sessionId, patch.mentionName, agentId)
        : existing.mentionName;
    const merged = AgentSchema.parse({ ...existing, ...patch, mentionName });
    this.db.run(
      `UPDATE agents SET
         display_name = ?, mention_name = ?, model = ?, role = ?, description = ?,
         subagent_routing_json = ?, color = ?, order_index = ?, config_json = ?
       WHERE id = ?`,
      merged.displayName,
      merged.mentionName,
      merged.model,
      merged.role,
      merged.description ?? null,
      toJson(merged.subagentRouting ?? null),
      merged.color ?? null,
      merged.order,
      toJson(merged.config),
      agentId,
    );
    return this.agent(agentId) ?? merged;
  }

  /**
   * Remove a top-level agent. When it was the session's lead, `lead_agent_id`
   * is cleared rather than silently re-assigned — an empty round-table lead
   * is a state the UI/dispatcher must notice and ask about, not one this
   * repo should guess its way out of.
   */
  removeAgent(agentId: string): boolean {
    const existing = this.agent(agentId);
    if (!existing) return false;
    this.db.run("DELETE FROM agents WHERE id = ?", agentId);
    this.db.run(
      "UPDATE sessions SET lead_agent_id = NULL, updated_at = ? WHERE id = ? AND lead_agent_id = ?",
      now(),
      existing.sessionId,
      agentId,
    );
    return true;
  }

  /** The only sanctioned way to change `leadAgentId`: promotes `agentId` and
   *  demotes the session's previous lead in the same write (ADR-0002). */
  setLead(sessionId: string, agentId: string): Session {
    return this.db.transaction(() => {
      const target = this.agent(agentId);
      if (!target || target.sessionId !== sessionId) {
        throw new Error(`agent ${agentId} is not in session ${sessionId}`);
      }
      this.db.run(
        "UPDATE agents SET role = 'member' WHERE session_id = ? AND role = 'lead' AND id <> ?",
        sessionId,
        agentId,
      );
      this.db.run("UPDATE agents SET role = 'lead' WHERE id = ?", agentId);
      const ts = now();
      this.db.run(
        "UPDATE sessions SET lead_agent_id = ?, updated_at = ? WHERE id = ?",
        agentId,
        ts,
        sessionId,
      );
      const session = this.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      return session;
    });
  }

  /** Switch `mode` (ADR-0002: "can be switched later without losing
   *  history") — agents and the transcript are untouched. */
  setMode(sessionId: string, mode: SessionMode): Session {
    this.db.run("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?", mode, now(), sessionId);
    const session = this.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  /** Merge-patch a session's round-table settings (`sessions.updateSettings`). */
  updateSettings(sessionId: string, patch: SessionSettingsPatch): Session {
    const existing = this.get(sessionId);
    if (!existing) throw new Error(`unknown session: ${sessionId}`);
    const merged: SessionSettings = SessionSettingsSchema.parse({ ...existing.settings, ...patch });
    this.db.run(
      "UPDATE sessions SET settings_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(merged),
      now(),
      sessionId,
    );
    const session = this.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  /** Effective mention name for every agent currently in `sessionId` — a
   *  legacy row with a NULL `mention_name` column counts as
   *  `deriveMentionName(name)`, exactly what `rowToAgent` reads it as. */
  private uniqueMentionNameInSession(
    sessionId: string,
    base: string,
    excludeAgentId?: string,
  ): string {
    const rows = this.db.all<{ id: string; name: string; mention_name: string | null }>(
      "SELECT id, name, mention_name FROM agents WHERE session_id = ?",
      sessionId,
    );
    const used = new Set(
      rows
        .filter((r) => r.id !== excludeAgentId)
        .map((r) => r.mention_name ?? deriveMentionName(r.name)),
    );
    return uniqueMentionName(used, base);
  }

  private nextAgentOrder(sessionId: string): number {
    const row = this.db.get<{ n: number | null }>(
      "SELECT MAX(order_index) AS n FROM agents WHERE session_id = ?",
      sessionId,
    );
    return row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
  }

  get(id: string): Session | null {
    const row = this.db.get<Row>("SELECT * FROM sessions WHERE id = ?", id);
    return row ? rowToSession(row) : null;
  }

  list(opts: { projectId?: string; includeArchived?: boolean } = {}): Session[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    if (!opts.includeArchived) clauses.push("archived = 0");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .all<Row>(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC`, ...params)
      .map(rowToSession);
  }

  agents(sessionId: string): Agent[] {
    return this.db
      .all<Row>("SELECT * FROM agents WHERE session_id = ? ORDER BY created_at, rowid", sessionId)
      .map(rowToAgent);
  }

  agent(agentId: string): Agent | null {
    const row = this.db.get<Row>("SELECT * FROM agents WHERE id = ?", agentId);
    return row ? rowToAgent(row) : null;
  }

  setStatus(id: string, status: SessionStatus): Session | null {
    this.db.run(
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
      status,
      now(),
      id,
    );
    return this.get(id);
  }

  setTitle(id: string, title: string): Session | null {
    this.db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", title, now(), id);
    return this.get(id);
  }

  setArchived(id: string, archived: boolean): Session | null {
    this.db.run(
      "UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?",
      boolToInt(archived),
      now(),
      id,
    );
    return this.get(id);
  }

  touch(id: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", now(), id);
  }
}

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

function rowToTurn(row: Row): Turn {
  return TurnSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id ?? null,
    role: row.role,
    status: row.status,
    parentTurnId: row.parent_turn_id ?? null,
    hopIndex: Number(row.hop_index ?? 0),
    mentions: fromJson<string[]>(row.mentions_json, []),
    triggeredByTurnId: row.triggered_by_turn_id ?? null,
    speakerLabel: (row.speaker_label as string | null) ?? undefined,
    createdAt: Number(row.created_at),
  });
}

export class TurnsRepo {
  constructor(private readonly db: Database) {}

  create(input: {
    sessionId: string;
    agentId?: string | null;
    role: TurnRole;
    status?: TurnStatus;
    parentTurnId?: string | null;
    hopIndex?: number;
    /** Agent ids this turn's text @-addresses (R11 dispatch). */
    mentions?: string[];
    /** The turn whose @-mention caused this one — see `TurnSchema`'s doc
     *  comment for how this differs from `parentTurnId`. */
    triggeredByTurnId?: string | null;
    /** Rendered round-table header, e.g. `"@codex"`. */
    speakerLabel?: string;
  }): Turn {
    const turn: Turn = {
      id: newId("turn"),
      sessionId: input.sessionId,
      agentId: input.agentId ?? null,
      role: input.role,
      status: input.status ?? "done",
      parentTurnId: input.parentTurnId ?? null,
      hopIndex: input.hopIndex ?? 0,
      mentions: input.mentions ?? [],
      triggeredByTurnId: input.triggeredByTurnId ?? null,
      ...(input.speakerLabel !== undefined ? { speakerLabel: input.speakerLabel } : {}),
      createdAt: now(),
    };
    this.db.run(
      `INSERT INTO turns
         (id, session_id, agent_id, role, status, parent_turn_id, hop_index,
          mentions_json, triggered_by_turn_id, speaker_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      turn.id,
      turn.sessionId,
      turn.agentId,
      turn.role,
      turn.status,
      turn.parentTurnId ?? null,
      turn.hopIndex,
      toJson(turn.mentions.length > 0 ? turn.mentions : null),
      turn.triggeredByTurnId ?? null,
      turn.speakerLabel ?? null,
      turn.createdAt,
    );
    return turn;
  }

  get(id: string): Turn | null {
    const row = this.db.get<Row>("SELECT * FROM turns WHERE id = ?", id);
    return row ? rowToTurn(row) : null;
  }

  list(sessionId: string): Turn[] {
    return this.db
      .all<Row>(
        // rowid, not id: two turns created in the same millisecond tie on
        // created_at, and a random UUID would then decide the transcript order.
        // rowid is SQLite's insertion order, so the tie-break is deterministic.
        "SELECT * FROM turns WHERE session_id = ? ORDER BY created_at, rowid",
        sessionId,
      )
      .map(rowToTurn);
  }

  setStatus(id: string, status: TurnStatus): Turn | null {
    this.db.run("UPDATE turns SET status = ? WHERE id = ?", status, id);
    return this.get(id);
  }

  /** Is any turn in this session still `streaming`? */
  hasStreaming(sessionId: string): boolean {
    return (
      this.db.get<Row>(
        "SELECT 1 AS n FROM turns WHERE session_id = ? AND status = 'streaming' LIMIT 1",
        sessionId,
      ) !== undefined
    );
  }
}

// ---------------------------------------------------------------------------
// blocks (SPEC's tool_calls, generalised — see migrations/0001_init.sql)
// ---------------------------------------------------------------------------

/** Columns hoisted out of the payload; the rest of the block lives in JSON. */
const BLOCK_ENVELOPE_KEYS = new Set([
  "id",
  "turnId",
  "sessionId",
  "index",
  "kind",
  "createdAt",
  "updatedAt",
]);

function rowToBlock(row: Row): Block {
  const payload = fromJson<Record<string, unknown>>(row.payload_json, {});
  return BlockSchema.parse({
    ...payload,
    id: row.id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    kind: row.kind,
    index: Number(row.block_index),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

export class BlocksRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert or replace by id. Streaming re-sends the same block as it grows
   * (R23–R26: persist incrementally, never rebuild the turn), so upsert is the
   * only write path.
   */
  /**
   * Upsert by id. `kind` is updated too, deliberately: a block whose kind
   * changes mid-turn is a real thing (the Claude SDK's settled `assistant`
   * message can drop a thinking block its own delta stream sent, so the same
   * block key is re-emitted as `text`). Leaving `kind` alone stored the new
   * payload under the old kind — the live transcript showed text and the
   * relaunched one a collapsed "thinking" card with the answer inside, which
   * SPEC R15 ("relaunching restores the session") forbids.
   */
  upsert(block: Block): Block {
    const parsed = BlockSchema.parse(block);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!BLOCK_ENVELOPE_KEYS.has(key)) payload[key] = value;
    }
    this.db.run(
      `INSERT INTO blocks (id, turn_id, session_id, kind, block_index, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind         = excluded.kind,
         block_index  = excluded.block_index,
         payload_json = excluded.payload_json,
         updated_at   = excluded.updated_at`,
      parsed.id,
      parsed.turnId,
      parsed.sessionId,
      parsed.kind,
      parsed.index,
      JSON.stringify(payload),
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  get(id: string): Block | null {
    const row = this.db.get<Row>("SELECT * FROM blocks WHERE id = ?", id);
    return row ? rowToBlock(row) : null;
  }

  listByTurn(turnId: string): Block[] {
    return this.db
      .all<Row>("SELECT * FROM blocks WHERE turn_id = ? ORDER BY block_index, rowid", turnId)
      .map(rowToBlock);
  }

  listBySession(sessionId: string): Block[] {
    return this.db
      .all<Row>(
        `SELECT b.* FROM blocks b
           JOIN turns t ON t.id = b.turn_id
          WHERE b.session_id = ?
          ORDER BY t.created_at, t.rowid, b.block_index, b.rowid`,
        sessionId,
      )
      .map(rowToBlock);
  }

  /** Next free index inside a turn. */
  nextIndex(turnId: string): number {
    const row = this.db.get<{ n: number | null }>(
      "SELECT MAX(block_index) AS n FROM blocks WHERE turn_id = ?",
      turnId,
    );
    return row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
  }
}

// ---------------------------------------------------------------------------
// tool_outputs — full values a block's `outputRef` points at (migration 0002)
// ---------------------------------------------------------------------------

function rowToToolOutput(row: Row): ToolOutput {
  return ToolOutputSchema.parse({
    id: row.id,
    blockId: row.block_id,
    content: fromJson<unknown>(row.content, null),
    createdAt: Number(row.created_at),
  });
}

export class ToolOutputsRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert or replace by id. Callers pass the id they already handed out as a
   * block's `outputRef` (or omit it to mint one), the same upsert-by-id shape
   * as `BlocksRepo.upsert` so a value can be (re)written as it grows.
   */
  put(input: { id?: string; blockId: string; content: unknown }): ToolOutput {
    const full = ToolOutputSchema.parse({
      id: input.id ?? newId("toolOutput"),
      blockId: input.blockId,
      content: input.content,
      createdAt: Date.now(),
    });
    this.db.run(
      `INSERT INTO tool_outputs (id, block_id, content, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
      full.id,
      full.blockId,
      // `content` is NOT NULL: unlike `toJson` (used for nullable JSON
      // columns), `null`/`undefined` content still needs a stored string —
      // `JSON.stringify(undefined)` is `undefined`, not a valid SqlValue.
      JSON.stringify(full.content) ?? "null",
      full.createdAt,
    );
    return full;
  }

  get(id: string): ToolOutput | null {
    const row = this.db.get<Row>("SELECT * FROM tool_outputs WHERE id = ?", id);
    return row ? rowToToolOutput(row) : null;
  }
}

// ---------------------------------------------------------------------------
// usage_events
// ---------------------------------------------------------------------------

function rowToUsageEvent(row: Row): UsageEvent {
  return UsageEventSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id ?? null,
    turnId: row.turn_id ?? null,
    backend: row.backend,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    costUsd: Number(row.cost_usd),
    ts: Number(row.ts),
  });
}

export class UsageRepo {
  constructor(private readonly db: Database) {}

  record(event: Omit<UsageEvent, "id" | "ts"> & { id?: string; ts?: number }): UsageEvent {
    const full = UsageEventSchema.parse({
      ...event,
      id: event.id ?? newId("usage"),
      ts: event.ts ?? now(),
    });
    this.db.run(
      `INSERT INTO usage_events
         (id, session_id, agent_id, turn_id, backend, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      full.id,
      full.sessionId,
      full.agentId,
      full.turnId,
      full.backend,
      full.model,
      full.inputTokens,
      full.outputTokens,
      full.cacheReadTokens,
      full.cacheCreationTokens,
      full.costUsd,
      full.ts,
    );
    return full;
  }

  listBySession(sessionId: string): UsageEvent[] {
    return this.db
      .all<Row>("SELECT * FROM usage_events WHERE session_id = ? ORDER BY ts", sessionId)
      .map(rowToUsageEvent);
  }

  /** Totals for one agent across every session — `agents.describe`'s "cost so
   *  far" (R13). `cached` collapses `cache_read`/`cache_creation` into the one
   *  number the info card shows (see `AgentUsageSummarySchema`). */
  totalsByAgent(agentId: string): { input: number; output: number; cached: number; costUsd: number } {
    const row = this.db.get<Record<string, number | null>>(
      `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens) + SUM(cache_creation_tokens), 0) AS cached_tokens,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd
         FROM usage_events WHERE agent_id = ?`,
      agentId,
    );
    return {
      input: Number(row?.input_tokens ?? 0),
      output: Number(row?.output_tokens ?? 0),
      cached: Number(row?.cached_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
    };
  }

  /** Totals for the live meter (R23). */
  totalsBySession(sessionId: string): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  } {
    const row = this.db.get<Record<string, number | null>>(
      `SELECT COALESCE(SUM(input_tokens), 0)          AS input_tokens,
              COALESCE(SUM(output_tokens), 0)         AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cost_usd), 0)              AS cost_usd
         FROM usage_events WHERE session_id = ?`,
      sessionId,
    );
    return {
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row?.cache_creation_tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
    };
  }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Key/value rows, read back as one validated `Settings` object. Unknown keys in
 * the table are ignored (a downgrade must not crash), and missing keys fall back
 * to the shipping defaults.
 */
export class SettingsRepo {
  constructor(private readonly db: Database) {}

  all(): Settings {
    const rows = this.db.all<Row>("SELECT key, value_json FROM settings");
    const raw: Record<string, unknown> = {};
    for (const row of rows) {
      const key = String(row.key);
      if (!(key in DEFAULT_SETTINGS)) continue;
      raw[key] = fromJson<unknown>(row.value_json, undefined);
    }
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  patch(patch: Partial<Settings>): Settings {
    const merged = SettingsSchema.parse({ ...this.all(), ...patch });
    const ts = now();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(merged)) {
        this.db.run(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                          updated_at = excluded.updated_at`,
          key,
          JSON.stringify(value),
          ts,
        );
      }
    });
    return merged;
  }

  /** Arbitrary non-user state (window geometry, last session id, …). */
  getRaw<T>(key: string, fallback: T): T {
    const row = this.db.get<Row>("SELECT value_json FROM settings WHERE key = ?", key);
    return row ? fromJson<T>(row.value_json, fallback) : fallback;
  }

  setRaw(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value ?? null),
      now(),
    );
  }
}
