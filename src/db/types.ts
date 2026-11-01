/**
 * Minimal database abstraction.
 *
 * The same code runs against:
 *  - a pooled Postgres connection (Neon, or any managed Postgres), and
 *  - an embedded PGlite instance (development / CI / air-gapped demos).
 *
 * Both expose the same tiny surface, which keeps the repositories portable.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  readonly kind: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a database transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres returns numeric/bigint columns as strings - normalise to number. */
export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Postgres returns jsonb as a parsed object, but some drivers return text. */
export function json<T = unknown>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  return [value as T];
}
