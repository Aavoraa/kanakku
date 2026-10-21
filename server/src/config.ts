import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

// Load .env from the repo root if present (Node >= 21). The app writes the API key here too.
const envFile = path.resolve(ROOT_DIR, process.env.ENV_FILE ?? '.env');
try {
  process.loadEnvFile(envFile);
} catch {
  /* no .env file — fine */
}

// On Vercel the app runs as a public demo: the database lives in memory and only /tmp is writable.
const demo = process.env.VERCEL === '1';

const dataDir = path.resolve(ROOT_DIR, process.env.DATA_DIR ?? (demo ? '/tmp/kannaku' : 'data'));

export const config = {
  demo,
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  envFile,
  dbDir: path.join(dataDir, 'pg'),
  uploadDir: path.join(dataDir, 'uploads'),
  // Finished backup files are safe to keep in a synced folder (unlike the live database).
  backupDir: path.resolve(ROOT_DIR, process.env.BACKUP_DIR ?? path.join(dataDir, 'backups')),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  model: process.env.LEDGERAI_MODEL ?? 'claude-opus-5-5',
  aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Single local user until auth lands (Phase 4).
  localUserId: '00000000-0000-4000-8000-000000000001',
};
