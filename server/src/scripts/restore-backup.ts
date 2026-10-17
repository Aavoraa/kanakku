import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { dataDirOwner, openDb, many } from '../db/client';
import { listBackups } from '../db/backup';

// Replaces the database with a backup. The current database is kept, renamed, next to it.
// Stop the server first. Usage: npm run restore-backup -- <file.tar.gz>   (no argument lists the backups)
const [fileArg] = process.argv.slice(2);
if (!fileArg) {
  const files = listBackups(config.backupDir).reverse();
  console.log(files.length ? `Backups in ${config.backupDir}:\n${files.join('\n')}` : `No backups in ${config.backupDir} yet.`);
  console.log('\nUsage: npm run restore-backup -- <file.tar.gz>');
  process.exit(0);
}
const file = fs.existsSync(fileArg) ? path.resolve(fileArg) : path.join(config.backupDir, fileArg);
if (!fs.existsSync(file)) { console.error(`No such file: ${fileArg}`); process.exit(1); }
const owner = dataDirOwner(config.dbDir);
if (owner) { console.error(`The server is running (pid ${owner}). Stop it with Ctrl+C, then restore.`); process.exit(1); }

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const kept = `${config.dbDir}-before-restore-${stamp}`;
if (fs.existsSync(config.dbDir)) fs.renameSync(config.dbDir, kept);
try {
  const db = await openDb(config.dbDir, { loadDataDir: new Blob([new Uint8Array(fs.readFileSync(file))]) });
  const companies = await many<{ name: string }>(db, `SELECT name FROM companies ORDER BY created_at`);
  await db.close();
  console.log(`Restored ${path.basename(file)}: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} (${companies.map((c) => c.name).join(', ')}).`);
  if (fs.existsSync(kept)) console.log(`The database it replaced is kept in ${kept}; delete it once you are happy.`);
} catch (e) {
  console.error(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
  fs.rmSync(config.dbDir, { recursive: true, force: true });
  if (fs.existsSync(kept)) { fs.renameSync(kept, config.dbDir); console.error('The previous database was put back.'); }
  process.exitCode = 1;
}
