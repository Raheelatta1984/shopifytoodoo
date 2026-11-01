/**
 * Applies the pending database migrations.
 *
 *   npm run migrate
 */
import { createDb } from '../db/factory.js';
import { runMigrations } from '../db/migrate.js';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDb(config);
  try {
    const applied = await runMigrations(db);
    if (applied.length === 0) {
      console.log('The database schema is already up to date.');
    } else {
      console.log(`Applied migrations: ${applied.join(', ')}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
