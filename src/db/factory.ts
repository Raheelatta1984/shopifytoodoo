import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  const db = new PGliteDb(await resolvePglitePath(config.PGLITE_PATH));
  await db.ready();
  return db;
}

/**
 * Resolves a writable location for the embedded database.
 *
 * A serverless runtime has a read only filesystem outside of `/tmp`, so the
 * configured path is tried first and the temporary directory is used as a
 * fallback; an in memory database is the last resort.
 */
async function resolvePglitePath(configured: string): Promise<string> {
  if (configured === 'memory://') return configured;
  const candidates = [configured, join(tmpdir(), 'shopifytoodoo-pglite')];
  for (const candidate of candidates) {
    try {
      const parent = dirname(resolve(candidate));
      await mkdir(parent, { recursive: true });
      await access(parent, constants.W_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return 'memory://';
}
