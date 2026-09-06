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
  DevServersRepo,
  ProjectsRepo,
  SessionsRepo,
  SettingsRepo,
  TasksRepo,
  ToolOutputsRepo,
  TurnsRepo,
  UsageRepo,
  WorkspaceLayoutsRepo,
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
  toolOutputs: ToolOutputsRepo;
  usage: UsageRepo;
  settings: SettingsRepo;
  /** Per-project dockview layout (migration 0004, SPEC R17). */
  workspaceLayouts: WorkspaceLayoutsRepo;
  /** Detected/custom dev server definitions (migration 0004, SPEC R18) — the
   *  live run state is never persisted; see `DevServerRunSchema`. */
  devServers: DevServersRepo;
  /** Agent-derived and manual tasks (migration 0004, SPEC R16/P10). */
  tasks: TasksRepo;
  /** Migrations applied by this open, and the backup taken beforehand. */
  migration: { applied: string[]; backupFile: string | null };
  /** Turns/sessions this open had to close because the last run did not. */
  reconciled: { turns: number; sessions: number };
  close(): void;
}

/**
 * Close out anything the previous run left mid-flight.
 *
 * Nothing in the process can still be streaming into a turn the moment the
 * database is opened, so a `streaming` row is the fingerprint of a crash or a
 * quit during a turn. Left alone it locks that session's composer forever: the
 * renderer seeds `turnStatus` from these rows, `isBusy` stays true, and
 * `chat.interrupt` has no live turn to stop.
 */
function reconcileInFlight(db: Database): { turns: number; sessions: number } {
  const turns = db.run("UPDATE turns SET status = 'interrupted' WHERE status = 'streaming'");
  const sessions = db.run(
    "UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'waiting')",
  );
  return { turns, sessions };
}

export function openStore(file: string, options: OpenDatabaseOptions = {}): CapygenStore {
  const { db, result } = openDatabase(file, options);
  const reconciled = reconcileInFlight(db);
  return {
    reconciled,
    db,
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    turns: new TurnsRepo(db),
    blocks: new BlocksRepo(db),
    toolOutputs: new ToolOutputsRepo(db),
    usage: new UsageRepo(db),
    settings: new SettingsRepo(db),
    workspaceLayouts: new WorkspaceLayoutsRepo(db),
    devServers: new DevServersRepo(db),
    tasks: new TasksRepo(db),
    migration: result,
    close: () => db.close(),
  };
}
