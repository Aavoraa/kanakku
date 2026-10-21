import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// The same tests, with every in-memory database reached through the Postgres driver (see test/setup-postgres.ts).
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['test/setup-postgres.ts'],
    // Skipped here, still run by `npm test`:
    // - database files, locks, backups and restores, which are PGlite's own;
    // - one trigger check: PGlite's socket server drops the connection when a trigger raises on a query without
    //   parameters (real Postgres does not; the same error with a parameter comes back correctly).
    testNamePattern: /^(?!.*(backups and the database lock|manage the AI key and backups|refuses to update or delete posted rows))/,
  },
}));
