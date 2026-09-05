/**
 * The only file in capygen that names a SQLite driver.
 *
 * Driver: Node's built-in `node:sqlite` (`DatabaseSync`) — see
 * docs/adr/0003-sqlite-driver.md for the measurement that chose it over
 * better-sqlite3 (available in Electron 44.2.0 / Node 24.20.0 and in the Node
 * 22.16 test runner, so no native rebuild step exists anywhere).
 *
 * Everything above this file talks to the `Database` facade, so swapping the
 * driver back is a one-file change.
 */
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Database {
  /** Run one or more statements with no parameters (DDL, PRAGMA). */
  exec(sql: string): void;
  /** First row, or undefined. */
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  /** All rows. */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Write; returns rows changed. */
  run(sql: string, ...params: SqlValue[]): number;
  /** Wrap `fn` in a transaction; rolls back and rethrows on error. */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Path on disk, or ":memory:". */
  readonly file: string;
}

export interface OpenOptions {
  /** `PRAGMA journal_mode = WAL`. Off for :memory: (WAL needs a file). */
  wal?: boolean;
}

/**
 * Open a raw connection. Callers normally want `openDatabase` from
 * `./migrate.js`, which also runs migrations and takes the backup.
 */
export function openRaw(file: string, options: OpenOptions = {}): Database {
  const db = new DatabaseSync(file);
  const memory = file === ":memory:";
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (options.wal !== false && !memory) db.exec("PRAGMA journal_mode = WAL");

  let depth = 0;

  return {
    file,
    exec(sql) {
      db.exec(sql);
    },
    get<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    run(sql, ...params) {
      const result = db.prepare(sql).run(...params);
      return Number(result.changes);
    },
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction via SAVEPOINT, so a repository
      // method that opens one can still be called from inside a bigger unit.
      const savepoint = `sp_${depth}`;
      if (depth === 0) db.exec("BEGIN");
      else db.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const out = fn();
        depth -= 1;
        if (depth === 0) db.exec("COMMIT");
        else db.exec(`RELEASE ${savepoint}`);
        return out;
      } catch (err) {
        depth -= 1;
        if (depth === 0) db.exec("ROLLBACK");
        else db.exec(`ROLLBACK TO ${savepoint}`);
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}

/** JSON helpers: SQLite has no JSON type, so every blob column goes through these. */
export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function fromJson<T>(value: SqlValue | undefined, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const boolToInt = (v: boolean): number => (v ? 1 : 0);
export const intToBool = (v: SqlValue | undefined): boolean => Number(v ?? 0) === 1;
