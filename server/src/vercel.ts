import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb } from './db/client';
import { buildApp } from './app';

/**
 * Entry point for the Vercel demo (built by scripts/vercel-build.mjs). Each running instance keeps its own
 * in-memory database, so everything entered is lost when the instance stops. Backups, reminder digests and
 * resuming document processing are left out: nothing stays running between requests.
 */
const ready = (async () => {
  const db = await openDb();
  const app = await buildApp(db);
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
