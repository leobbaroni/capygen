import type { CapygenStore } from "@capygen/db";
import {
  RecurrenceError,
  nextRecurrenceOccurrence,
  normalizeRecurrence,
  type Automation,
  type AutomationDraft,
  type AutomationPatch,
  type AutomationRun,
  type AutomationRunStatus,
  type Session,
  type TurnStatus,
} from "@capygen/shared";

const MAX_TIMER_DELAY = 2_147_483_647;

export interface AutomationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type AutomationServicePatch = Omit<AutomationPatch, "nextRunAt" | "disabledReason">;

export interface AutomationServiceDeps {
  store: Pick<CapygenStore, "automations" | "sessions" | "turns">;
  clock?: AutomationClock;
  /**
   * Create the fresh session from the automation's current project/agent
   * configuration, attach it to `run.id`, then dispatch the prompt. The
   * callback is synchronous so the durable lease always exists first.
   */
  execute(automation: Automation, run: AutomationRun): { sessionId: string };
  /** Interrupt the active session; resolving means its runner has drained. */
  cancel?(sessionId: string): void | Promise<void>;
  onAutomationChanged?(automation: Automation): void;
  onAutomationDeleted?(id: string): void;
  onRunChanged?(run: AutomationRun): void;
}

export interface AutomationTurnStatusEvent {
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  error?: string;
}

const systemClock: AutomationClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Process-local scheduling over durable SQLite claims.
 *
 * There is one nearest-deadline timer. SQLite owns overlap prevention and run
 * history; this class owns timer lifecycle and translates terminal session
 * state back into a terminal automation run.
 */
export class AutomationService {
  private readonly repo: CapygenStore["automations"];
  private readonly sessions: CapygenStore["sessions"];
  private readonly turns: CapygenStore["turns"];
  private readonly clock: AutomationClock;
  private timer: unknown = null;
  private started = false;
  private ticking = false;
  private readonly runBySession = new Map<string, string>();
  private readonly cancelling = new Set<string>();
  private readonly settlementTimers = new Map<string, unknown>();

  constructor(private readonly deps: AutomationServiceDeps) {
    this.repo = deps.store.automations;
    this.sessions = deps.store.sessions;
    this.turns = deps.store.turns;
    this.clock = deps.clock ?? systemClock;
  }

  start(): { interrupted: number; skipped: number; paused: number } {
    if (this.started) return { interrupted: 0, skipped: 0, paused: 0 };
    this.started = true;
    const before = new Map(this.repo.list().map((automation) => [automation.id, JSON.stringify(automation)]));
    const now = this.clock.now();
    const result = this.repo.reconcileStartup({
      now,
      nextRunAt: (automation, after) => this.nextAfter(automation, after),
    });

    // Reconciliation only has to parse overdue rows. Validate future and
    // unscheduled rows too, so a malformed persisted rule cannot become a
    // timer callback that repeatedly fails.
    for (const automation of this.repo.list({ enabled: true })) {
      try {
        const normalized = normalizeRecurrence(automation.rrule);
        const nextRunAt = automation.nextRunAt ?? this.requireNext({ ...automation, rrule: normalized }, now);
        if (normalized !== automation.rrule || automation.nextRunAt === null || automation.disabledReason !== null) {
          this.repo.update(automation.id, { rrule: normalized, nextRunAt, disabledReason: null }, now);
        } else {
          // Resolve once even when a future deadline is already persisted; this
          // validates the time zone and supported local-year horizon.
          this.nextAfter({ ...automation, rrule: normalized }, now);
        }
      } catch {
        this.repo.setEnabled(
          automation.id,
          false,
          { disabledReason: "invalid_schedule", nextRunAt: null },
          now,
        );
      }
    }

    for (const automation of this.repo.list()) {
      if (before.get(automation.id) !== JSON.stringify(automation)) this.changed(automation);
    }
    this.armTimer();
    return result;
  }

  dispose(): void {
    this.started = false;
    this.clearTimer();
    this.runBySession.clear();
    this.cancelling.clear();
    for (const handle of this.settlementTimers.values()) this.clock.clearTimeout(handle);
    this.settlementTimers.clear();
  }

  list(options: { projectId?: string; enabled?: boolean } = {}): Automation[] {
    return this.repo.list(options);
  }

  listRuns(automationId: string, limit = 50): AutomationRun[] {
    return this.repo.listRuns(automationId, limit);
  }

  create(draft: AutomationDraft): Automation {
    const now = this.clock.now();
    const normalized = normalizeRecurrence(draft.rrule);
    const normalizedDraft = { ...draft, rrule: normalized };
    const nextRunAt = this.requireNext(normalizedDraft, now);
    const automation = this.repo.create({ ...normalizedDraft, nextRunAt }, now);
    this.changed(automation);
    this.armTimer();
    return automation;
  }

  update(id: string, patch: AutomationServicePatch): Automation {
    const current = this.requireAutomation(id);
    const now = this.clock.now();
    const candidate = { ...current, ...patch };
    const normalized = normalizeRecurrence(candidate.rrule);
    const enabled = patch.enabled ?? current.enabled;
    const scheduleChanged =
      patch.rrule !== undefined || patch.timeZone !== undefined || patch.scheduleAnchorAt !== undefined;
    let nextRunAt = current.nextRunAt;
    let disabledReason = current.disabledReason;
    if (!enabled) {
      nextRunAt = null;
      disabledReason = "paused_by_user";
    } else if (!current.enabled || scheduleChanged || nextRunAt === null) {
      nextRunAt = this.requireNext({ ...candidate, rrule: normalized }, now);
      disabledReason = null;
    }
    const automation = this.repo.update(
      id,
      { ...patch, rrule: normalized, enabled, nextRunAt, disabledReason },
      now,
    );
    this.changed(automation);
    this.armTimer();
    return automation;
  }

  setEnabled(id: string, enabled: boolean): Automation {
    return this.update(id, { enabled });
  }

  remove(id: string): boolean {
    const removed = this.repo.remove(id);
    if (removed) this.deps.onAutomationDeleted?.(id);
    this.armTimer();
    return removed;
  }

  runNow(id: string): AutomationRun {
    const automation = this.requireAutomation(id);
    const claimed = this.repo.claimManual({ automationId: id, firedAt: this.clock.now() });
    if (!claimed) throw serviceError("automation_running", `automation ${id} already has an active run`);
    return this.executeClaim(claimed.automation ?? automation, claimed.run);
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = this.repo.getRun(runId);
    if (!run || run.status !== "running") return false;
    if (this.cancelling.has(runId)) return false;
    this.cancelling.add(runId);
    try {
      if (run.sessionId && this.deps.cancel) await this.deps.cancel(run.sessionId);
      const current = this.repo.getRun(runId);
      if (!current || current.status !== "running") return current?.status === "cancelled";
      const finished = this.repo.finishRun({
        runId,
        status: "cancelled",
        finishedAt: this.clock.now(),
        sessionId: current.sessionId,
        errorCode: "cancelled_by_user",
      });
      if (current.sessionId) this.runBySession.delete(current.sessionId);
      this.runChanged(finished);
      this.armTimer();
      return true;
    } finally {
      this.cancelling.delete(runId);
    }
  }

  handleEvent(event: "session.updated", payload: Session): void;
  handleEvent(event: "chat.turnStatus", payload: AutomationTurnStatusEvent): void;
  handleEvent(event: "session.updated" | "chat.turnStatus", payload: Session | AutomationTurnStatusEvent): void {
    if (event === "session.updated") {
      this.handleSessionUpdated(payload as Session);
      return;
    }
    const update = payload as AutomationTurnStatusEvent;
    if (update.status === "pending" || update.status === "streaming") return;
    const session = this.sessions.get(update.sessionId);
    if (session) this.handleSessionUpdated(session);
  }

  handleSessionUpdated(session: Session): void {
    const runId = this.runBySession.get(session.id);
    if (!runId || this.cancelling.has(runId)) return;
    const pending = this.settlementTimers.get(session.id);
    if (session.status === "running" || session.status === "waiting") {
      if (pending !== undefined) {
        this.clock.clearTimeout(pending);
        this.settlementTimers.delete(session.id);
      }
      return;
    }
    if (pending !== undefined) return;
    // `RoundTable.drive` learns that one turn ended only after finishTurn has
    // emitted its idle session. It can open the mentioned agent's next turn in
    // the following microtask. Re-read on the next timer turn so that transient
    // idle state cannot finish the automation midway through a chain.
    const handle = this.clock.setTimeout(() => {
      this.settlementTimers.delete(session.id);
      this.settleSession(session.id, runId);
    }, 0);
    this.settlementTimers.set(session.id, handle);
  }

  private settleSession(sessionId: string, runId: string): void {
    if (this.runBySession.get(sessionId) !== runId || this.cancelling.has(runId)) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.status === "running" || session.status === "waiting") return;
    const turns = this.turns.list(sessionId);
    if (turns.some((turn) => turn.status === "pending" || turn.status === "streaming")) return;
    const status: Exclude<AutomationRunStatus, "running" | "skipped" | "cancelled"> =
      session.status === "error" || turns.some((turn) => turn.status === "error")
        ? "failed"
        : turns.some((turn) => turn.status === "interrupted")
          ? "interrupted"
          : "succeeded";
    const finished = this.repo.finishRun({
      runId,
      status,
      finishedAt: this.clock.now(),
      sessionId,
      ...(status === "failed" ? { errorCode: "session_failed" } : {}),
      ...(status === "interrupted" ? { errorCode: "session_interrupted" } : {}),
    });
    this.runBySession.delete(sessionId);
    this.runChanged(finished);
    this.armTimer();
  }

  /** Synchronous test/host seam; normal operation reaches this through the timer. */
  tick(): void {
    if (!this.started || this.ticking) return;
    this.ticking = true;
    this.clearTimer();
    try {
      const now = this.clock.now();
      const due = this.repo.list({ enabled: true })
        .filter((automation) => automation.nextRunAt !== null && automation.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt! - b.nextRunAt! || a.id.localeCompare(b.id));
      for (const snapshot of due) this.fireScheduled(snapshot, now);
    } finally {
      this.ticking = false;
      this.armTimer();
    }
  }

  private fireScheduled(snapshot: Automation, now: number): void {
    const scheduledAt = snapshot.nextRunAt!;
    let nextRunAt: number | null;
    try {
      nextRunAt = this.nextAfter(snapshot, now);
    } catch {
      const disabled = this.repo.setEnabled(
        snapshot.id,
        false,
        { disabledReason: "invalid_schedule", nextRunAt: null },
        now,
      );
      this.changed(disabled);
      return;
    }

    // A long run consumes later wall-clock slots. Advance immediately rather
    // than leaving a due row that would arm a zero-delay timer forever.
    if (this.repo.getActiveRun(snapshot.id)) {
      const updated = nextRunAt === null
        ? this.repo.setEnabled(snapshot.id, false, { disabledReason: "schedule_exhausted", nextRunAt: null }, now)
        : this.repo.update(snapshot.id, { nextRunAt }, now);
      this.changed(updated);
      return;
    }

    const claimed = this.repo.claimScheduled({
      automationId: snapshot.id,
      scheduledAt,
      firedAt: now,
      nextRunAt,
    });
    if (!claimed) {
      // Another tick or a manual run won the durable claim. If it is active and
      // this deadline is still due, consume the slot just as above.
      const current = this.repo.get(snapshot.id);
      if (current && current.nextRunAt !== null && current.nextRunAt <= now && this.repo.getActiveRun(snapshot.id)) {
        const updated = nextRunAt === null
          ? this.repo.setEnabled(snapshot.id, false, { disabledReason: "schedule_exhausted", nextRunAt: null }, now)
          : this.repo.update(snapshot.id, { nextRunAt }, now);
        this.changed(updated);
      }
      return;
    }
    if (nextRunAt === null) {
      this.changed(this.repo.setEnabled(
        snapshot.id,
        false,
        { disabledReason: "schedule_exhausted", nextRunAt: null },
        now,
      ));
    } else {
      this.changed(this.repo.get(snapshot.id)!);
    }
    this.executeClaim(claimed.automation, claimed.run);
  }

  private executeClaim(automation: Automation, run: AutomationRun): AutomationRun {
    // Publish the durable claim before user code creates or dispatches a
    // session. A synchronous executor failure therefore still has an honest
    // running -> failed lifecycle rather than appearing from nowhere.
    this.runChanged(run);
    try {
      const result = this.deps.execute(automation, run);
      if (!result?.sessionId || !this.sessions.get(result.sessionId)) {
        throw new Error("automation executor did not create a session");
      }
      const current = this.repo.getRun(run.id);
      if (!current?.sessionId) this.repo.attachSession(run.id, result.sessionId);
      else if (current.sessionId !== result.sessionId) throw new Error("automation executor attached a different session");
      this.runBySession.set(result.sessionId, run.id);
      const attached = this.repo.getRun(run.id)!;
      this.runChanged(attached);
      // Covers a deterministic executor that completed before returning. In
      // normal use the subsequent session.updated event settles it.
      this.handleSessionUpdated(this.sessions.get(result.sessionId)!);
      return this.repo.getRun(run.id)!;
    } catch {
      const current = this.repo.getRun(run.id);
      if (current?.status === "running") {
        const failed = this.repo.finishRun({
          runId: run.id,
          status: "failed",
          finishedAt: this.clock.now(),
          sessionId: current.sessionId,
          errorCode: "execution_failed",
        });
        if (current.sessionId) this.runBySession.delete(current.sessionId);
        this.runChanged(failed);
        return failed;
      }
      return current ?? run;
    }
  }

  private armTimer(): void {
    if (!this.started || this.ticking) return;
    this.clearTimer();
    const next = this.repo.list({ enabled: true })
      .map((automation) => automation.nextRunAt)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, next - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private requireAutomation(id: string): Automation {
    const automation = this.repo.get(id);
    if (!automation) throw serviceError("automation_not_found", `unknown automation: ${id}`);
    return automation;
  }

  private requireNext(
    automation: Pick<Automation, "rrule" | "scheduleAnchorAt" | "timeZone">,
    after: number,
  ): number {
    const next = this.nextAfter(automation, after);
    if (next === null) throw serviceError("schedule_exhausted", "schedule has no occurrence in the supported horizon");
    return next;
  }

  private nextAfter(
    automation: Pick<Automation, "rrule" | "scheduleAnchorAt" | "timeZone">,
    after: number,
  ): number | null {
    try {
      return nextRecurrenceOccurrence({
        rule: automation.rrule,
        scheduleAnchorAt: automation.scheduleAnchorAt,
        timeZone: automation.timeZone,
        after,
      });
    } catch (error) {
      if (error instanceof RecurrenceError && error.code === "NO_OCCURRENCE") return null;
      throw error;
    }
  }

  private changed(automation: Automation): void {
    this.deps.onAutomationChanged?.(automation);
  }

  private runChanged(run: AutomationRun): void {
    this.deps.onRunChanged?.(run);
  }
}

function serviceError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
