import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb, type Database } from './db/client';
import { openPostgres, ownDatabase } from './db/postgres';
import { wipeIfDue } from './db/demo-wipe';
import { buildApp } from './app';
import { config } from './config';
import { createDemoLogin } from './auth/auth';

/**
 * Entry point for the Vercel demo (built by scripts/vercel-build.mjs). Vercel runs several copies of this at once,
 * so they share one Postgres server (DATABASE_URL, e.g. Neon from Vercel's Storage tab), using a database of their
 * own there that is emptied every night. Without one, each copy keeps its own in-memory database and a login only works on the copy that made it.
 * Backups, reminder digests and document processing are left out: nothing stays running between requests.
 */
const url = config.demoDatabase?.url;
// The demo's own database on that server: it is emptied every night, so nothing else may live in it.
// KANNAKU_DEMO_DATABASE only serves local checks, whose stand-in server has a single database.
const DEMO_DATABASE = process.env.KANNAKU_DEMO_DATABASE || 'kannaku_demo';

async function start() {
  let db: Database | null = null;
  try {
    if (url) {
      console.log(`Using the Postgres server in ${config.demoDatabase!.variable}, database ${DEMO_DATABASE}.`);
      db = await openPostgres(await ownDatabase(url, DEMO_DATABASE));
      await wipeIfDue(db, DEMO_DATABASE);
    } else {
      console.warn('No DATABASE_URL: using an in-memory database, so logins break when Vercel runs more than one copy. '
        + 'Connect a Neon database in the Vercel project (Storage) and redeploy.');
      db = await openDb();
    }
    if (config.demoLogin) await createDemoLogin(db, config.demoLogin);
    const app = await buildApp(db);
    await app.ready();
    return { app, db };
  } catch (e) {
    await db?.close().catch(() => {});
    throw e;
  }
}

let ready = start();
ready.catch(() => {}); // reported by the handler; an unhandled rejection would crash the function

/** A startup error for the visitor, without the database's address, user or password. */
function startError(e: unknown): string {
  const err = e as { message?: string; code?: string };
  let message = `${err.message ?? String(e)}${err.code ? ` (${err.code})` : ''}`;
  if (url) {
    try {
      const u = new URL(url);
      for (const secret of [url, u.password, u.username, u.host, u.hostname]) if (secret) message = message.split(secret).join('…');
    } catch { /* not a URL: nothing to hide */ }
  }
  return message.slice(0, 400);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let started: Awaited<typeof ready>;
  try {
    started = await ready;
  } catch (e) {
    console.error('The demo could not start:', e);
    ready = start(); // try again on the next request
    ready.catch(() => {});
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'DEMO_START_FAILED', message: `The demo could not start: ${startError(e)}`, details: null }));
    return;
  }
  const { app, db } = started;
  if (url) {
    try {
      if (await wipeIfDue(db, DEMO_DATABASE) && config.demoLogin) await createDemoLogin(db, config.demoLogin);
    } catch (e) {
      console.error('Nightly demo wipe failed:', e);
    }
  }
  app.server.emit('request', req, res);
}
