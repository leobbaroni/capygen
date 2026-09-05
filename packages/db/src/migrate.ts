/**
 * Migration runner: numbered `NNNN_name.sql` files applied in order, recorded in
 * `schema_migrations`, each file wrapped in a transaction.
 *
 * Backup: SPEC.md §Data says rollback = restore the copy the migrator writes
 * next to the DB. That copy is taken with a plain file copy **before the
 * database is opened** — no connection holds the file, no WAL is in flight, so
 * the copy is a coherent snapshot without needing a driver backup API (which
 * `node:sqlite` does not have; see docs/adr/0003-sqlite-driver.md).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRaw, type Database, type OpenOptions } from "./driver.js";

export interface Migration {
  /** `0001_init` — sorts lexicographically, which is also the apply order. */
  id: string;
  sql: string;
}

export interface MigrateResult {
  applied: string[];
  /** Path of the pre-migration copy, or null when nothing needed migrating. */
  backupFile: string | null;
}

/**
 * The migrations shipped with this package. In the Electron bundle the SQL is
 * copied next to `main.cjs`, so the desktop app passes its own directory rather
 * than relying on a path relative to a bundled module.
 */
export function packagedMigrationsDir(): string {
  // Two runtimes reach this: ESM (vitest, tsx) where `import.meta.url` points at
  // this source file, and the CommonJS Electron bundle where esbuild empties
  // `import.meta` and the desktop build has copied the SQL next to main.cjs.
  const url = (import.meta as ImportMeta | undefined)?.url;
  if (typeof url === "string") return fileURLToPath(new URL("../migrations", url));
  if (typeof __dirname === "string") return path.join(__dirname, "migrations");
  throw new Error(
    "packagedMigrationsDir(): cannot locate migrations; pass migrationsDir explicitly",
  );
}

export function readMigrations(dir: string): Migration[] {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return entries.map((file) => ({
    id: file.replace(/\.sql$/, ""),
    sql: fs.readFileSync(path.join(dir, file), "utf8"),
  }));
}

function ensureMigrationsTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id          TEXT PRIMARY KEY,
       applied_at  INTEGER NOT NULL
     )`,
  );
}

/**
 * Ids already applied. Read-only on purpose: the pre-backup peek must not write
 * to a database it is about to copy, so a missing table reads as "none applied"
 * rather than being created here.
 */
function appliedIds(db: Database): Set<string> {
  const exists = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!exists) return new Set();
  const rows = db.all<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((r) => r.id));
}

/** Which of `migrations` this database still needs, in apply order. */
export function pendingMigrations(db: Database, migrations: Migration[]): Migration[] {
  const done = appliedIds(db);
  return migrations.filter((m) => !done.has(m.id));
}

/**
 * Copy `file` to `<file>.backup-<timestamp>.db` when it exists and is non-empty.
 * Returns the copy's path, or null when there was nothing to back up.
 */
export function backupBeforeMigrate(file: string, now = new Date()): string | null {
  if (file === ":memory:") return null;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null; // fresh install: nothing to lose
  }
  if (size === 0) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = `${file}.backup-${stamp}.db`;
  fs.copyFileSync(file, target);
  return target;
}

/** Apply `migrations` that have not run yet. Assumes the backup is already taken. */
export function migrate(db: Database, migrations: Migration[]): string[] {
  ensureMigrationsTable(db);
  const pending = pendingMigrations(db, migrations);
  const applied: string[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
        m.id,
        Date.now(),
      );
    });
    applied.push(m.id);
  }
  return applied;
}

export interface OpenDatabaseOptions extends OpenOptions {
  /** Directory holding the numbered `.sql` files. */
  migrationsDir?: string;
  migrations?: Migration[];
  /** Called with the backup path when one was written. */
  onBackup?: (file: string) => void;
  onMigrate?: (applied: string[]) => void;
}

export interface OpenedDatabase {
  db: Database;
  result: MigrateResult;
}

/**
 * Open `file`, back it up if migrations are pending, migrate, and hand back the
 * live connection. This is the entry point the main process uses.
 */
export function openDatabase(
  file: string,
  options: OpenDatabaseOptions = {},
): OpenedDatabase {
  const migrations =
    options.migrations ?? readMigrations(options.migrationsDir ?? packagedMigrationsDir());

  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  // Decide whether a backup is needed *before* taking the real connection: peek
  // with a short-lived one, close it, copy the file, then open for real.
  let backupFile: string | null = null;
  if (file !== ":memory:" && fs.existsSync(file)) {
    const peek = openRaw(file, { wal: false });
    let needsWork = false;
    try {
      needsWork = pendingMigrations(peek, migrations).length > 0;
    } finally {
      peek.close();
    }
    if (needsWork) {
      backupFile = backupBeforeMigrate(file);
      if (backupFile) options.onBackup?.(backupFile);
    }
  }

  const db = openRaw(file, options);
  const applied = migrate(db, migrations);
  if (applied.length > 0) options.onMigrate?.(applied);
  return { db, result: { applied, backupFile } };
}
