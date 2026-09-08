/** Phase 8 usage accounting: known-zero prices must survive storage and reports. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, readMigrations, type CapygenStore } from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const temps: string[] = [];

function databaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-usage-"));
  temps.push(dir);
  return path.join(dir, "capygen.db");
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function session(store: CapygenStore, title: string) {
  const project = store.projects.upsertByPath({
    path: path.join(os.tmpdir(), "capygen-usage-projects", `${title}-${randomUUID()}`),
  });
  return store.sessions.create({ projectId: project.id, mode: "solo", title, agents: [] }).session;
}

function record(
  store: CapygenStore,
  sessionId: string,
  overrides: Partial<Parameters<CapygenStore["usage"]["record"]>[0]> = {},
) {
  return store.usage.record({
    sessionId,
    agentId: null,
    turnId: null,
    backend: "api",
    model: "priced-model",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 1,
    costUsd: 0,
    ...overrides,
  });
}

describe("usage cost knowledge", () => {
  it("persists explicit known zero and supplies a conservative fallback for old callers", () => {
    const file = databaseFile();
    let store = openStore(file, { migrationsDir: MIGRATIONS_DIR });
    const target = session(store, "Known and unknown");

    expect(record(store, target.id, { costKnown: true }).costKnown).toBe(true);
    expect(record(store, target.id, { costUsd: 0.25 }).costKnown).toBe(true);
    expect(record(store, target.id).costKnown).toBe(false);

    store.close();
    store = openStore(file, { migrationsDir: MIGRATIONS_DIR });
    expect(store.usage.listBySession(target.id).map((event) => event.costKnown)).toEqual([
      true,
      true,
      false,
    ]);
    store.close();
  }, 20_000);

  it("migrates legacy positive cost as known and legacy zero as unknown", () => {
    const file = databaseFile();
    const oldMigrations = readMigrations(MIGRATIONS_DIR).filter(
      (migration) => migration.id < "0008_usage_cost_known",
    );
    let store = openStore(file, { migrations: oldMigrations });
    const target = session(store, "Legacy usage");
    const insert = (id: string, cost: number, ts: number) => store.db.run(
      `INSERT INTO usage_events
         (id, session_id, agent_id, turn_id, backend, model, input_tokens,
          output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, ts)
       VALUES (?, ?, NULL, NULL, 'api', 'legacy', 1, 1, 0, 0, ?, ?)`,
      id,
      target.id,
      cost,
      ts,
    );
    insert("usage_positive", 0.5, 1);
    insert("usage_zero", 0, 2);
    store.close();

    store = openStore(file, { migrationsDir: MIGRATIONS_DIR });
    expect(store.migration.applied).toContain("0008_usage_cost_known");
    expect(store.usage.listBySession(target.id).map((event) => [event.id, event.costKnown])).toEqual([
      ["usage_positive", true],
      ["usage_zero", false],
    ]);
    store.close();
  }, 20_000);

  it("reports an inclusive/exclusive range with IANA days, titles, models, and unknown costs", () => {
    const file = databaseFile();
    const store = openStore(file, { migrationsDir: MIGRATIONS_DIR });
    const first = session(store, "Morning run");
    const second = session(store, "Evening run");
    const from = Date.parse("2026-03-08T06:00:00Z");
    const to = Date.parse("2026-03-09T05:00:00Z");

    record(store, first.id, { ts: from, backend: "api", model: "free", costKnown: true });
    record(store, second.id, {
      ts: Date.parse("2026-03-08T08:30:00Z"),
      backend: "codex",
      model: "unknown",
      costKnown: false,
    });
    record(store, first.id, { ts: to, costKnown: true, costUsd: 99 });

    const report = store.usage.report({ from, to, timeZone: "America/New_York" });
    expect(report.totals).toMatchObject({ events: 2, knownCostUsd: 0, unknownCostEvents: 1 });
    expect(report.days).toMatchObject([{ day: "2026-03-08", events: 2 }]);
    expect(report.sessions.map((item) => [item.title, item.events]).sort()).toEqual([
      ["Evening run", 1],
      ["Morning run", 1],
    ]);
    expect(report.byBackendModel.map((item) => [item.backend, item.model])).toEqual(
      expect.arrayContaining([["api", "free"], ["codex", "unknown"]]),
    );
    store.close();
  });
});
