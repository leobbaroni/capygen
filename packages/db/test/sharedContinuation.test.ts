/**
 * Shared-bundle continuation (P15).
 *
 * The invariant that matters: a continuation is a *fresh* session that can
 * never be confused with resuming the sender's, and each artifact kind asserts
 * its own so neither silently accepts the other's.
 *
 * (Cross-session pending requests are queried in `ipc/handlers.ts` and covered
 * by the desktop suite; this file deliberately holds no second implementation.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;
let projectId: string;

const open = (): CapygenStore => openStore(file, { migrationsDir: MIGRATIONS_DIR });

function liveSession(title: string): string {
  return store.sessions.create({
    projectId, mode: "solo", title,
    agents: [{ name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead", config: null }],
  }).session.id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-approve-"));
  file = path.join(dir, "capygen.db");
  store = open();
  projectId = store.projects.upsertByPath({ path: path.join(dir, "p"), name: "p" }).id;
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("continuing from a received shared bundle", () => {
  function seedBundle(): string {
    const sessionId = store.sessions.create({
      projectId, mode: "solo", title: "Their session", agents: [],
    }).session.id;
    // Written directly: the case is about the continuation guard, not about
    // how the artifact was committed.
    store.db.run("UPDATE sessions SET origin = 'import', artifact_kind = 'shared-bundle' WHERE id = ?", sessionId);
    store.db.run(
      `INSERT INTO share_imports
         (session_id, bundle_id, content_sha256, schema_version, app_version,
          bundle_created_at, metadata_json, imported_at)
       VALUES (?, ?, ?, 1, '0.1.0', '2026-09-07T10:00:00Z', '{}', 1)`,
      sessionId, "a".repeat(32), "b".repeat(64),
    );
    return sessionId;
  }

  it("links a fresh live session and never reuses the sender's identity", () => {
    const source = seedBundle();
    const destination = liveSession("Continued");

    const linked = store.shares.linkContinuation(destination, source);
    expect(linked.id).toBe(destination);
    expect(linked.id).not.toBe(source);
    expect(linked.origin).toBe("live");
    expect(linked.continuationSourceSessionId).toBe(source);
    // The source stays exactly what it was: a read-only artifact.
    expect(store.sessions.get(source)?.origin).toBe("import");
    expect(store.shares.artifactKindOf(source)).toBe("shared-bundle");
  });

  it("refuses a native transcript through the shared continuation path", () => {
    const destination = liveSession("Continued");
    const nativeSource = store.sessions.create({
      projectId, mode: "solo", agents: [],
    }).session.id;
    store.db.run(
      "UPDATE sessions SET origin = 'import', artifact_kind = 'native-transcript' WHERE id = ?",
      nativeSource,
    );
    // Each artifact kind asserts its own; neither silently accepts the other's.
    expect(() => store.shares.linkContinuation(destination, nativeSource))
      .toThrow(/received shared bundle/);
  });

  it("refuses a destination that is not a fresh, idle, unlinked live session", () => {
    const source = seedBundle();

    // Already an artifact.
    expect(() => store.shares.linkContinuation(source, source)).toThrow(/must be a live session/);

    // Already carries a turn.
    const used = liveSession("Used");
    store.turns.create({ sessionId: used, role: "user", status: "done" });
    expect(() => store.shares.linkContinuation(used, source)).toThrow(/no turns/);

    // Already linked.
    const once = liveSession("Once");
    store.shares.linkContinuation(once, source);
    expect(() => store.shares.linkContinuation(once, source)).toThrow(/already linked/);

    expect(() => store.shares.linkContinuation("ses_missing", source)).toThrow(/unknown session/);
  });
});
