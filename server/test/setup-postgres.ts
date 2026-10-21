// Used by vitest.pg.config.ts: every in-memory database a test opens is reached through the Postgres driver
// (db/postgres.ts) instead of directly, with PGlite serving the Postgres wire protocol on a local port.
// This checks the online demo's database code against the same tests as the app on this computer.
import { vi } from 'vitest';
import { PGlite, types } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { openPostgres } from '../src/db/postgres';

let nextPort = 54_000 + Math.floor(Math.random() * 5_000);

async function viaPostgres() {
  const pglite = await PGlite.create({ extensions: { ltree, pg_trgm }, parsers: { [types.INT8]: (v: string) => BigInt(v) } });
  const port = nextPort++;
  const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await server.start();
  // One connection: PGlite has a single session, so a second connection would share the first one's transaction.
  const db = await openPostgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  const close = db.close.bind(db);
  db.close = async () => { await close(); await server.stop(); await pglite.close(); };
  return db;
}

vi.mock(import('../src/db/client'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Databases on disk, and restores, stay PGlite: only in-memory ones go through Postgres.
    openDb: (async (dataDir?: string, opts?: { loadDataDir?: Blob }) =>
      dataDir || opts?.loadDataDir ? actual.openDb(dataDir, opts) : viaPostgres()) as unknown as typeof actual.openDb,
  };
});
