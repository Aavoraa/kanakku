import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types, type Transaction } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/** Anything we can run queries on: the database or an open transaction. */
export type Db = PGlite | Transaction;

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

async function migrate(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
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
