import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { config } from './config';
import { DatabaseInUseError, openDb } from './db/client';
import { scheduleBackups } from './db/backup';
import { seedDemo } from './db/demo';
import { buildApp } from './app';
import { resumePending } from './ai/documents';
import { purgeExpiredSessions } from './auth/auth';

// A sync client (OneDrive, Dropbox, Google Drive) rewriting the live database files mid-write corrupts them.
const synced = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
  .filter((d): d is string => Boolean(d))
  .some((d) => (path.resolve(config.dbDir) + path.sep).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep));
if (synced || /[\\/](OneDrive|Dropbox|Google Drive)[\\/]/i.test(config.dbDir)) {
  console.warn(`\nWARNING: the database (${config.dbDir}) is inside a cloud-synced folder.`
    + '\nSyncing a live database can corrupt it. Stop the server, move the "data" folder somewhere that is not synced'
    + '\n(for example C:\\KannakuData), and set DATA_DIR=C:\\KannakuData in .env. Backups can stay in the synced folder:'
    + '\nset BACKUP_DIR to it.\n');
}

let db: PGlite;
try {
  db = await openDb(config.dbDir);
} catch (e) {
  if (e instanceof DatabaseInUseError) { console.error(e.message); process.exit(1); }
  throw e;
}
await purgeExpiredSessions(db);

// Fresh installs start empty: the first visitor signs up and enters their own business.
// LEDGERAI_DEMO=1 pre-loads the sample company (it is claimed by the first account).
const companies = await db.query<{ n: bigint }>('SELECT COUNT(*)::bigint AS n FROM companies');
if (companies.rows[0].n === 0n && process.env.LEDGERAI_DEMO === '1') {
  console.log('Seeding the sample company "Sharma Building Supplies"...');
  await seedDemo(db);
}

const app = await buildApp(db, { serveWeb: true });
await resumePending(db);
scheduleBackups(db, config.backupDir);
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Kannaku AI on http://127.0.0.1:${config.port}  (AI ${config.aiEnabled ? `on, model ${config.model}` : 'off: click "AI off" in the app to add an API key'})`);

const shutdown = async () => { await app.close(); await db.close(); process.exit(0); };
// Close the embedded database cleanly on Ctrl+C, Ctrl+Break and when the terminal window is closed
// (Windows sends SIGHUP); a hard kill can leave PGlite's files half-written.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, shutdown);
