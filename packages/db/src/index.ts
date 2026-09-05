/**
 * `@capygen/db` — SQLite storage for the main process (and tests).
 *
 * Driver decision: `node:sqlite` (docs/adr/0003-sqlite-driver.md).
 * Only the Electron main process opens the real database; renderers reach it
 * through the IPC contract in `@capygen/shared`.
 */
import { openDatabase, type OpenDatabaseOptions } from "./migrate.js";
import type { Database } from "./driver.js";
import {
  BlocksRepo,
  ProjectsRepo,
  SessionsRepo,
  SettingsRepo,
  TurnsRepo,
  UsageRepo,
} from "./repos.js";

export * from "./driver.js";
export * from "./migrate.js";
export * from "./repos.js";

/** Every repository over one connection. */
export interface CapygenStore {
  db: Database;
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  turns: TurnsRepo;
  blocks: BlocksRepo;
  usage: UsageRepo;
  settings: SettingsRepo;
  /** Migrations applied by this open, and the backup taken beforehand. */
  migration: { applied: string[]; backupFile: string | null };
  close(): void;
}

export function openStore(file: string, options: OpenDatabaseOptions = {}): CapygenStore {
  const { db, result } = openDatabase(file, options);
  return {
    db,
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    turns: new TurnsRepo(db),
    blocks: new BlocksRepo(db),
    usage: new UsageRepo(db),
    settings: new SettingsRepo(db),
    migration: result,
    close: () => db.close(),
  };
}
