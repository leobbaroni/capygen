import {
  AutomationDraftSchema,
  AutomationPatchSchema,
  AutomationRunSchema,
  AutomationSchema,
  InboxItemDraftSchema,
  InboxItemSchema,
  type Automation,
  type AutomationDraft,
  type AutomationPatch,
  type AutomationRun,
  type AutomationRunStatus,
  type InboxItem,
  type InboxItemDraft,
  type InboxItemKind,
} from "@capygen/shared";
import { boolToInt, type Database, type Row } from "./driver.js";

const makeId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function rowToAutomation(row: Row): Automation {
  return AutomationSchema.parse({
    id: row.id, projectId: row.project_id, agentId: row.agent_id ?? null,
    name: row.name, prompt: row.prompt, rrule: row.rrule, timeZone: row.time_zone,
    scheduleAnchorAt: Number(row.schedule_anchor_at),
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    lastRunStatus: row.last_run_status ?? null,
    lastRunSessionId: row.last_run_session_id ?? null,
    disabledReason: row.disabled_reason ?? null, enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  });
}

function rowToRun(row: Row): AutomationRun {
  return AutomationRunSchema.parse({
    id: row.id, automationId: row.automation_id, trigger: row.trigger, status: row.status,
    scheduledAt: row.scheduled_at === null ? null : Number(row.scheduled_at),
    firedAt: Number(row.fired_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    sessionId: row.session_id ?? null, errorCode: row.error_code ?? null,
  });
}

function rowToInboxItem(row: Row): InboxItem {
  return InboxItemSchema.parse({
    id: row.id, sessionId: row.session_id, turnId: row.turn_id,
    requestId: row.request_id ?? null, kind: row.kind, title: row.title, body: row.body,
    dedupeKey: row.dedupe_key, targetBlockId: row.target_block_id ?? null,
    createdAt: Number(row.created_at), resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
  });
}

export interface ClaimedAutomationRun { automation: Automation; run: AutomationRun }

export class AutomationsRepo {
  constructor(private readonly db: Database) {}

  private assertAgent(projectId: string, agentId: string): void {
    const row = this.db.get<{ project_id: string; origin: string }>(
      `SELECT s.project_id, s.origin FROM agents a JOIN sessions s ON s.id = a.session_id
       WHERE a.id = ?`, agentId,
    );
    if (!row) throw new Error(`unknown automation agent: ${agentId}`);
    if (row.origin !== "live") throw new Error("automation agent belongs to an imported session");
    if (row.project_id !== projectId) throw new Error("automation agent belongs to a different project");
  }

  create(input: AutomationDraft & { nextRunAt: number | null }, now = Date.now()): Automation {
    const { nextRunAt, ...draftInput } = input;
    const draft = AutomationDraftSchema.parse(draftInput);
    this.assertAgent(draft.projectId, draft.agentId);
    const id = makeId("aut");
    this.db.run(
      `INSERT INTO automations
       (id,project_id,agent_id,name,prompt,rrule,time_zone,schedule_anchor_at,next_run_at,
        last_run_at,last_run_status,last_run_session_id,disabled_reason,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,?,?)`,
      id, draft.projectId, draft.agentId, draft.name, draft.prompt, draft.rrule,
      draft.timeZone, draft.scheduleAnchorAt, nextRunAt, now, now,
    );
    return this.get(id)!;
  }

  get(id: string): Automation | null {
    const row = this.db.get<Row>("SELECT * FROM automations WHERE id = ?", id);
    return row ? rowToAutomation(row) : null;
  }

  list(options: { projectId?: string; enabled?: boolean } = {}): Automation[] {
    const where: string[] = []; const params: Array<string | number> = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.enabled !== undefined) { where.push("enabled = ?"); params.push(boolToInt(options.enabled)); }
    return this.db.all<Row>(`SELECT * FROM automations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC`, ...params).map(rowToAutomation);
  }

  update(id: string, patch: AutomationPatch, now = Date.now()): Automation {
    const current = this.get(id);
    if (!current) throw new Error(`unknown automation: ${id}`);
    const parsedPatch = AutomationPatchSchema.parse(patch);
    const next = AutomationSchema.parse({ ...current, ...parsedPatch, updatedAt: now });
    if (next.agentId !== null) this.assertAgent(current.projectId, next.agentId);
    if (next.enabled && next.agentId === null) throw new Error("enabled automation requires an agent");
    this.db.run(
      `UPDATE automations SET agent_id=?,name=?,prompt=?,rrule=?,time_zone=?,schedule_anchor_at=?,
       next_run_at=?,disabled_reason=?,enabled=?,updated_at=? WHERE id=?`,
      next.agentId, next.name, next.prompt, next.rrule, next.timeZone, next.scheduleAnchorAt,
      next.nextRunAt, next.disabledReason, boolToInt(next.enabled), now, id,
    );
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean, options: { disabledReason?: string | null; nextRunAt?: number | null } = {}, now = Date.now()): Automation {
    return this.update(id, { enabled, ...options }, now);
  }

  remove(id: string): boolean {
    if (this.getActiveRun(id)) {
      const error = new Error("automation_running") as Error & { code: string };
      error.code = "automation_running"; throw error;
    }
    return this.db.run("DELETE FROM automations WHERE id = ?", id) > 0;
  }

  getRun(runId: string): AutomationRun | null {
    const row = this.db.get<Row>("SELECT * FROM automation_runs WHERE id = ?", runId);
    return row ? rowToRun(row) : null;
  }

  listRuns(automationId: string, limit = 100): AutomationRun[] {
    return this.db.all<Row>("SELECT * FROM automation_runs WHERE automation_id=? ORDER BY fired_at DESC,id DESC LIMIT ?", automationId, limit).map(rowToRun);
  }

  getActiveRun(automationId: string): AutomationRun | null {
    const row = this.db.get<Row>(`SELECT r.* FROM automation_run_leases l JOIN automation_runs r ON r.id=l.run_id WHERE l.automation_id=?`, automationId);
    return row ? rowToRun(row) : null;
  }

  private claim(automationId: string, trigger: "scheduled" | "manual", scheduledAt: number | null, firedAt: number, nextRunAt?: number | null): ClaimedAutomationRun | null {
    return this.db.transaction(() => {
      const automation = this.get(automationId);
      if (!automation || this.getActiveRun(automationId)) return null;
      if (trigger === "scheduled") {
        if (!automation.enabled || automation.nextRunAt !== scheduledAt || firedAt < scheduledAt!) return null;
        if (this.db.get("SELECT id FROM automation_runs WHERE automation_id=? AND scheduled_at=? AND trigger='scheduled'", automationId, scheduledAt!)) return null;
      }
      const runId = makeId("arun");
      this.db.run("INSERT INTO automation_runs (id,automation_id,trigger,status,scheduled_at,fired_at,finished_at,session_id,error_code) VALUES (?,?,?,'running',?,?,NULL,NULL,NULL)", runId, automationId, trigger, scheduledAt, firedAt);
      this.db.run("INSERT INTO automation_run_leases (automation_id,run_id,acquired_at) VALUES (?,?,?)", automationId, runId, firedAt);
      if (trigger === "scheduled") this.db.run("UPDATE automations SET next_run_at=?,updated_at=? WHERE id=?", nextRunAt ?? null, firedAt, automationId);
      return { automation: this.get(automationId)!, run: this.getRun(runId)! };
    });
  }

  claimScheduled(input: { automationId: string; scheduledAt: number; firedAt: number; nextRunAt: number | null }): ClaimedAutomationRun | null {
    return this.claim(input.automationId, "scheduled", input.scheduledAt, input.firedAt, input.nextRunAt);
  }

  claimManual(input: { automationId: string; firedAt: number }): ClaimedAutomationRun | null {
    return this.claim(input.automationId, "manual", null, input.firedAt);
  }

  attachSession(runId: string, sessionId: string): AutomationRun {
    const run = this.getRun(runId);
    if (!run || run.status !== "running") throw new Error(`run is not active: ${runId}`);
    if (run.sessionId !== null) {
      if (run.sessionId !== sessionId) throw new Error("automation run is already attached to a different session");
      return run;
    }
    const session = this.db.get<{ project_id: string; origin: string }>("SELECT project_id,origin FROM sessions WHERE id=?", sessionId);
    const automation = this.get(run.automationId);
    if (!session || !automation || session.origin !== "live" || session.project_id !== automation.projectId) {
      throw new Error("automation run session must be live and belong to the automation project");
    }
    const changed = this.db.run("UPDATE automation_runs SET session_id=? WHERE id=? AND status='running'", sessionId, runId);
    if (!changed) throw new Error(`run is not active: ${runId}`);
    return this.getRun(runId)!;
  }

  finishRun(input: { runId: string; status: Exclude<AutomationRunStatus, "running">; finishedAt: number; sessionId?: string | null; errorCode?: string | null }): AutomationRun {
    return this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run || run.status !== "running") throw new Error(`run is not active: ${input.runId}`);
      const sessionId = input.sessionId === undefined ? run.sessionId : input.sessionId;
      this.db.run("UPDATE automation_runs SET status=?,finished_at=?,session_id=?,error_code=? WHERE id=?", input.status, input.finishedAt, sessionId, input.errorCode ?? null, input.runId);
      this.db.run("UPDATE automations SET last_run_at=?,last_run_status=?,last_run_session_id=?,updated_at=? WHERE id=?", input.finishedAt, input.status, sessionId, input.finishedAt, run.automationId);
      this.db.run("DELETE FROM automation_run_leases WHERE run_id=?", input.runId);
      return this.getRun(input.runId)!;
    });
  }

  reconcileStartup(input: { now: number; nextRunAt: (automation: Automation, after: number) => number | null }): { interrupted: number; skipped: number; paused: number } {
    return this.db.transaction(() => {
      let interrupted = 0; let skipped = 0; let paused = 0;
      const active = this.db.all<Row>(`SELECT r.* FROM automation_run_leases l JOIN automation_runs r ON r.id=l.run_id`);
      for (const row of active) { this.finishRun({ runId: String(row.id), status: "interrupted", finishedAt: input.now, errorCode: "app_restarted" }); interrupted++; }
      const overdue = this.db.all<Row>("SELECT * FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?", input.now).map(rowToAutomation);
      for (const automation of overdue) {
        try {
          const next = input.nextRunAt(automation, input.now);
          const runId = makeId("arun");
          this.db.run("INSERT INTO automation_runs (id,automation_id,trigger,status,scheduled_at,fired_at,finished_at,session_id,error_code) VALUES (?,?,'scheduled','skipped',?,?,?,?,?)", runId, automation.id, automation.nextRunAt, input.now, input.now, null, "missed_while_stopped");
          this.db.run("UPDATE automations SET next_run_at=?,last_run_at=?,last_run_status='skipped',last_run_session_id=NULL,updated_at=? WHERE id=?", next, input.now, input.now, automation.id);
          skipped++;
        } catch {
          this.db.run("UPDATE automations SET enabled=0,disabled_reason='invalid_schedule',next_run_at=NULL,updated_at=? WHERE id=?", input.now, automation.id);
          paused++;
        }
      }
      return { interrupted, skipped, paused };
    });
  }
}

export class InboxRepo {
  constructor(private readonly db: Database) {}

  get(id: string): InboxItem | null {
    const row = this.db.get<Row>("SELECT * FROM inbox_items WHERE id=?", id);
    return row ? rowToInboxItem(row) : null;
  }

  insertIgnore(input: InboxItemDraft): { item: InboxItem; inserted: boolean } {
    const draft = InboxItemDraftSchema.parse(input);
    const id = makeId("inb");
    const changed = this.db.run(`INSERT OR IGNORE INTO inbox_items
      (id,session_id,turn_id,request_id,kind,title,body,dedupe_key,target_block_id,created_at,resolved_at,read_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`, id, draft.sessionId, draft.turnId, draft.requestId, draft.kind, draft.title, draft.body, draft.dedupeKey, draft.targetBlockId, draft.createdAt);
    const row = this.db.get<Row>("SELECT * FROM inbox_items WHERE dedupe_key=?", draft.dedupeKey);
    if (!row) throw new Error("inbox insert vanished");
    return { item: rowToInboxItem(row), inserted: changed > 0 };
  }

  list(options: { sessionId?: string; kind?: InboxItemKind; unreadOnly?: boolean; unresolvedOnly?: boolean; limit?: number; before?: { createdAt: number; id: string } } = {}): InboxItem[] {
    const where: string[] = []; const params: Array<string | number> = [];
    if (options.sessionId) { where.push("session_id=?"); params.push(options.sessionId); }
    if (options.kind) { where.push("kind=?"); params.push(options.kind); }
    if (options.unreadOnly) where.push("read_at IS NULL");
    if (options.unresolvedOnly) where.push("resolved_at IS NULL");
    if (options.before) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); params.push(options.before.createdAt, options.before.createdAt, options.before.id); }
    params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
    return this.db.all<Row>(`SELECT * FROM inbox_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC LIMIT ?`, ...params).map(rowToInboxItem);
  }

  unreadCount(sessionId?: string): number {
    const row = sessionId
      ? this.db.get<{ count: number }>("SELECT count(*) count FROM inbox_items WHERE read_at IS NULL AND session_id=?", sessionId)
      : this.db.get<{ count: number }>("SELECT count(*) count FROM inbox_items WHERE read_at IS NULL");
    return Number(row?.count ?? 0);
  }

  resolve(id: string, resolvedAt = Date.now()): InboxItem | null {
    this.db.run("UPDATE inbox_items SET resolved_at=COALESCE(resolved_at,?) WHERE id=?", resolvedAt, id);
    return this.get(id);
  }

  resolveByRequest(sessionId: string, requestId: string, resolvedAt = Date.now()): number {
    return this.db.run("UPDATE inbox_items SET resolved_at=COALESCE(resolved_at,?) WHERE session_id=? AND request_id=?", resolvedAt, sessionId, requestId);
  }

  markRead(id: string, read = true, at = Date.now()): InboxItem | null {
    this.db.run("UPDATE inbox_items SET read_at=? WHERE id=?", read ? at : null, id);
    return this.get(id);
  }

  markAllRead(at = Date.now(), sessionId?: string): number {
    return sessionId
      ? this.db.run("UPDATE inbox_items SET read_at=? WHERE read_at IS NULL AND session_id=?", at, sessionId)
      : this.db.run("UPDATE inbox_items SET read_at=? WHERE read_at IS NULL", at);
  }
}
