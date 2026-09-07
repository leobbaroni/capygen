import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { Agent, Automation, AutomationRun, Session } from "@capygen/shared";
import { AutomationService, type AutomationClock } from "../src/automations/AutomationService.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../../packages/db/migrations");
const START = Date.parse("2026-01-01T00:00:00.000Z");

class FakeClock implements AutomationClock {
  value = START;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.value;
  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.value + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown): void => { this.timers.delete(id as number); };

  advanceTo(value: number): void {
    this.value = value;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= value)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  nextDeadline(): number | null {
    return [...this.timers.values()].sort((a, b) => a.at - b.at)[0]?.at ?? null;
  }
}

describe("AutomationService", () => {
  let dir: string;
  let store: CapygenStore;
  let projectId: string;
  let templateAgent: Agent;
  let clock: FakeClock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-automations-"));
    store = openStore(path.join(dir, "state.sqlite"), { migrationsDir });
    const project = store.projects.upsertByPath({ path: dir });
    projectId = project.id;
    templateAgent = store.sessions.create({
      projectId,
      mode: "solo",
      title: "Automation template",
      agents: [{ name: "Assistant", backend: "codex", model: "gpt-test", role: "lead", config: null }],
    }).agents[0]!;
    clock = new FakeClock();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const draft = () => ({
    projectId,
    agentId: templateAgent.id,
    name: "Daily check",
    prompt: "Check the project",
    rrule: "freq=minutely",
    timeZone: "UTC",
    scheduleAnchorAt: START,
  });

  function executionSession(run: AutomationRun): { session: Session; sessionId: string } {
    const created = store.sessions.create({ projectId, mode: "solo", title: "Scheduled run", agents: [] });
    store.automations.attachSession(run.id, created.session.id);
    store.sessions.setStatus(created.session.id, "running");
    return { session: created.session, sessionId: created.session.id };
  }

  it("normalizes schedules and arms only the nearest deadline", () => {
    const execute = vi.fn((_automation: Automation, run: AutomationRun) => executionSession(run));
    const runChanges: AutomationRun[] = [];
    const service = new AutomationService({ store, clock, execute, onRunChanged: (run) => runChanges.push(run) });
    service.start();
    const automation = service.create(draft());

    expect(automation.rrule).toBe("FREQ=MINUTELY;INTERVAL=1");
    expect(automation.nextRunAt).toBe(START + 60_000);
    expect(clock.nextDeadline()).toBe(START + 60_000);

    clock.advanceTo(START + 60_000);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.automations.listRuns(automation.id)).toHaveLength(1);
    expect(runChanges.map((run) => [run.status, run.sessionId])).toEqual([
      ["running", null],
      ["running", expect.any(String)],
    ]);
    expect(store.automations.get(automation.id)?.nextRunAt).toBe(START + 120_000);
    service.dispose();
  });

  it("never overlaps and advances past due slots while the lease is active", () => {
    const execute = vi.fn((_automation: Automation, run: AutomationRun) => executionSession(run));
    const service = new AutomationService({ store, clock, execute });
    service.start();
    const automation = service.create(draft());

    clock.advanceTo(START + 60_000);
    const active = store.automations.getActiveRun(automation.id)!;
    clock.advanceTo(START + 4 * 60_000);

    expect(execute).toHaveBeenCalledOnce();
    expect(store.automations.listRuns(automation.id)).toHaveLength(1);
    expect(store.automations.get(automation.id)?.nextRunAt).toBe(START + 5 * 60_000);

    const session = store.sessions.get(active.sessionId!)!;
    store.turns.create({ sessionId: session.id, role: "agent", status: "done" });
    store.sessions.setStatus(session.id, "idle");
    service.handleSessionUpdated(store.sessions.get(session.id)!);
    clock.advanceTo(clock.value);
    expect(store.automations.getRun(active.id)?.status).toBe("succeeded");
    service.dispose();
  });

  it("skips missed restart slots without replaying a backlog and interrupts orphaned leases", () => {
    const original = new AutomationService({
      store,
      clock,
      execute: (_automation, run) => executionSession(run),
    });
    original.start();
    const automation = original.create(draft());
    const orphan = original.runNow(automation.id);
    original.dispose();

    clock.value = START + 10 * 60_000;
    const execute = vi.fn((_automation: Automation, run: AutomationRun) => executionSession(run));
    const restarted = new AutomationService({ store, clock, execute });
    const result = restarted.start();

    expect(result).toEqual({ interrupted: 1, skipped: 1, paused: 0 });
    expect(store.automations.getRun(orphan.id)?.status).toBe("interrupted");
    expect(store.automations.listRuns(automation.id).filter((run) => run.status === "skipped")).toHaveLength(1);
    expect(store.automations.get(automation.id)?.nextRunAt).toBe(START + 11 * 60_000);
    expect(execute).not.toHaveBeenCalled();
    restarted.dispose();
  });

  it("allows a paused automation to run manually, refuses overlap and refuses active deletion", () => {
    const service = new AutomationService({
      store,
      clock,
      execute: (_automation, run) => executionSession(run),
    });
    service.start();
    const automation = service.create(draft());
    const paused = service.update(automation.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();

    const run = service.runNow(automation.id);
    expect(run.status).toBe("running");
    expect(() => service.runNow(automation.id)).toThrowError(expect.objectContaining({ code: "automation_running" }));
    expect(() => service.remove(automation.id)).toThrowError(expect.objectContaining({ code: "automation_running" }));
    service.dispose();
  });

  it("awaits cancellation before releasing the lease, then permits deletion", async () => {
    let release!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = new AutomationService({
      store,
      clock,
      execute: (_automation, run) => executionSession(run),
      cancel,
    });
    service.start();
    const automation = service.create(draft());
    const run = service.runNow(automation.id);

    const pending = service.cancelRun(run.id);
    expect(store.automations.getRun(run.id)?.status).toBe("running");
    release();
    await expect(pending).resolves.toBe(true);
    expect(store.automations.getRun(run.id)?.status).toBe("cancelled");
    expect(service.remove(automation.id)).toBe(true);
    service.dispose();
  });

  it("derives failed and interrupted outcomes from persisted terminal turns", () => {
    const service = new AutomationService({
      store,
      clock,
      execute: (_automation, run) => executionSession(run),
    });
    service.start();
    const automation = service.create(draft());
    const failed = service.runNow(automation.id);
    store.turns.create({ sessionId: failed.sessionId!, role: "agent", status: "error" });
    store.sessions.setStatus(failed.sessionId!, "error");
    service.handleSessionUpdated(store.sessions.get(failed.sessionId!)!);
    clock.advanceTo(clock.value);
    expect(store.automations.getRun(failed.id)?.status).toBe("failed");

    const interrupted = service.runNow(automation.id);
    store.turns.create({ sessionId: interrupted.sessionId!, role: "agent", status: "interrupted" });
    store.sessions.setStatus(interrupted.sessionId!, "idle");
    service.handleSessionUpdated(store.sessions.get(interrupted.sessionId!)!);
    clock.advanceTo(clock.value);
    expect(store.automations.getRun(interrupted.id)?.status).toBe("interrupted");
    service.dispose();
  });

  it("does not finish on the transient idle event between round-table turns", () => {
    const service = new AutomationService({
      store,
      clock,
      execute: (_automation, run) => executionSession(run),
    });
    service.start();
    const automation = service.create(draft());
    const run = service.runNow(automation.id);

    store.turns.create({ sessionId: run.sessionId!, role: "agent", status: "done" });
    store.sessions.setStatus(run.sessionId!, "idle");
    service.handleSessionUpdated(store.sessions.get(run.sessionId!)!);
    const next = store.turns.create({ sessionId: run.sessionId!, role: "agent", status: "streaming" });
    store.sessions.setStatus(run.sessionId!, "running");
    service.handleSessionUpdated(store.sessions.get(run.sessionId!)!);
    clock.advanceTo(clock.value);
    expect(store.automations.getRun(run.id)?.status).toBe("running");

    store.turns.setStatus(next.id, "done");
    store.sessions.setStatus(run.sessionId!, "idle");
    service.handleSessionUpdated(store.sessions.get(run.sessionId!)!);
    clock.advanceTo(clock.value);
    expect(store.automations.getRun(run.id)?.status).toBe("succeeded");
    service.dispose();
  });

  it("disables invalid persisted schedules instead of hot-looping", () => {
    const automation = store.automations.create({ ...draft(), rrule: "FREQ=YEARLY", nextRunAt: START + 60_000 }, START);
    const changed: Automation[] = [];
    const service = new AutomationService({
      store,
      clock,
      execute: () => { throw new Error("must not execute"); },
      onAutomationChanged: (value) => changed.push(value),
    });
    service.start();

    expect(store.automations.get(automation.id)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      disabledReason: "invalid_schedule",
    });
    expect(changed.at(-1)?.id).toBe(automation.id);
    expect(clock.nextDeadline()).toBeNull();
    service.dispose();
  });
});
