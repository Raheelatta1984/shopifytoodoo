import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from './types.js';

/**
 * Embedded Postgres (PGlite) used for local development, CI and the
 * air-gapped demo.  It speaks the same SQL dialect as Neon, so migrations and
 * queries behave identically.
 */
export class PGliteDb implements Db {
  readonly kind = 'pglite' as const;
  private readonly pg: PGlite;
  private readonly dataDir: string;

  constructor(dataDir: string = 'memory://') {
    this.dataDir = dataDir;
    this.pg = new PGlite(dataDir);
  }

  async ready(): Promise<void> {
    if (!this.dataDir.startsWith('memory://')) {
      const target = resolve(this.dataDir);
      await mkdir(dirname(target), { recursive: true });
    }
    await this.pg.waitReady;
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pg.query<T>(text, params as unknown[]);
    const rows = (result.rows ?? []) as T[];
    const affected = (result as { affectedRows?: number }).affectedRows;
    return { rows, rowCount: affected ?? rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await this.pg.exec('BEGIN');
    try {
      const result = await fn(this);
      await this.pg.exec('COMMIT');
      return result;
    } catch (error) {
      await this.pg.exec('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
