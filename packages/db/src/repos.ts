/**
 * Repositories — the only code that writes SQL. Each one maps snake_case rows to
 * the camelCase domain types from `@capygen/shared` and validates on the way out,
 * so a schema drift shows up as a parse error at the boundary instead of a
 * malformed object three layers up.
 */
import {
  AgentSchema,
  BlockSchema,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_SETTINGS,
  DevServerSchema,
  GlobalSettingsSchema,
  McpServerEntrySchema,
  PluginEntrySchema,
  ProjectSchema,
  SessionSchema,
  SessionSettingsSchema,
  ShareBundleSchema,
  ShareCommentSchema,
  ShareCountsSchema,
  ShareEntrySchema,
  ShareSourceSchema,
  SettingsSchema,
  SkillEntrySchema,
  TaskSchema,
  TranscriptImportEntrySchema,
  TranscriptImportMetadataSchema,
  TranscriptImportRecordSchema,
  TranscriptImportSnapshotSchema,
  ToolOutputSchema,
  ToolPolicyEntrySchema,
  TurnSchema,
  UsageEventSchema,
  UsageRangeSchema,
  buildUsageReport,
  WorkspaceLayoutSchema,
  deriveMentionName,
  mergeGlobalSettingsPatch,
  newId,
  resetGlobalSettingsSection,
  translateDefaultModelAlias,
  deriveDefaultModel,
  SETTINGS_COMPAT_FIELDS,
  SETTINGS_FLAT_ONLY_FIELDS,
  type Agent,
  type AgentDraft,
  type AgentPatch,
  type AgentRole,
  type Backend,
  type Block,
  type DevServer,
  type DevServerDraft,
  type DevServerPatch,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type ModelCatalogue,
  type GlobalSettingsSection,
  type McpServerEntry,
  type McpServerEntryPatch,
  type McpServerScope,
  type PluginEntry,
  type Project,
  type RoutingTarget,
  type Session,
  type SessionMode,
  type SessionSettings,
  type SessionSettingsPatch,
  type SessionStatus,
  type Settings,
  type ShareBundle,
  type ShareComment,
  type ShareCounts,
  type ShareEntry,
  type ShareSource,
  type SkillEntry,
  type SkillScope,
  type Task,
  type TaskPatch,
  type TaskStatus,
  type TranscriptImportEntry,
  type TranscriptImportRecord,
  type TranscriptImportSnapshot,
  type ToolOutput,
  type ToolPolicyEntry,
  type ToolPolicyScope,
  type Turn,
  type TurnRole,
  type TurnStatus,
  type UsageEvent,
  type UsageRange,
  type UsageReport,
  type WorkspaceLayout,
} from "@capygen/shared";
import { canonicalSha256 } from "./canonicalJson.js";
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
    origin: row.origin ?? "live",
    artifactKind: row.artifact_kind ?? null,
    continuationSourceSessionId: row.continuation_source_session_id ?? null,
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

  private assertLiveMutable(sessionId: string): void {
    const row = this.db.get<{ origin: string }>("SELECT origin FROM sessions WHERE id = ?", sessionId);
    if (row?.origin === "import") {
      throw new Error(`session ${sessionId} is a read-only import artifact`);
    }
  }

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
    this.assertLiveMutable(sessionId);
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
    this.assertLiveMutable(existing.sessionId);
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
    this.assertLiveMutable(existing.sessionId);
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
      this.assertLiveMutable(sessionId);
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
    this.assertLiveMutable(sessionId);
    this.db.run("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?", mode, now(), sessionId);
    const session = this.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  /** Merge-patch a session's round-table settings (`sessions.updateSettings`). */
  updateSettings(sessionId: string, patch: SessionSettingsPatch): Session {
    const existing = this.get(sessionId);
    if (!existing) throw new Error(`unknown session: ${sessionId}`);
    this.assertLiveMutable(sessionId);
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
    this.assertLiveMutable(id);
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
// transcript imports
// ---------------------------------------------------------------------------

export interface TranscriptImportCommitResult {
  session: Session;
  duplicate: boolean;
}

export interface TranscriptImportPage {
  offset?: number;
  limit?: number;
}

function importPage(input: TranscriptImportPage): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("import entry offset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("import entry limit must be an integer from 1 to 100");
  }
  return { offset, limit };
}

export class ImportsRepo {
  constructor(private readonly db: Database) {}

  commit(input: {
    projectId: string;
    snapshot: TranscriptImportSnapshot;
  }): TranscriptImportCommitResult {
    const snapshot = TranscriptImportSnapshotSchema.parse(input.snapshot);
    const destination = this.db.get<{ id: string }>(
      "SELECT id FROM projects WHERE id = ?",
      input.projectId,
    );
    if (!destination) throw new Error(`unknown project: ${input.projectId}`);
    const duplicate = this.findDuplicate(snapshot);
    if (duplicate) return { session: duplicate, duplicate: true };

    try {
      return this.db.transaction(() => {
        // Recheck inside the transaction so two confirmations on the same
        // connection cannot create two artifacts between lookup and insert.
        const raced = this.findDuplicate(snapshot);
        if (raced) return { session: raced, duplicate: true };

        const project = this.db.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", input.projectId);
        if (!project) throw new Error(`unknown project: ${input.projectId}`);

        const sessionId = newId("session");
        const importedAt = now();
        const title = snapshot.title ?? `Imported ${snapshot.backend} transcript`;
        this.db.run(
          `INSERT INTO sessions
             (id, project_id, origin, artifact_kind, continuation_source_session_id, mode,
              lead_agent_id, title, status, archived, created_at, updated_at)
           VALUES (?, ?, 'import', 'native-transcript', NULL, 'solo', NULL, ?, 'idle', 0, ?, ?)`,
          sessionId,
          input.projectId,
          title,
          importedAt,
          importedAt,
        );

        const { entries, ...metadata } = snapshot;
        this.db.run(
          `INSERT INTO transcript_imports
             (session_id, backend, native_id, source_path, source_sha256, format,
              metadata_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          snapshot.backend,
          snapshot.nativeId,
          snapshot.sourcePath,
          snapshot.sourceSha256,
          snapshot.format,
          JSON.stringify(metadata),
          importedAt,
        );
        for (const entry of entries) {
          this.db.run(
            `INSERT INTO transcript_import_entries (session_id, entry_index, entry_json)
             VALUES (?, ?, ?)`,
            sessionId,
            entry.index,
            JSON.stringify(entry),
          );
        }

        const session = new SessionsRepo(this.db).get(sessionId);
        if (!session) throw new Error("import session vanished immediately after insert");
        return { session, duplicate: false };
      });
    } catch (error) {
      // A different connection may have won the provenance UNIQUE race. Only
      // translate the failure when that exact reviewed snapshot now exists.
      const raced = this.findDuplicate(snapshot);
      if (raced) return { session: raced, duplicate: true };
      throw error;
    }
  }

  get(sessionId: string): TranscriptImportRecord | null {
    const row = this.db.get<Row>("SELECT * FROM transcript_imports WHERE session_id = ?", sessionId);
    if (!row) return null;
    const metadata = TranscriptImportMetadataSchema.parse(fromJson<unknown>(row.metadata_json, null));
    return TranscriptImportRecordSchema.parse({
      sessionId,
      importedAt: Number(row.imported_at),
      ...metadata,
    });
  }

  entries(sessionId: string, page: TranscriptImportPage = {}): TranscriptImportEntry[] {
    const { offset, limit } = importPage(page);
    return this.db
      .all<{ entry_json: string }>(
        `SELECT entry_json FROM transcript_import_entries
         WHERE session_id = ? ORDER BY entry_index LIMIT ? OFFSET ?`,
        sessionId,
        limit,
        offset,
      )
      .map((row) => TranscriptImportEntrySchema.parse(fromJson<unknown>(row.entry_json, null)));
  }

  /** Last entries in chronological order, bounded for continuation previews. */
  tail(sessionId: string, limit = 100): TranscriptImportEntry[] {
    const page = importPage({ limit });
    return this.db
      .all<{ entry_json: string }>(
        `SELECT entry_json FROM transcript_import_entries
         WHERE session_id = ? ORDER BY entry_index DESC LIMIT ?`,
        sessionId,
        page.limit,
      )
      .reverse()
      .map((row) => TranscriptImportEntrySchema.parse(fromJson<unknown>(row.entry_json, null)));
  }

  linkContinuation(sessionId: string, sourceSessionId: string): Session {
    return this.db.transaction(() => {
      const destination = this.db.get<{
        origin: string;
        continuation_source_session_id: string | null;
        lead_agent_id: string | null;
        status: string;
        archived: number;
      }>(
        `SELECT origin, continuation_source_session_id, lead_agent_id, status, archived
         FROM sessions WHERE id = ?`,
        sessionId,
      );
      if (!destination) throw new Error(`unknown session: ${sessionId}`);
      if (destination.origin !== "live") throw new Error("continuation destination must be a live session");
      if (destination.continuation_source_session_id !== null) {
        throw new Error("continuation destination is already linked");
      }
      if (destination.lead_agent_id === null) {
        throw new Error("continuation destination must have a lead agent with a current backend");
      }
      if (destination.status !== "idle" || destination.archived !== 0) {
        throw new Error("continuation destination must be an idle, unarchived fresh session");
      }
      const hasTurns = this.db.get<{ present: number }>(
        "SELECT 1 AS present FROM turns WHERE session_id = ? LIMIT 1",
        sessionId,
      );
      if (hasTurns) throw new Error("continuation destination must be a fresh session with no turns");
      // The artifact kind is asserted, not inferred from the absence of a row
      // in this table. A shared bundle is also `origin = 'import'`, and the
      // only reason it fails this lookup today is that it lives in a sibling
      // table — a guard that would quietly disappear the moment anything
      // generalized the join. Native continuation stays native explicitly.
      const source = this.db.get<{ session_id: string }>(
        `SELECT i.session_id FROM transcript_imports i
         JOIN sessions s ON s.id = i.session_id
         WHERE i.session_id = ? AND s.origin = 'import'
           AND s.artifact_kind = 'native-transcript'`,
        sourceSessionId,
      );
      if (!source) throw new Error("continuation source must be a native imported source session");

      this.db.run(
        "UPDATE sessions SET continuation_source_session_id = ?, updated_at = ? WHERE id = ?",
        sourceSessionId,
        now(),
        sessionId,
      );
      const linked = new SessionsRepo(this.db).get(sessionId);
      if (!linked) throw new Error(`unknown session: ${sessionId}`);
      return linked;
    });
  }

  private findDuplicate(snapshot: TranscriptImportSnapshot): Session | null {
    const row = this.db.get<{ session_id: string }>(
      `SELECT session_id FROM transcript_imports
       WHERE backend = ? AND native_id = ? AND source_sha256 = ?`,
      snapshot.backend,
      snapshot.nativeId,
      snapshot.sourceSha256,
    );
    return row ? new SessionsRepo(this.db).get(row.session_id) : null;
  }
}

// ---------------------------------------------------------------------------
// shared bundles
// ---------------------------------------------------------------------------

/** One received bundle's provenance and tallies, without its content. */
export interface ShareImportRecord {
  sessionId: string;
  bundleId: string;
  /** Canonical SHA-256 of the validated bundle; see `canonicalJson.ts`. */
  contentSha256: string;
  schemaVersion: number;
  appVersion: string;
  /** The writer's own timestamp, kept as the ISO string the bundle carried. */
  bundleCreatedAt: string;
  importedAt: number;
  source: ShareSource;
  counts: ShareCounts;
}

export interface ShareImportCommitResult {
  session: Session;
  duplicate: boolean;
}

interface ShareProvenanceRow {
  session_id: string;
  content_sha256: string;
}

/**
 * Read-only shared-bundle artifacts (Phase 9 / P15).
 *
 * A committed bundle is a sibling of a native transcript import, not a variant
 * of one: same `origin = 'import'` read-only guards, distinguished by
 * `sessions.artifact_kind = 'shared-bundle'`. It gets no agents, no lead and no
 * backend identity, because nothing in a bundle can resume anything.
 *
 * Every entry point re-validates with `ShareBundleSchema` before it touches the
 * database. A direct repository caller is not a trusted caller: the bundle
 * originated in a file from another machine, and the schema is the only thing
 * standing between that file and these tables.
 */
export class SharesRepo {
  constructor(private readonly db: Database) {}

  /**
   * Persist one validated bundle atomically.
   *
   * Identity is the bundle id. The same content re-imported is an idempotent
   * duplicate; *different* content claiming an id that is already taken is a
   * conflict and refused, because silently accepting it would let a tampered
   * file overwrite or shadow the artifact a reader already reviewed.
   */
  commit(input: { projectId: string; bundle: ShareBundle }): ShareImportCommitResult {
    const bundle = ShareBundleSchema.parse(input.bundle);
    const contentSha256 = canonicalSha256(bundle);

    const prior = this.provenance(bundle.bundleId);
    if (prior) return this.resolvePrior(prior, bundle.bundleId, contentSha256);

    try {
      return this.db.transaction(() => {
        // Recheck inside the transaction so two confirmations of the same
        // bundle cannot both insert between the lookup and the write.
        const raced = this.provenance(bundle.bundleId);
        if (raced) return this.resolvePrior(raced, bundle.bundleId, contentSha256);

        const project = this.db.get<{ id: string }>(
          "SELECT id FROM projects WHERE id = ?",
          input.projectId,
        );
        if (!project) throw new Error(`unknown project: ${input.projectId}`);

        const sessionId = newId("session");
        const importedAt = now();
        const title = bundle.source.title ?? "Shared session";
        // `sessions.mode` admits only the two live modes. A bundle may name
        // `custom` for display; the artifact is stored as `solo` and the
        // bundle's own mode is preserved verbatim in the metadata below.
        const mode = bundle.source.mode === "round-table" ? "round-table" : "solo";
        this.db.run(
          `INSERT INTO sessions
             (id, project_id, origin, artifact_kind, continuation_source_session_id, mode,
              lead_agent_id, title, status, archived, created_at, updated_at)
           VALUES (?, ?, 'import', 'shared-bundle', NULL, ?, NULL, ?, 'idle', 0, ?, ?)`,
          sessionId,
          input.projectId,
          mode,
          title,
          importedAt,
          importedAt,
        );

        this.db.run(
          `INSERT INTO share_imports
             (session_id, bundle_id, content_sha256, schema_version, app_version,
              bundle_created_at, metadata_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          bundle.bundleId,
          contentSha256,
          bundle.version,
          bundle.appVersion,
          bundle.createdAt,
          JSON.stringify({ source: bundle.source, counts: bundle.counts }),
          importedAt,
        );

        for (const entry of bundle.entries) {
          this.db.run(
            `INSERT INTO share_import_entries (session_id, entry_index, entry_json)
             VALUES (?, ?, ?)`,
            sessionId,
            entry.index,
            JSON.stringify(entry),
          );
        }

        // Bundle order is insert order, which is also what satisfies the
        // reply-edge foreign key: the schema admits only replies to earlier
        // comments, so a parent is always already present.
        bundle.comments.forEach((comment, ordinal) => {
          this.db.run(
            `INSERT INTO share_import_comments
               (session_id, comment_id, ordinal, entry_index, author, body, created_at,
                reply_to_id, resolved)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sessionId,
            comment.id,
            ordinal,
            comment.entryIndex,
            comment.author,
            comment.body,
            comment.createdAt,
            comment.replyToId,
            boolToInt(comment.resolved),
          );
        });

        const session = new SessionsRepo(this.db).get(sessionId);
        if (!session) throw new Error("shared session vanished immediately after insert");
        return { session, duplicate: false };
      });
    } catch (error) {
      // A different connection may have won the bundle-id UNIQUE race. Only
      // translate the failure when that exact bundle now exists; anything else
      // (a full disk, a constraint this bundle really violated) still throws.
      const raced = this.provenance(bundle.bundleId);
      if (raced && raced.content_sha256 === contentSha256) {
        return this.resolvePrior(raced, bundle.bundleId, contentSha256);
      }
      throw error;
    }
  }

  /** Provenance and tallies for a shared session, or null for anything else. */
  get(sessionId: string): ShareImportRecord | null {
    const row = this.db.get<Row>("SELECT * FROM share_imports WHERE session_id = ?", sessionId);
    if (!row) return null;
    const metadata = fromJson<{ source: unknown; counts: unknown }>(row.metadata_json, {
      source: null,
      counts: null,
    });
    return {
      sessionId,
      bundleId: String(row.bundle_id),
      contentSha256: String(row.content_sha256),
      schemaVersion: Number(row.schema_version),
      appVersion: String(row.app_version),
      bundleCreatedAt: String(row.bundle_created_at),
      importedAt: Number(row.imported_at),
      source: ShareSourceSchema.parse(metadata.source),
      counts: ShareCountsSchema.parse(metadata.counts),
    };
  }

  /** The session holding this bundle id, for duplicate reporting before import. */
  findByBundleId(bundleId: string): Session | null {
    const row = this.db.get<{ session_id: string }>(
      "SELECT session_id FROM share_imports WHERE bundle_id = ?",
      bundleId,
    );
    return row ? new SessionsRepo(this.db).get(row.session_id) : null;
  }

  /**
   * Which artifact table owns this session, or null when it is a live one.
   * A reader must select its artifact source by this, never by `origin` alone.
   */
  artifactKindOf(sessionId: string): "native-transcript" | "shared-bundle" | null {
    const row = this.db.get<{ artifact_kind: string | null }>(
      "SELECT artifact_kind FROM sessions WHERE id = ?",
      sessionId,
    );
    const kind = row?.artifact_kind ?? null;
    return kind === "native-transcript" || kind === "shared-bundle" ? kind : null;
  }

  entries(sessionId: string, page: TranscriptImportPage = {}): ShareEntry[] {
    const { offset, limit } = importPage(page);
    return this.db
      .all<{ entry_json: string }>(
        `SELECT entry_json FROM share_import_entries
         WHERE session_id = ? ORDER BY entry_index LIMIT ? OFFSET ?`,
        sessionId,
        limit,
        offset,
      )
      .map((row) => ShareEntrySchema.parse(fromJson<unknown>(row.entry_json, null)));
  }

  /** Last entries in chronological order, bounded — the continuation preview. */
  tail(sessionId: string, limit = 100): ShareEntry[] {
    const page = importPage({ limit });
    return this.db
      .all<{ entry_json: string }>(
        `SELECT entry_json FROM share_import_entries
         WHERE session_id = ? ORDER BY entry_index DESC LIMIT ?`,
        sessionId,
        page.limit,
      )
      .reverse()
      .map((row) => ShareEntrySchema.parse(fromJson<unknown>(row.entry_json, null)));
  }

  /** Every comment in the bundle's own order. Bounded by the bundle schema. */
  comments(sessionId: string): ShareComment[] {
    return this.db
      .all<Row>(
        `SELECT * FROM share_import_comments WHERE session_id = ? ORDER BY ordinal`,
        sessionId,
      )
      .map((row) =>
        ShareCommentSchema.parse({
          id: row.comment_id,
          entryIndex: row.entry_index === null ? null : Number(row.entry_index),
          author: row.author,
          body: row.body,
          createdAt: row.created_at,
          replyToId: row.reply_to_id ?? null,
          resolved: intToBool(row.resolved),
        }),
      );
  }

  private provenance(bundleId: string): ShareProvenanceRow | undefined {
    return this.db.get<ShareProvenanceRow>(
      "SELECT session_id, content_sha256 FROM share_imports WHERE bundle_id = ?",
      bundleId,
    );
  }

  private resolvePrior(
    prior: ShareProvenanceRow,
    bundleId: string,
    contentSha256: string,
  ): ShareImportCommitResult {
    if (prior.content_sha256 !== contentSha256) {
      throw new Error(
        `a different bundle is already imported with id ${bundleId}; ` +
          "the same id must always carry the same content",
      );
    }
    const session = new SessionsRepo(this.db).get(prior.session_id);
    if (!session) throw new Error(`shared session vanished: ${prior.session_id}`);
    return { session, duplicate: true };
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
    costKnown: intToBool(row.cost_known),
    ts: Number(row.ts),
  });
}

export class UsageRepo {
  constructor(private readonly db: Database) {}

  record(event: Omit<UsageEvent, "id" | "ts"> & { id?: string; ts?: number }): UsageEvent {
    const full = UsageEventSchema.parse({
      ...event,
      costKnown: event.costKnown ?? event.costUsd > 0,
      id: event.id ?? newId("usage"),
      ts: event.ts ?? now(),
    });
    this.db.run(
      `INSERT INTO usage_events
         (id, session_id, agent_id, turn_id, backend, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, cost_known, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      boolToInt(full.costKnown ?? false),
      full.ts,
    );
    return full;
  }

  listBySession(sessionId: string): UsageEvent[] {
    return this.db
      .all<Row>("SELECT * FROM usage_events WHERE session_id = ? ORDER BY ts", sessionId)
      .map(rowToUsageEvent);
  }

  /** Select the half-open range first, then aggregate only those rows and their
   *  session titles. `buildUsageReport` owns IANA-zone day boundaries. */
  report(range: UsageRange): UsageReport {
    const parsed = UsageRangeSchema.parse(range);
    const rows = this.db.all<Row>(
      `WITH ranged AS (
         SELECT * FROM usage_events WHERE ts >= ? AND ts < ?
       )
       SELECT ranged.*, sessions.title AS session_title
         FROM ranged
         JOIN sessions ON sessions.id = ranged.session_id
        ORDER BY ranged.ts, ranged.id`,
      parsed.from,
      parsed.to,
    );
    const events = rows.map(rowToUsageEvent);
    const titles = new Map<string, string>();
    for (const row of rows) {
      titles.set(String(row.session_id), String(row.session_title));
    }
    return buildUsageReport(events, parsed, titles);
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
/**
 * [7-P1] Phase 2's flat `Settings`, as a **compatibility view** over the
 * canonical `GlobalSettings`.
 *
 * There used to be two mutable authorities: this repo stored every field, the
 * settings hub stored its own, and `SettingsService` *projected* one onto the
 * other after each hub write. A `settings.set` therefore won until the next
 * `settings.patch` silently reverted it, and which of the two a given consumer
 * saw depended on the order they happened to run in.
 *
 * The split is now by field, and it is enforced here rather than one layer up,
 * because shipping code calls `store.settings.all()` directly:
 *
 *  - `SETTINGS_COMPAT_FIELDS` (theme, permissionMode, defaultBackend,
 *    defaultModel, compactionThreshold, closeToTray) are **derived** from the
 *    canonical object on read and **translated onto it** on write. They are not
 *    stored in this table any more.
 *  - `SETTINGS_FLAT_ONLY_FIELDS` (hopCap, showThinking, uiFontSize) have no
 *    canonical home and stay exactly where they are — including while the
 *    canonical row is unreadable, since they were never in it.
 *  - `getRaw`/`setRaw` bookkeeping (window geometry, backend session ids) is
 *    untouched by any of this.
 *
 * This table is key/value, not fixed columns, so an overlapping key is genuinely
 * *absent* rather than defaulted — which is what makes the one-time migration
 * able to tell "the user set this" from "the schema supplied this".
 */
export class SettingsRepo {
  constructor(
    private readonly db: Database,
    private readonly globalSettings: GlobalSettingsRepo,
    /** Injected by the desktop; see `CapygenStore.setModelCatalogue`. */
    private readonly catalogue: () => ModelCatalogue | undefined = () => undefined,
  ) {}

  all(): Settings {
    const global = this.globalSettings.all();
    return SettingsSchema.parse({
      ...this.flatOnlyValues(),
      theme: global.appearance.theme,
      // Claude's canonical default, or the safe mode — never one app-wide value
      // applied to every backend, which is what this field used to be.
      permissionMode: global.backends.claude.permissionMode ?? DEFAULT_SETTINGS.permissionMode,
      defaultBackend: global.general.defaultBackend,
      defaultModel: deriveDefaultModel(global, this.catalogue()),
      compactionThreshold: clampFraction(global.efficiency.compactionThresholdPct / 100),
      closeToTray: global.closeToTray,
    });
  }

  /**
   * Write in the old shape. The overlapping half becomes one canonical patch
   * and the flat-only half stays here; both land in **one** transaction, so a
   * failure on either side leaves neither applied.
   */
  patch(patch: Partial<Settings>): Settings {
    const canonical = this.canonicalPatchFor(patch);
    const flatOnly: [string, unknown][] = [];
    for (const key of SETTINGS_FLAT_ONLY_FIELDS) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      // [7-P1] Validated **before** the write. Writing an out-of-range value
      // and then hiding it behind a default in `all()` leaves a row on disk
      // that no read ever reports — the settings page shows 3, the table says
      // 900, and nothing tells the caller their write did not take.
      const parsed = flatFieldSchema(key).safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `settings.${key}: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
        );
      }
      flatOnly.push([key, parsed.data]);
    }
    if (!canonical && flatOnly.length === 0) return this.all();
    // [7-P1] A canonical row this build must not rewrite makes the **whole**
    // compatibility surface read-only, flat-only fields included. They are
    // still readable, and internal `getRaw`/`setRaw` state is unaffected; what
    // is refused is a user preference write while the authority is unreadable.
    const read = this.globalSettings.read();
    if (!read.writable) throw new Error(read.reason ?? "the stored settings are read-only");
    this.db.transaction(() => {
      if (canonical) this.globalSettings.patch(canonical);
      const ts = now();
      for (const [key, value] of flatOnly) this.writeRaw(key, value, ts);
    });
    return this.all();
  }

  /** The canonical patch a flat write means, or null when it names none. */
  private canonicalPatchFor(patch: Partial<Settings>): GlobalSettingsPatch | null {
    const next: GlobalSettingsPatch = {};
    const general: Record<string, unknown> = {};
    const backends: Record<string, Record<string, unknown>> = {};
    if (patch.theme !== undefined) next.appearance = { theme: patch.theme };
    if (patch.closeToTray !== undefined) next.closeToTray = patch.closeToTray;
    if (patch.compactionThreshold !== undefined) {
      next.efficiency = { compactionThresholdPct: Math.round(patch.compactionThreshold * 100) };
    }
    if (patch.defaultBackend !== undefined) general.defaultBackend = patch.defaultBackend;
    if (patch.permissionMode !== undefined) {
      backends.claude = { ...backends.claude, permissionMode: patch.permissionMode };
    }
    // Left as the alias: `GlobalSettingsRepo.patch` translates it onto
    // `backends[selected].model`, including the backend this same patch selects.
    if (patch.defaultModel !== undefined) general.defaultModel = patch.defaultModel;
    if (Object.keys(general).length > 0) next.general = general;
    if (Object.keys(backends).length > 0) next.backends = backends;
    return Object.keys(next).length > 0 ? next : null;
  }

  /**
   * The overlapping keys **actually present** as rows, for the one-time
   * migration. A key that is absent is "the user never set this", which is a
   * different thing from the schema default `all()` would report — and the
   * distinction is the whole reason the migration can be safe.
   */
  presentCompatKeys(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const key of SETTINGS_COMPAT_FIELDS) {
      const row = this.db.get<Row>("SELECT value_json FROM settings WHERE key = ?", key);
      if (!row) continue;
      const value = fromJson<unknown>(row.value_json, undefined);
      if (value !== undefined) out.set(key, value);
    }
    return out;
  }

  /**
   * Delete the overlapping keys outright. Used by the migration once their
   * values have been moved onto the canonical row.
   *
   * A `patch` of shipping defaults would not do: this table is key/value and
   * `patch` writes *every* field of the merged object, so "resetting" the
   * overlapping keys would re-create all six as rows — leaving exactly the
   * second authority the migration exists to remove.
   */
  removeCompatKeys(): void {
    for (const key of SETTINGS_COMPAT_FIELDS) {
      this.db.run("DELETE FROM settings WHERE key = ?", key);
    }
  }

  /**
   * The flat-only preferences, parsed **one key at a time**.
   *
   * [7-P1] Parsing them as one object meant a single corrupt row failed the
   * whole parse and reset the other two to their shipping defaults: a bad
   * `hopCap` silently discarded the user's `showThinking` and `uiFontSize`.
   * Each key stands or falls alone, and an invalid one falls back to its own
   * default rather than taking its siblings with it.
   */
  private flatOnlyValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of SETTINGS_FLAT_ONLY_FIELDS) {
      const row = this.db.get<Row>("SELECT value_json FROM settings WHERE key = ?", key);
      if (!row) continue;
      const raw = fromJson<unknown>(row.value_json, undefined);
      if (raw === undefined) continue;
      const parsed = flatFieldSchema(key).safeParse(raw);
      if (parsed.success) out[key] = parsed.data;
    }
    return out;
  }

  /** Arbitrary non-user state (window geometry, last session id, …). */
  getRaw<T>(key: string, fallback: T): T {
    const row = this.db.get<Row>("SELECT value_json FROM settings WHERE key = ?", key);
    return row ? fromJson<T>(row.value_json, fallback) : fallback;
  }

  setRaw(key: string, value: unknown): void {
    this.writeRaw(key, value ?? null, now());
  }

  private writeRaw(key: string, value: unknown, ts: number): void {
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value ?? null),
      ts,
    );
  }
}

function clampFraction(value: number): number {
  return Math.min(Math.max(value, 0.1), 0.95);
}

/** One flat-only field's own schema, for per-key parse and pre-write checks. */
function flatFieldSchema(key: (typeof SETTINGS_FLAT_ONLY_FIELDS)[number]) {
  return SettingsSchema.shape[key];
}

// ---------------------------------------------------------------------------
// workspace_layouts (migration 0004, Phase 5 SPEC R17)
// ---------------------------------------------------------------------------

function rowToWorkspaceLayout(row: Row): WorkspaceLayout {
  return WorkspaceLayoutSchema.parse({
    projectId: row.project_id,
    layoutJson: fromJson<unknown>(row.layout_json, null),
    updatedAt: Number(row.updated_at),
  });
}

/** One row per project — `layout.get`/`layout.set`. Distinct from
 *  `ProjectsRepo.setLayout` (a Phase 2 placeholder nothing else reads; see
 *  migration 0004's header comment). */
export class WorkspaceLayoutsRepo {
  constructor(private readonly db: Database) {}

  get(projectId: string): WorkspaceLayout | null {
    const row = this.db.get<Row>(
      "SELECT * FROM workspace_layouts WHERE project_id = ?",
      projectId,
    );
    return row ? rowToWorkspaceLayout(row) : null;
  }

  /** Insert or replace the one row a project has. */
  set(projectId: string, layoutJson: unknown): WorkspaceLayout {
    const ts = now();
    this.db.run(
      `INSERT INTO workspace_layouts (project_id, layout_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET layout_json = excluded.layout_json,
                                              updated_at = excluded.updated_at`,
      projectId,
      JSON.stringify(layoutJson),
      ts,
    );
    return WorkspaceLayoutSchema.parse({ projectId, layoutJson, updatedAt: ts });
  }
}

// ---------------------------------------------------------------------------
// dev_servers (migration 0004, Phase 5 SPEC R18)
// ---------------------------------------------------------------------------

function rowToDevServer(row: Row): DevServer {
  return DevServerSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    source: row.source,
    command: row.command,
    args: fromJson<string[]>(row.args_json, []),
    cwd: row.cwd,
    port: row.port === null || row.port === undefined ? undefined : Number(row.port),
    url: (row.url as string | null) ?? undefined,
    env: fromJson<Record<string, string> | undefined>(row.env_json, undefined),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/** A dev server's *definition* only — its live run state is never persisted
 *  (see migration 0004's header comment and `DevServerRunSchema`'s doc
 *  comment in `@capygen/shared`). */
export class DevServersRepo {
  constructor(private readonly db: Database) {}

  private insert(s: DevServer): void {
    this.db.run(
      `INSERT INTO dev_servers
         (id, project_id, name, source, command, args_json, cwd, port, url, env_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.projectId,
      s.name,
      s.source,
      s.command,
      toJson(s.args),
      s.cwd,
      s.port ?? null,
      s.url ?? null,
      toJson(s.env ?? null),
      s.createdAt,
      s.updatedAt,
    );
  }

  /** `servers.saveCustom` — mints a new id. */
  create(input: { projectId: string; server: DevServerDraft }): DevServer {
    const ts = now();
    const draft = input.server;
    const server: DevServer = {
      id: newId("devServer"),
      projectId: input.projectId,
      name: draft.name,
      source: draft.source,
      command: draft.command,
      args: draft.args,
      cwd: draft.cwd,
      ...(draft.port !== undefined ? { port: draft.port } : {}),
      ...(draft.url !== undefined ? { url: draft.url } : {}),
      ...(draft.env !== undefined ? { env: draft.env } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    this.insert(server);
    return server;
  }

  /**
   * Insert or replace a fully-formed row by id — for a detector (`servers.detect`,
   * Phase 5 Build) that mints its own deterministic id (e.g. derived from
   * `projectId` + `name` + `source`) so re-detecting the same script does not
   * duplicate the row.
   */
  upsert(server: DevServer): DevServer {
    const parsed = DevServerSchema.parse(server);
    this.db.run(
      `INSERT INTO dev_servers
         (id, project_id, name, source, command, args_json, cwd, port, url, env_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name       = excluded.name,
         source     = excluded.source,
         command    = excluded.command,
         args_json  = excluded.args_json,
         cwd        = excluded.cwd,
         port       = excluded.port,
         url        = excluded.url,
         env_json   = excluded.env_json,
         updated_at = excluded.updated_at`,
      parsed.id,
      parsed.projectId,
      parsed.name,
      parsed.source,
      parsed.command,
      toJson(parsed.args),
      parsed.cwd,
      parsed.port ?? null,
      parsed.url ?? null,
      toJson(parsed.env ?? null),
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  get(id: string): DevServer | null {
    const row = this.db.get<Row>("SELECT * FROM dev_servers WHERE id = ?", id);
    return row ? rowToDevServer(row) : null;
  }

  listByProject(projectId: string): DevServer[] {
    return this.db
      .all<Row>(
        "SELECT * FROM dev_servers WHERE project_id = ? ORDER BY created_at, rowid",
        projectId,
      )
      .map(rowToDevServer);
  }

  /** Merge-patch a saved definition (e.g. a detector filling in the `port`/
   *  `url` a start just discovered). */
  update(id: string, patch: DevServerPatch): DevServer {
    const existing = this.get(id);
    if (!existing) throw new Error(`unknown dev server: ${id}`);
    const merged = DevServerSchema.parse({
      ...existing,
      ...patch,
      port: patch.port === undefined ? existing.port : (patch.port ?? undefined),
      url: patch.url === undefined ? existing.url : (patch.url ?? undefined),
      env: patch.env === undefined ? existing.env : (patch.env ?? undefined),
      updatedAt: now(),
    });
    this.upsert(merged);
    return merged;
  }

  remove(id: string): boolean {
    return this.db.run("DELETE FROM dev_servers WHERE id = ?", id) > 0;
  }
}

// ---------------------------------------------------------------------------
// tasks (0001 table; agent_id/order_index added in migration 0004)
// ---------------------------------------------------------------------------

function rowToTask(row: Row): Task {
  return TaskSchema.parse({
    id: row.id,
    sessionId: row.session_id ?? null,
    agentId: (row.agent_id as string | null) ?? null,
    title: row.title,
    status: row.status as TaskStatus,
    source: row.source,
    order: Number(row.order_index ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

export class TasksRepo {
  constructor(private readonly db: Database) {}

  private insert(t: Task): void {
    this.db.run(
      `INSERT INTO tasks
         (id, session_id, agent_id, title, status, source, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      t.sessionId,
      t.agentId,
      t.title,
      t.status,
      t.source,
      t.order,
      t.createdAt,
      t.updatedAt,
    );
  }

  /** A manually-added task (`tasks.list`'s counterpart write path is
   *  `update`; creation has no dedicated IPC channel yet — the Tasks pane's
   *  "add" action goes through this repo method directly from the handler). */
  create(input: {
    sessionId?: string | null;
    agentId?: string | null;
    title: string;
    status?: TaskStatus;
    source?: Task["source"];
    order?: number;
  }): Task {
    const ts = now();
    const task: Task = {
      id: newId("task"),
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      title: input.title,
      status: input.status ?? "pending",
      source: input.source ?? "manual",
      order: input.order ?? 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.insert(task);
    return task;
  }

  /**
   * Insert or replace a fully-formed row by id — how `TasksService` (Phase 5
   * Build) keeps a session's tasks in sync with an agent's own plan: a
   * `TodoWrite`/Codex-plan-derived task carries a deterministic id (e.g. tied
   * to the block that produced it) so re-sending the same plan updates the
   * same rows instead of duplicating them.
   */
  upsert(task: Task): Task {
    const parsed = TaskSchema.parse(task);
    this.db.run(
      `INSERT INTO tasks
         (id, session_id, agent_id, title, status, source, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id  = excluded.session_id,
         agent_id    = excluded.agent_id,
         title       = excluded.title,
         status      = excluded.status,
         source      = excluded.source,
         order_index = excluded.order_index,
         updated_at  = excluded.updated_at`,
      parsed.id,
      parsed.sessionId,
      parsed.agentId,
      parsed.title,
      parsed.status,
      parsed.source,
      parsed.order,
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  get(id: string): Task | null {
    const row = this.db.get<Row>("SELECT * FROM tasks WHERE id = ?", id);
    return row ? rowToTask(row) : null;
  }

  /** `tasks.list {sessionId?|projectId?}` — a project filter joins through
   *  `sessions` since `tasks` itself has no `project_id` column. Both omitted
   *  lists every task (the Tasks *page*, P10, spans sessions). */
  list(opts: { sessionId?: string; projectId?: string } = {}): Task[] {
    if (opts.sessionId) return this.listBySession(opts.sessionId);
    if (opts.projectId) return this.listByProject(opts.projectId);
    return this.db.all<Row>("SELECT * FROM tasks ORDER BY updated_at DESC").map(rowToTask);
  }

  listBySession(sessionId: string): Task[] {
    return this.db
      .all<Row>(
        "SELECT * FROM tasks WHERE session_id = ? ORDER BY order_index, created_at",
        sessionId,
      )
      .map(rowToTask);
  }

  listByProject(projectId: string): Task[] {
    return this.db
      .all<Row>(
        `SELECT t.* FROM tasks t
           JOIN sessions s ON s.id = t.session_id
          WHERE s.project_id = ?
          ORDER BY t.updated_at DESC`,
        projectId,
      )
      .map(rowToTask);
  }

  /** `tasks.update` — merge-patch the user/agent-editable fields
   *  (`TaskPatchSchema`: title, status, agentId, order). */
  update(id: string, patch: TaskPatch): Task {
    const existing = this.get(id);
    if (!existing) throw new Error(`unknown task: ${id}`);
    const merged = TaskSchema.parse({ ...existing, ...patch, updatedAt: now() });
    this.upsert(merged);
    return merged;
  }

  remove(id: string): boolean {
    return this.db.run("DELETE FROM tasks WHERE id = ?", id) > 0;
  }
}

// ---------------------------------------------------------------------------
// global_settings (Phase 6, SPEC R19, R30) — one JSON blob in the existing
// key/value `settings` table (0001). See migration 0005's header for why
// `GlobalSettingsSchema`, unlike the four repos below it, needed no schema
// change at all: it is one more row under a dedicated key, the same
// `getRaw`/`setRaw`-shaped write `SettingsRepo` already uses for non-user
// state (window geometry).
// ---------------------------------------------------------------------------

const GLOBAL_SETTINGS_KEY = "global_settings";

/**
 * [7-P1] Why the canonical row was read the way it was.
 *
 * `all()` used to collapse all four of these into "the shipping defaults", and
 * then `patch()`/`reset()` wrote a merge of those defaults straight over the
 * bytes that could not be parsed. A row a newer build wrote, or one a half-
 * finished write corrupted, was therefore silently replaced by this build's
 * idea of the settings — losing the user's real preferences with no message.
 * The four states are now distinct, and only the first two accept a write.
 */
export type GlobalSettingsState =
  /** No row yet: a fresh profile, or one that predates the settings hub. */
  | "missing"
  /** A row this build understands. */
  | "valid"
  /** A well-formed row whose `version` is newer than this build's schema. */
  | "future"
  /** Present but unparseable — not JSON, or not this shape. */
  | "corrupt";

export interface GlobalSettingsRead {
  state: GlobalSettingsState;
  /** Always usable: the parsed row, or the shipping defaults. */
  settings: GlobalSettings;
  /**
   * The object as it is **actually stored**, for a `valid` row only.
   *
   * The one-time normalisation needs it: a row an older build wrote may carry a
   * `general.defaultModel` that this build strips on write, and `settings`
   * above has already had that key refilled by the schema's own `.default()`.
   * Telling "the user stored this" from "the schema supplied this" is only
   * possible against the raw bytes.
   */
  raw?: Record<string, unknown>;
  /** False for `future`/`corrupt` — those serve defaults **read-only** and
   *  their bytes are preserved exactly as they are. */
  writable: boolean;
  /** Why a write is refused; set only when `writable` is false. */
  reason?: string;
}

/** The newest `version` this build knows how to write. */
export const GLOBAL_SETTINGS_VERSION = DEFAULT_GLOBAL_SETTINGS.version;

export class GlobalSettingsRepo {
  constructor(private readonly db: Database) {}

  /**
   * The canonical row and what may be done with it. Never throws — a settings
   * page must open even on an unreadable profile; it just cannot save.
   */
  read(): GlobalSettingsRead {
    const row = this.db.get<Row>(
      "SELECT value_json FROM settings WHERE key = ?",
      GLOBAL_SETTINGS_KEY,
    );
    if (!row) return { state: "missing", settings: DEFAULT_GLOBAL_SETTINGS, writable: true };
    const raw = fromJson<unknown>(row.value_json, undefined);
    if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        state: "corrupt",
        settings: DEFAULT_GLOBAL_SETTINGS,
        writable: false,
        reason: CORRUPT_REASON,
      };
    }
    const version = (raw as { version?: unknown }).version;
    if (typeof version === "number" && version > GLOBAL_SETTINGS_VERSION) {
      // Checked *before* parsing: a newer build may have added fields this
      // schema drops, and writing the parsed subset back would delete them.
      return {
        state: "future",
        settings: DEFAULT_GLOBAL_SETTINGS,
        writable: false,
        reason:
          `these settings were written by a newer version of capygen (format ${version}, this ` +
          `build understands ${GLOBAL_SETTINGS_VERSION}). They are shown read-only and left ` +
          "exactly as they are; update capygen to edit them.",
      };
    }
    const parsed = GlobalSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        state: "corrupt",
        settings: DEFAULT_GLOBAL_SETTINGS,
        writable: false,
        reason: CORRUPT_REASON,
      };
    }
    return {
      state: "valid",
      settings: parsed.data,
      writable: true,
      raw: raw as Record<string, unknown>,
    };
  }

  /** The settings to *use*. Safe defaults for a row that cannot be read — the
   *  same posture `SettingsRepo.all` takes, now without the silent overwrite. */
  all(): GlobalSettings {
    return this.read().settings;
  }

  /** `settings.patch` — deep-merges into the existing object
   *  (`mergeGlobalSettingsPatch`), never a flat overwrite; see that
   *  function's doc comment in `@capygen/shared`. Refuses on a row this build
   *  must not rewrite. */
  /**
   * [7-P1] The alias is translated **here**, not only in the service.
   *
   * `general.defaultModel` is a derived view that `write` strips, so a patch
   * naming only the alias used to be accepted and then silently discarded —
   * and other shipping consumers reach this repo directly, so putting the
   * translation one layer up would leave exactly that hole open.
   */
  patch(patch: GlobalSettingsPatch): GlobalSettings {
    const current = this.requireWritable();
    const merged = mergeGlobalSettingsPatch(
      current,
      translateDefaultModelAlias(current, patch),
    );
    this.write(merged);
    return merged;
  }

  /** `settings.reset` — one section back to its shipping default, or the
   *  whole object for `"all"`. */
  reset(section: GlobalSettingsSection): GlobalSettings {
    const current = this.requireWritable();
    const next = resetGlobalSettingsSection(current, section);
    this.write(next);
    return next;
  }

  /**
   * Replace the whole canonical row. Used by the one-time legacy→canonical
   * normalisation, which computes the whole object in one go.
   *
   * [7-P1] Validated against the schema **before** it is persisted. The caller
   * assembles this object out of raw legacy JSON, and an out-of-range value
   * that reached the row would make it unparseable on the next read — turning a
   * profile whose preferences were merely old into one this build refuses to
   * write at all, with the flat rows it migrated from already deleted.
   */
  replace(value: GlobalSettings): GlobalSettings {
    this.requireWritable();
    const parsed = GlobalSettingsSchema.parse(value);
    this.write(parsed);
    return parsed;
  }

  private requireWritable(): GlobalSettings {
    const read = this.read();
    if (!read.writable) throw new Error(read.reason ?? CORRUPT_REASON);
    return read.settings;
  }

  /**
   * [7-P1] `general.defaultModel` is **stripped before every write**.
   *
   * It is a derived view of `backends[general.defaultBackend].model` (see its
   * doc comment in `@capygen/shared`). Storing it as well would let the two
   * drift, and — worse — would leave a stale alias behind after
   * `reset("backends")` cleared the canonical model, which the next read would
   * resurrect as if the user had chosen it. The schema's own `.default()`
   * refills the key on read, and `SettingsService` overwrites it with the
   * derived value before anyone sees it.
   */
  private write(value: GlobalSettings): void {
    // Every path into the row goes through the schema: `patch` merges through
    // it, `replace` parses first, and this is the last line of defence for
    // anything that reaches here another way.
    const checked = GlobalSettingsSchema.parse(value);
    const { defaultModel: _derived, ...general } = checked.general;
    const stored = { ...checked, general };
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = excluded.updated_at`,
      GLOBAL_SETTINGS_KEY,
      JSON.stringify(stored),
      now(),
    );
  }
}

const CORRUPT_REASON =
  "capygen could not read the stored settings, so they were left untouched and the shipping " +
  "defaults are shown instead. Nothing will be saved over them.";

// ---------------------------------------------------------------------------
// Integrations caches: mcp_servers / plugins / skills / policies (Phase 6,
// SPEC R28-R29). Migration 0001 created all four tables as placeholders;
// migration 0005 adds the `backend` column the first and last were missing.
// None of the four domain shapes carries an `id` (see their doc comments in
// `@capygen/shared`) — every repo below keys its row by the entry's own
// natural identity, so `.upsert` is idempotent: re-syncing the same backend
// config updates the existing row instead of duplicating it, the same
// pattern `DevServersRepo.upsert`/`TasksRepo.upsert` already use for a
// detector's deterministic id.
// ---------------------------------------------------------------------------

const MCP_SERVER_ENVELOPE_KEYS = new Set(["backend", "scope", "name", "tools"]);

function mcpServerRowId(backend: Backend, scope: McpServerScope, name: string): string {
  return `${backend}:${scope}:${name}`;
}

function rowToMcpServerEntry(row: Row): McpServerEntry {
  const payload = fromJson<Record<string, unknown>>(row.config_json, {});
  return McpServerEntrySchema.parse({
    ...payload,
    backend: row.backend,
    scope: row.scope,
    name: row.name,
    tools: fromJson<string[] | undefined>(row.tools_json, undefined),
  });
}

/** One row per (`backend`, `scope`, `name`) — `integrations.mcp.*`. */
export class McpServersRepo {
  constructor(private readonly db: Database) {}

  /** `integrations.mcp.add` and a config-file re-sync alike — insert or
   *  replace by natural key. */
  upsert(entry: McpServerEntry): McpServerEntry {
    const parsed = McpServerEntrySchema.parse(entry);
    const id = mcpServerRowId(parsed.backend, parsed.scope, parsed.name);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!MCP_SERVER_ENVELOPE_KEYS.has(key)) payload[key] = value;
    }
    this.db.run(
      `INSERT INTO mcp_servers (id, backend, scope, name, config_json, tools_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         backend      = excluded.backend,
         scope        = excluded.scope,
         name         = excluded.name,
         config_json  = excluded.config_json,
         tools_json   = excluded.tools_json,
         updated_at   = excluded.updated_at`,
      id,
      parsed.backend,
      parsed.scope,
      parsed.name,
      JSON.stringify(payload),
      toJson(parsed.tools ?? null),
      now(),
    );
    return parsed;
  }

  /** `integrations.mcp.update` — merge-patch by natural key. */
  update(
    backend: Backend,
    scope: McpServerScope,
    name: string,
    patch: McpServerEntryPatch,
  ): McpServerEntry {
    const existing = this.get(backend, scope, name);
    if (!existing) throw new Error(`unknown mcp server: ${backend}/${scope}/${name}`);
    return this.upsert(McpServerEntrySchema.parse({ ...existing, ...patch }));
  }

  /** `integrations.mcp.remove`. */
  remove(backend: Backend, scope: McpServerScope, name: string): boolean {
    return this.db.run("DELETE FROM mcp_servers WHERE id = ?", mcpServerRowId(backend, scope, name)) > 0;
  }

  get(backend: Backend, scope: McpServerScope, name: string): McpServerEntry | null {
    const row = this.db.get<Row>(
      "SELECT * FROM mcp_servers WHERE id = ?",
      mcpServerRowId(backend, scope, name),
    );
    return row ? rowToMcpServerEntry(row) : null;
  }

  /** `integrations.list {backend}`'s `mcpServers`. */
  listByBackend(backend: Backend): McpServerEntry[] {
    return this.db
      .all<Row>("SELECT * FROM mcp_servers WHERE backend = ? ORDER BY scope, name", backend)
      .map(rowToMcpServerEntry);
  }
}

const PLUGIN_ENVELOPE_KEYS = new Set(["backend", "name", "version", "enabled"]);

function pluginRowId(backend: Backend, name: string): string {
  return `${backend}:${name}`;
}

function rowToPluginEntry(row: Row): PluginEntry {
  const payload = fromJson<Record<string, unknown>>(row.manifest_json, {});
  return PluginEntrySchema.parse({
    ...payload,
    backend: row.backend,
    name: row.name,
    version: (row.version as string | null) || undefined,
    enabled: intToBool(row.enabled),
  });
}

/** `PluginEntry` with its `.default()`-bearing fields made optional, so a
 *  caller need not restate `enabled`/`installed`/`commands`/`skills` just to
 *  let `PluginEntrySchema.parse` fill them in — `upsert`'s own parameter
 *  type, not a zod schema (this package does not depend on zod directly). */
type PluginEntryInput = Omit<PluginEntry, "enabled" | "installed" | "commands" | "skills"> & {
  enabled?: boolean;
  installed?: boolean;
  commands?: string[];
  skills?: string[];
};

/** One row per (`backend`, `name`) — `integrations.plugin.*`. `backend`,
 *  `name`, `version`, `enabled` are the table's own hoisted columns (0001);
 *  everything else (`marketplace`, `installed`, `path`, `commands`,
 *  `skills`, `source`) lives in `manifest_json`. */
export class PluginsRepo {
  constructor(private readonly db: Database) {}

  upsert(entry: PluginEntryInput): PluginEntry {
    const parsed = PluginEntrySchema.parse(entry);
    const id = pluginRowId(parsed.backend, parsed.name);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!PLUGIN_ENVELOPE_KEYS.has(key)) payload[key] = value;
    }
    this.db.run(
      `INSERT INTO plugins (id, backend, name, version, enabled, manifest_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         backend       = excluded.backend,
         name          = excluded.name,
         version       = excluded.version,
         enabled       = excluded.enabled,
         manifest_json = excluded.manifest_json,
         updated_at    = excluded.updated_at`,
      id,
      parsed.backend,
      parsed.name,
      parsed.version ?? "",
      boolToInt(parsed.enabled),
      JSON.stringify(payload),
      now(),
    );
    return parsed;
  }

  /** `integrations.plugin.setEnabled`. */
  setEnabled(backend: Backend, name: string, enabled: boolean): PluginEntry {
    const existing = this.get(backend, name);
    if (!existing) throw new Error(`unknown plugin: ${backend}/${name}`);
    return this.upsert({ ...existing, enabled });
  }

  /** `integrations.plugin.uninstall`. */
  remove(backend: Backend, name: string): boolean {
    return this.db.run("DELETE FROM plugins WHERE id = ?", pluginRowId(backend, name)) > 0;
  }

  get(backend: Backend, name: string): PluginEntry | null {
    const row = this.db.get<Row>("SELECT * FROM plugins WHERE id = ?", pluginRowId(backend, name));
    return row ? rowToPluginEntry(row) : null;
  }

  /** `integrations.list {backend}`'s `plugins`. */
  listByBackend(backend: Backend): PluginEntry[] {
    return this.db
      .all<Row>("SELECT * FROM plugins WHERE backend = ? ORDER BY name", backend)
      .map(rowToPluginEntry);
  }
}

const SKILL_ENVELOPE_KEYS = new Set(["backend", "name", "scope", "description"]);

function skillRowId(backend: Backend, scope: SkillScope, name: string): string {
  return `${backend}:${scope}:${name}`;
}

function rowToSkillEntry(row: Row): SkillEntry {
  const payload = fromJson<Record<string, unknown>>(row.metadata_json, {});
  return SkillEntrySchema.parse({
    ...payload,
    backend: row.backend,
    name: row.name,
    // `skills.source` (0001, default 'user') is reused as-is for
    // `SkillEntry.scope` — both are the same "user"/"project"/"plugin"
    // vocabulary; migration 0005's header explains why the column keeps its
    // original name rather than being renamed.
    scope: row.source,
    description: (row.description as string | null) || undefined,
  });
}

/** `SkillEntry` with `enabled` made optional — same reasoning as
 *  `PluginEntryInput` above. */
type SkillEntryInput = Omit<SkillEntry, "enabled"> & { enabled?: boolean };

/** One row per (`backend`, `scope`, `name`) — `integrations.skill.*`. */
export class SkillsRepo {
  constructor(private readonly db: Database) {}

  upsert(entry: SkillEntryInput): SkillEntry {
    const parsed = SkillEntrySchema.parse(entry);
    const id = skillRowId(parsed.backend, parsed.scope, parsed.name);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!SKILL_ENVELOPE_KEYS.has(key)) payload[key] = value;
    }
    this.db.run(
      `INSERT INTO skills (id, backend, name, description, source, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         backend       = excluded.backend,
         name          = excluded.name,
         description   = excluded.description,
         source        = excluded.source,
         metadata_json = excluded.metadata_json,
         updated_at    = excluded.updated_at`,
      id,
      parsed.backend,
      parsed.name,
      parsed.description ?? "",
      parsed.scope,
      JSON.stringify(payload),
      now(),
    );
    return parsed;
  }

  /**
   * `integrations.skill.setEnabled` — `scope` disambiguates a name that
   * exists in more than one; omitted affects the first match for
   * `backend`+`name` (`"integrations.skill.setEnabled"`'s doc comment in
   * `@capygen/shared/ipc.js` explains why the IPC input allows that).
   */
  setEnabled(backend: Backend, name: string, enabled: boolean, scope?: SkillScope): SkillEntry {
    const existing = scope ? this.get(backend, scope, name) : this.findByName(backend, name);
    if (!existing) throw new Error(`unknown skill: ${backend}/${name}`);
    return this.upsert({ ...existing, enabled });
  }

  get(backend: Backend, scope: SkillScope, name: string): SkillEntry | null {
    const row = this.db.get<Row>("SELECT * FROM skills WHERE id = ?", skillRowId(backend, scope, name));
    return row ? rowToSkillEntry(row) : null;
  }

  private findByName(backend: Backend, name: string): SkillEntry | null {
    const row = this.db.get<Row>(
      "SELECT * FROM skills WHERE backend = ? AND name = ? ORDER BY source LIMIT 1",
      backend,
      name,
    );
    return row ? rowToSkillEntry(row) : null;
  }

  /** `integrations.list {backend}`'s `skills`. */
  listByBackend(backend: Backend): SkillEntry[] {
    return this.db
      .all<Row>("SELECT * FROM skills WHERE backend = ? ORDER BY source, name", backend)
      .map(rowToSkillEntry);
  }
}

function policyRowId(backend: Backend, scope: ToolPolicyScope, pattern: string): string {
  return `${backend}:${scope}:${pattern}`;
}

function rowToToolPolicyEntry(row: Row): ToolPolicyEntry {
  return ToolPolicyEntrySchema.parse({
    backend: row.backend,
    pattern: row.pattern,
    decision: row.action,
    scope: row.scope,
  });
}

/**
 * One row per (`backend`, `scope`, `pattern`) — `integrations.tools.*`.
 * `policies.session_id` (0001) is left NULL by every write here: none of
 * `ToolPolicyScopeSchema`'s three values names a particular session, only a
 * *kind* of scope (see `ToolPolicyScope`'s doc comment) — Phase 9's fuller
 * Policies page (P17) is the one that would start populating it.
 */
export class ToolPoliciesRepo {
  constructor(private readonly db: Database) {}

  /** `integrations.tools.setPolicy` — insert or replace by natural key
   *  (migration 0005's unique index on `backend, scope, pattern`). */
  upsert(entry: ToolPolicyEntry): ToolPolicyEntry {
    const parsed = ToolPolicyEntrySchema.parse(entry);
    const id = policyRowId(parsed.backend, parsed.scope, parsed.pattern);
    const ts = now();
    this.db.run(
      `INSERT INTO policies (id, backend, scope, session_id, pattern, action, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         action     = excluded.action,
         updated_at = excluded.updated_at`,
      id,
      parsed.backend,
      parsed.scope,
      parsed.pattern,
      parsed.decision,
      ts,
      ts,
    );
    return parsed;
  }

  /** `integrations.tools.removePolicy`. */
  remove(backend: Backend, scope: ToolPolicyScope, pattern: string): boolean {
    return this.db.run("DELETE FROM policies WHERE id = ?", policyRowId(backend, scope, pattern)) > 0;
  }

  /** `integrations.list {backend}`'s `tools`. */
  listByBackend(backend: Backend): ToolPolicyEntry[] {
    return this.db
      .all<Row>("SELECT * FROM policies WHERE backend = ? ORDER BY scope, pattern", backend)
      .map(rowToToolPolicyEntry);
  }
}
