import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

/** How many automatic daily backups to keep in data/backups. */
export const KEEP_BACKUPS = 14;
const DAY_MS = 864e5;
const NAME_RE = /^kannaku-\d{8}-\d{6}\.tar\.gz$/;

/**
 * A consistent copy of the whole database (every company on this installation) as a .tar.gz.
 * The dump runs inside a transaction so no other query can write while the files are read, after a
 * CHECKPOINT has flushed everything to them.
 */
export async function dumpDatabase(db: PGlite): Promise<Uint8Array<ArrayBuffer>> {
  let blob: Blob | null = null;
  await db.transaction(async (tx) => {
    await tx.exec('CHECKPOINT');
    blob = await db.dumpDataDir('gzip');
  });
  return new Uint8Array(await blob!.arrayBuffer());
}

export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `kannaku-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.tar.gz`;
}

export function listBackups(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort(); } catch { return []; }
}

/** Writes a backup to `dir` and deletes the oldest ones beyond `keep`. Returns the new file's path. */
export async function writeBackup(db: PGlite, dir: string, keep = KEEP_BACKUPS): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName());
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, await dumpDatabase(db));
  fs.renameSync(tmp, file);
  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

/** Backs up now if the newest backup is a day old (or there is none), then once a day while running. */
export function scheduleBackups(db: PGlite, dir: string): () => void {
  const run = async () => {
    const newest = listBackups(dir).at(-1);
    const age = newest ? Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs : Infinity;
    if (age < DAY_MS) return;
    try {
      const file = await writeBackup(db, dir);
      console.log(`Backup saved: ${file}`);
    } catch (e) {
      console.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void run();
  const timer = setInterval(() => void run(), 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
