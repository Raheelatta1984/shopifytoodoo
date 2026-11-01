import type { AppConfig } from '../config.js';
import { PGliteDb } from './pglite.js';
import { PostgresDb } from './postgres.js';
import type { Db } from './types.js';

export async function createDb(config: AppConfig): Promise<Db> {
  if (config.DATABASE_URL) {
    const db = new PostgresDb({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      ssl: config.DB_SSL,
    });
    await db.query('SELECT 1');
    return db;
  }
  const db = new PGliteDb(config.PGLITE_PATH);
  await db.ready();
  return db;
}
