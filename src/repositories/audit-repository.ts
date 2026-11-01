/**
 * Audit trail.
 *
 * Every state change is recorded with the acting user, their role, the
 * entity that changed and the outcome, satisfying the "only authorised roles,
 * with an audit trail" control (EV-A4B816C198 / REQ-007).
 */
import type { Db } from '../db/types.js';
import { json } from '../db/types.js';

export interface AuditEntry {
  actor: string;
  role?: string;
  action: string;
  entity?: string;
  entityId?: string;
  result?: 'success' | 'failure' | 'denied';
  ip?: string;
  detail?: unknown;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  role?: string;
  action: string;
  entity?: string;
  entityId?: string;
  result: string;
  ip?: string;
  detail?: unknown;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log (actor, role, action, entity, entity_id, result, ip, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.actor,
        entry.role ?? null,
        entry.action,
        entry.entity ?? null,
        entry.entityId ?? null,
        entry.result ?? 'success',
        entry.ip ?? null,
        JSON.stringify(entry.detail ?? null),
      ],
    );
  }

  async list(filter: { action?: string; entityId?: string; limit?: number; offset?: number } = {}): Promise<{
    items: AuditRow[];
    total: number;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.action) conditions.push(`action = ${push(filter.action)}`);
    if (filter.entityId) conditions.push(`entity_id = ${push(filter.entityId)}`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const limitParam = push(limit);
    const offsetParam = push(offset);

    const { rows } = await this.db.query(
      `SELECT * FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const count = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_log ${where}`,
      params.slice(0, params.length - 2),
    );

    return {
      items: rows.map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        actor: String(row.actor),
        role: row.role ? String(row.role) : undefined,
        action: String(row.action),
        entity: row.entity ? String(row.entity) : undefined,
        entityId: row.entity_id ? String(row.entity_id) : undefined,
        result: String(row.result),
        ip: row.ip ? String(row.ip) : undefined,
        detail: json(row.detail, undefined),
      })),
      total: Number(count.rows[0]?.count ?? rows.length),
    };
  }
}
