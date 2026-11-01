import type { Db } from './types.js';

export interface Migration {
  id: string;
  sql: string;
}

import * as m001 from './migrations/001_init.js';

export const MIGRATIONS: Migration[] = [{ id: m001.id, sql: m001.sql }];

/**
 * Apply any pending migration.  Migrations are idempotent and recorded in
 * `schema_migrations` so that they can be applied to a fresh Neon database or
 * an existing one.
 */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const executed: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.exec(migration.sql);
    await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    executed.push(migration.id);
  }
  return executed;
}
