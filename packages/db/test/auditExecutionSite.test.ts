/**
 * The audit log's execution site (ADR-0007 / P17, migration 0012).
 *
 * A widget's tool call and an ordinary backend tool call are authorized by the
 * same service against the same rules; before this column their audit rows were
 * indistinguishable, so "which of these refusals came from a widget" had no
 * answer. These tests pin the three things that makes true: the column is
 * additive over an already-migrated database, historical rows read as the site
 * they truthfully were, and the origin backend/boundary keep their own meaning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, openRaw, readMigrations, type CapygenStore } from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-audit-site-"));
  file = path.join(dir, "test.db");
  store = openStore(file, { migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Record<string, unknown> = {}) => ({
  requestId: "req_1",
  sessionId: "ses_1",
  agentId: "agent_1",
  backend: "codex" as const,
  boundary: "codex-dynamic-tool" as const,
  boundaryAvailable: true,
  toolName: "mcp__docs__search",
  decision: "deny" as const,
  source: "rule" as const,
  ...over,
});

describe("migration 0012 is additive over an existing log", () => {
  it("applies to a database already carrying 0010 rows, keeping them", () => {
    // Migrate up to 0010 only, write a row the old way, then finish migrating.
    const partial = path.join(dir, "partial.db");
    const all = readMigrations(MIGRATIONS_DIR);
    // `id` is the file's stem, so the cut is on its numeric prefix.
    const upTo10 = all.filter((entry) => Number(entry.id.slice(0, 4)) <= 10);
    expect(upTo10.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(upTo10.length);
    const db = openRaw(partial);
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    for (const migration of upTo10) {
      db.exec(migration.sql);
      // Recorded the way the migrator does, so reopening applies only 0011+.
      db.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", migration.id, 1);
    }
    db.run(
      `INSERT INTO local_policy_audit
         (id, ts, backend, boundary, boundary_available, tool_name, decision, source)
       VALUES ('lpa_old', 1, 'api', 'api-tool', 1, 'legacy_tool', 'allow', 'default')`,
    );
    db.close();

    // The real migrator now brings it forward; 0010 itself is never rewritten.
    const upgraded = openStore(partial, { migrationsDir: MIGRATIONS_DIR });
    try {
      const rows = upgraded.localPolicyAudit.recent(10);
      const legacy = rows.find((row) => row.id === "lpa_old");
      expect(legacy).toBeDefined();
      // The historical row is not lost, and reads as what it truthfully was:
      // widget authorization did not exist when it was written.
      expect(legacy!.executionSite).toBe("backend");
      expect(legacy!.toolName).toBe("legacy_tool");
    } finally {
      upgraded.close();
    }
  });

  it("accepts the unknown site the schema defines", () => {
    const row = store.localPolicyAudit.record(draft({ executionSite: "unknown" }));
    expect(row.executionSite).toBe("unknown");
  });

  it("refuses a site the column does not define", () => {
    expect(() =>
      store.db.run(
        `INSERT INTO local_policy_audit
           (id, ts, backend, boundary, boundary_available, tool_name, decision, source,
            execution_site)
         VALUES ('lpa_bad', 1, 'api', 'api-tool', 1, 't', 'allow', 'default', 'somewhere-else')`,
      ),
    ).toThrow();
  });
});

describe("a widget decision is distinguishable from a backend one", () => {
  it("persists the site while keeping the origin backend and boundary", () => {
    const backendRow = store.localPolicyAudit.record(draft());
    const widgetRow = store.localPolicyAudit.record(
      draft({ requestId: "req_2", executionSite: "widget-host" }),
    );

    expect(backendRow.executionSite).toBe("backend");
    expect(widgetRow.executionSite).toBe("widget-host");
    // The origin is *not* replaced by the site: a widget call still comes from
    // a Codex agent and is still checked at that backend's tool boundary, and
    // a refusal has to stay attributable to both.
    for (const row of [backendRow, widgetRow]) {
      expect(row.backend).toBe("codex");
      expect(row.boundary).toBe("codex-dynamic-tool");
    }

    const stored = store.localPolicyAudit.bySession("ses_1", 10);
    expect(stored.map((row) => row.executionSite).sort()).toEqual(["backend", "widget-host"]);
  });

  it("defaults an unspecified site rather than writing null", () => {
    const row = store.localPolicyAudit.record(draft({ executionSite: undefined }));
    expect(row.executionSite).toBe("backend");
    const raw = store.db.get<{ execution_site: unknown }>(
      "SELECT execution_site FROM local_policy_audit WHERE id = ?",
      row.id,
    );
    expect(raw?.execution_site).toBe("backend");
  });

  it("still records nothing that could carry an argument or a credential", () => {
    const row = store.localPolicyAudit.record(draft({ executionSite: "widget-host" }));
    // The guarantee 0010 enforces by omission, re-checked now that a writer has
    // one more field to pass through.
    const columns = store.db
      .all<{ name: string }>("PRAGMA table_info(local_policy_audit)")
      .map((column) => column.name);
    for (const forbidden of ["input", "arguments", "args", "output", "content", "error", "token"]) {
      expect(columns.some((name) => name.includes(forbidden))).toBe(false);
    }
    expect(Object.keys(row)).not.toContain("input");
  });
});
