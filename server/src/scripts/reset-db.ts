import fs from 'node:fs';
import { config } from '../config';
import { dataDirOwner } from '../db/client';

// Deletes the local database and uploads; the next start re-seeds the demo company.
const owner = dataDirOwner(config.dbDir);
if (owner) {
  console.error(`The server is running (pid ${owner}). Stop it with Ctrl+C first.`);
  process.exit(1);
}
for (const dir of [config.dbDir, config.uploadDir]) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}
