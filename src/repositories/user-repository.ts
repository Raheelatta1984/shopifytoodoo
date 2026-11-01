/**
 * Application users and API keys.
 *
 * API keys are never stored in clear text: only a SHA-256 hash is kept, and
 * the lookup is a single indexed query.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/types.js';

export const ROLES = ['viewer', 'operator', 'approver', 'integrator', 'auditor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AppUser {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt?: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function generateApiKey(): string {
  return `sto_${randomBytes(24).toString('hex')}`;
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByApiKey(apiKey: string): Promise<AppUser | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM app_user WHERE api_key_hash = $1 AND active',
      [hashApiKey(apiKey)],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as Role,
      active: Boolean(row.active),
      createdAt: row.created_at ? String(row.created_at) : undefined,
    };
  }

  /** Create the user if the API key is new, refresh the role if it already exists. */
  async upsert(name: string, role: Role, apiKey: string): Promise<AppUser> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO app_user (name, role, api_key_hash) VALUES ($1,$2,$3)
       ON CONFLICT (api_key_hash) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = true
       RETURNING *`,
      [name, role, hashApiKey(apiKey)],
    );
    const row = rows[0]!;
    return {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as Role,
      active: Boolean(row.active),
      createdAt: row.created_at ? String(row.created_at) : undefined,
    };
  }

  async list(): Promise<AppUser[]> {
    const { rows } = await this.db.query('SELECT * FROM app_user ORDER BY name');
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as Role,
      active: Boolean(row.active),
      createdAt: row.created_at ? String(row.created_at) : undefined,
    }));
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query('UPDATE app_user SET active = false WHERE id = $1', [id]);
  }
}
