/**
 * Shared setup for the Phase 5 workspace-service tests: a real temp SQLite
 * store (migrations and all) plus a real temp project directory, because every
 * service here resolves a `projectId` to a path through `projects.get` and
 * then touches the disk. Nothing is mocked that a test could exercise for
 * real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import type { EventChannel } from "@capygen/shared";
import type { Broadcast, EngineLogger } from "../src/engine/types.js";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

export const FIXTURES_DIR = fileURLToPath(
  new URL("../../../tests/fixtures/servers", import.meta.url),
);

export interface Harness {
  dir: string;
  root: string;
  store: CapygenStore;
  projectId: string;
  log: EngineLogger;
  broadcast: Broadcast;
  events: { channel: EventChannel; payload: unknown }[];
  eventsOn(channel: EventChannel): unknown[];
  close(): void;
}

/**
 * `root` defaults to a fresh empty directory inside the temp dir; pass an
 * existing path (a fixture project) to point the store's project row at it.
 * The path is realpath'd because `os.tmpdir()` on this machine is an 8.3 short
 * name (`C:\Users\TUGAPL~1\...`) and the containment checks compare resolved
 * paths.
 */
export function makeHarness(options: { root?: string; prefix?: string } = {}): Harness {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "capygen-ws-")),
  );
  const root = options.root ?? path.join(dir, "project");
  if (!options.root) fs.mkdirSync(root, { recursive: true });

  const store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  const project = store.projects.upsertByPath({ path: root });
  const events: { channel: EventChannel; payload: unknown }[] = [];
  const broadcast: Broadcast = (channel, payload) => void events.push({ channel, payload });

  return {
    dir,
    root,
    store,
    projectId: project.id,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcast,
    events,
    eventsOn: (channel) => events.filter((e) => e.channel === channel).map((e) => e.payload),
    close: () => {
      store.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a pty or a dev server may still hold a handle on Windows; the OS
           cleans the temp dir eventually and a failed rmdir must not fail a
           passing test */
      }
    },
  };
}

/** Write `files` (relative path → contents) under `root`, creating directories. */
export function seed(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it is true or `timeoutMs` passes; returns whether it
 *  became true, so a test can assert on it with a readable message. */
export async function waitFor(
  check: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}
