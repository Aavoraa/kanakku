import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/** Anything we can run queries on: the database or an open transaction. */
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

/** The database: PGlite on this computer, or Postgres for the online demo (db/postgres.ts). */
export interface Database extends Db {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Opens the database. `dataDir` undefined = in-memory (tests).
 * INT8 is always parsed to BigInt so money never passes through a float.
 */
export async function openDb(dataDir?: string, opts: { loadDataDir?: Blob } = {}): Promise<PGlite> {
  const release = dataDir ? lockDataDir(dataDir) : () => {};
  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const db = await PGlite.create({
      dataDir,
      loadDataDir: opts.loadDataDir,
      extensions: { ltree, pg_trgm },
      parsers: { [types.INT8]: (v: string) => BigInt(v) },
    });
    await migrate(db);
    const close = db.close.bind(db);
    db.close = async () => { try { await close(); } finally { release(); } };
    return db;
  } catch (e) {
    release();
    throw e;
  }
}

export class DatabaseInUseError extends Error {}

const lockPath = (dataDir: string) => `${path.resolve(dataDir)}.lock`;

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process id holding the database, or null when nobody has it open. */
export function dataDirOwner(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath(dataDir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isRunning(pid) ? pid : null;
  } catch { return null; }
}

/**
 * PGlite has no lock of its own: two processes on one data directory corrupt it. A lock file next to the
 * directory (data/pg.lock) holds the owner's pid; a lock left by a process that is gone is taken over.
 */
function lockDataDir(dataDir: string): () => void {
  const file = lockPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = dataDirOwner(dataDir);
  if (owner) {
    throw new DatabaseInUseError(`The database in ${dataDir} is already open in another process (pid ${owner}). Stop the Kannaku AI server with Ctrl+C first.`);
  }
  fs.writeFileSync(file, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  };
  process.once('exit', release);
  return release;
}

export async function migrate(db: Database) {
  const exists = await db.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`);
  const applied = new Set(exists.rows[0].t
    ? (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
    : []);
  for (const file of migrationFiles()) {
    if (applied.has(file)) continue;
    // Checked again inside the transaction: on Postgres several servers can start at once, and the
    // transaction's lock (db/postgres.ts) lets only one of them apply each file.
    await db.transaction(async (tx) => {
      await tx.exec(MIGRATIONS_TABLE);
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])).rows.length) return;
      await applyMigration(tx, file);
    });
  }
}

export const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;

export const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** Runs one migration file on an open transaction and records it (schema_migrations must exist). */
export async function applyMigration(tx: Db, file: string) {
  await tx.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  if (r.rows.length === 0) throw new Error(`Expected one row: ${sql.slice(0, 80)}`);
  return r.rows[0];
}

export async function maybeOne<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
