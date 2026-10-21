import { applyMigration, maybeOne, migrationFiles, MIGRATIONS_TABLE, type Database, type Db } from './client';

/**
 * The online demo's Postgres database is emptied every night at 03:00 IST, so nothing visitors enter stays long.
 * Each server checks at most every few minutes. The first to find a new day rebuilds the schema in one transaction,
 * so the others see either yesterday's data or a fresh database, never half of one.
 */
const CHECK_EVERY_MS = 5 * 60_000;
let checkedAt = 0;

/** The demo's day starts at 03:00 IST (21:30 UTC). */
const demoDay = () => new Date(Date.now() + 2.5 * 3600_000).toISOString().slice(0, 10);

/** Empties the database if it has not been emptied this demo day. True when this server did it. */
export async function wipeIfDue(db: Database): Promise<boolean> {
  if (Date.now() - checkedAt < CHECK_EVERY_MS) return false;
  checkedAt = Date.now();
  const day = demoDay();
  if (await wipedOn(db) === day) return false;
  return db.transaction(async (tx) => {
    if (await wipedOn(tx) === day) return false; // another server has just done it
    await tx.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await tx.exec(MIGRATIONS_TABLE);
    for (const file of migrationFiles()) await applyMigration(tx, file);
    await tx.exec('CREATE TABLE demo_meta (key text PRIMARY KEY, value text NOT NULL)');
    await tx.query(`INSERT INTO demo_meta (key, value) VALUES ('wiped_on', $1)`, [day]);
    return true;
  });
}

async function wipedOn(db: Db): Promise<string | null> {
  const t = await db.query<{ t: string | null }>(`SELECT to_regclass('demo_meta')::text AS t`);
  if (!t.rows[0].t) return null;
  return (await maybeOne<{ value: string }>(db, `SELECT value FROM demo_meta WHERE key = 'wiped_on'`))?.value ?? null;
}
