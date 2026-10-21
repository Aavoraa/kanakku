import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb, type Database } from './db/client';
import { openPostgres } from './db/postgres';
import { wipeIfDue } from './db/demo-wipe';
import { buildApp } from './app';
import { config } from './config';
import { createDemoLogin } from './auth/auth';

/**
 * Entry point for the Vercel demo (built by scripts/vercel-build.mjs). Vercel runs several copies of this at once,
 * so they share one Postgres database (DATABASE_URL, e.g. Neon from Vercel's Storage tab), which is emptied every
 * night. Without one, each copy keeps its own in-memory database and a login only works on the copy that made it.
 * Backups, reminder digests and document processing are left out: nothing stays running between requests.
 */
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const ready = (async () => {
  let db: Database;
  if (url) {
    db = await openPostgres(url);
    await wipeIfDue(db);
  } else {
    console.warn('DATABASE_URL is not set: using an in-memory database, so logins break when Vercel runs more than one copy.');
    db = await openDb();
  }
  if (config.demoLogin) await createDemoLogin(db, config.demoLogin);
  const app = await buildApp(db);
  await app.ready();
  return { app, db };
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { app, db } = await ready;
  if (url) {
    try {
      if (await wipeIfDue(db) && config.demoLogin) await createDemoLogin(db, config.demoLogin);
    } catch (e) {
      console.error('Nightly demo wipe failed:', e);
    }
  }
  app.server.emit('request', req, res);
}
