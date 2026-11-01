import { Pool, type PoolConfig } from 'pg';
import type { Db, QueryResult } from './types.js';

export interface PostgresOptions {
  connectionString: string;
  max?: number;
  ssl?: 'disable' | 'require' | 'verify-full';
}

/**
 * Neon (and most managed Postgres providers) terminates TLS on the database
 * endpoint.  The pooled endpoint additionally requires `prepare: false` when
 * used through PgBouncer / the Neon transaction pooler.
 */
export function buildPoolConfig(options: PostgresOptions): PoolConfig {
  const isNeon = /neon\.tech|neonbuild\.com/.test(options.connectionString);
  const isPooler = /-pooler/.test(options.connectionString);
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'shopifytoodoo',
  };
  if (isNeon || options.ssl === 'require' || options.ssl === 'verify-full') {
    config.ssl = options.ssl === 'verify-full' ? { rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  if (isNeon && isPooler) {
    // Neon transaction pooler does not support prepared statements.
    (config as Record<string, unknown>).prepare = false;
  }
  return config;
}

export class PostgresDb implements Db {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;

  constructor(options: PostgresOptions) {
    this.pool = new Pool(buildPoolConfig(options));
    this.pool.on('error', (err) => {
      // Keep the process alive; the pool discards the broken client.
      console.error('[db] idle client error', err);
    });
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Db = {
      kind: this.kind,
      query: async <R>(text: string, params: readonly unknown[] = []) => {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      transaction: async <R>(inner: (nested: Db) => Promise<R>) =>
        inner({
          kind: this.kind,
          query: async <Q>(text: string, params: readonly unknown[] = []) => {
            const result = await client.query(text, params as unknown[]);
            return { rows: result.rows as Q[], rowCount: result.rowCount ?? result.rows.length };
          },
          exec: async (sql: string) => {
            await client.query(sql);
          },
          transaction: async () => {
            throw new Error('Nested transactions are not supported');
          },
          close: async () => undefined,
        }),
      close: async () => undefined,
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
