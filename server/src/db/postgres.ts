import pg from 'pg';
import { types } from '@electric-sql/pglite';
import { migrate, type Database, type Db } from './client';

/** Every transaction takes this one lock first (any fixed number would do). */
const TX_LOCK = 4_260_001;

// Dates sent as parameters are written in UTC, as PGlite writes them.
pg.defaults.parseInputDatesAsUTC = true;

type Parser = (x: string, typeId?: number) => unknown;

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']);
const isNetworkError = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return NETWORK_CODES.has(err.code ?? '') || /Connection terminated|socket disconnected/i.test(err.message ?? '');
};

/**
 * Opens a connection, trying again when the network drops it before it is ready (seen with Neon when several servers
 * start at once). Only opening is retried: nothing has been sent yet, so nothing can run twice.
 */
async function openWithRetry<T>(open: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await open();
    } catch (e) {
      if (attempt >= 3 || !isNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

/**
 * The address of a database called `name` on the same server as `url`, creating it if needed. The demo keeps its
 * tables in a database of its own, so neither its migrations nor its nightly wipe can touch anything else stored
 * on that server.
 */
export async function ownDatabase(url: string, name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Not a plain database name: ${name}`);
  const client = await openWithRetry(async () => {
    const c = new pg.Client({ connectionString: url });
    try { await c.connect(); } catch (e) { await c.end().catch(() => {}); throw e; }
    return c;
  });
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) {
      // Another server starting at the same moment may create it first (42P04: it already exists).
      await client.query(`CREATE DATABASE ${name}`).catch((e: { code?: string }) => { if (e.code !== '42P04') throw e; });
    }
  } finally {
    await client.end();
  }
  const own = new URL(url);
  own.pathname = `/${name}`;
  return own.toString();
}

/**
 * Postgres (Neon, for the Vercel demo) behind the same interface as PGlite, so the rest of the app cannot tell them
 * apart:
 * - values come back exactly as from PGlite: its own parsers are used, INT8 as BigInt, and arrays as PGlite builds them;
 * - transactions run one at a time, across every server sharing the database, as they do in PGlite. The posting and
 *   numbering code was written for that, so each transaction takes one shared lock before anything else.
 */
export async function openPostgres(url: string, opts: { max?: number } = {}): Promise<Database> {
  const parsers: Record<number, Parser> = { [types.INT8]: (v) => BigInt(v) };
  const parse = (oid: number) => (v: string) => types.parseType(v, oid, parsers);
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 4,
    idleTimeoutMillis: 10_000,
    types: { getTypeParser: parse } as unknown as pg.CustomTypesConfig,
  });
  // A connection the server closed while idle must not crash the process; the pool opens a new one.
  pool.on('error', (e) => console.warn(`Postgres connection dropped: ${e.message}`));

  // Always the extended protocol, as PGlite's query() uses: one statement, parameters bound separately.
  const run = async <T>(c: pg.PoolClient, sql: string, params: unknown[] = []) => {
    const values = params.map((p) => (typeof p === 'bigint' ? p.toString() : p));
    const r = await c.query({ text: sql, values, queryMode: 'extended' } as pg.QueryConfig);
    return { rows: r.rows as T[], affectedRows: r.rowCount ?? 0 };
  };
  const connect = () => openWithRetry(() => pool.connect());
  /** One statement on a pooled connection; a connection the network broke is closed rather than reused. */
  const onPool = async <T>(use: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await connect();
    let broken = false;
    try {
      return await use(client);
    } catch (e) {
      broken = isNetworkError(e);
      throw e;
    } finally {
      client.release(broken);
    }
  };

  // Array types, as PGlite registers them when it opens.
  const arrays = await onPool((c) => run<{ oid: number; typarray: number }>(c,
    `SELECT b.oid, b.typarray FROM pg_catalog.pg_type a LEFT JOIN pg_catalog.pg_type b ON b.oid = a.typelem
      WHERE a.typcategory = 'A' GROUP BY b.oid, b.typarray ORDER BY b.oid`));
  for (const t of arrays.rows) {
    parsers[t.typarray] = (x) => types.arrayParser(x, (el: string) => types.parseType(el, t.oid, parsers), t.typarray);
  }

  const db: Database = {
    query: <T>(sql: string, params?: unknown[]) => onPool((c) => run<T>(c, sql, params)),
    exec: (sql: string) => onPool((c) => c.query(sql)),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [TX_LOCK]);
        const result = await fn({
          query: <R>(sql: string, params?: unknown[]) => run<R>(client, sql, params),
          exec: (sql: string) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        broken = isNetworkError(e);
        await client.query('ROLLBACK').catch(() => { broken = true; });
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}
