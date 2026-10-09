import type { AuditLogEntry, AuditQuery, Paginated } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';

interface AuditRow {
  id: number;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_device_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  severity: 'info' | 'warning' | 'critical';
}

export function mapAuditRow(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    actorDeviceId: row.actor_device_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details ?? {},
    ipAddress: row.ip_address,
    severity: row.severity,
  };
}

export class AuditQueryService {
  constructor(private readonly pool: DbPool) {}

  async query(q: AuditQuery): Promise<Paginated<AuditLogEntry>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (q.action) add('a.action LIKE ?', `${q.action}%`);
    if (q.actorUserId) add('a.actor_user_id = ?', q.actorUserId);
    if (q.entityType) add('a.entity_type = ?', q.entityType);
    if (q.from) add('a.occurred_at >= ?', q.from);
    if (q.to) add('a.occurred_at <= ?', q.to);
    if (q.search) {
      params.push(`%${q.search}%`);
      const p = `$${params.length}`;
      where.push(
        `(a.actor_label ILIKE ${p} OR a.action ILIKE ${p} OR a.entity_id ILIKE ${p} OR a.details::text ILIKE ${p})`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs a ${whereSql}`,
      params,
    );
    const rows = await this.pool.query<AuditRow>(
      `SELECT a.id, a.occurred_at, a.actor_user_id, a.actor_device_id, a.actor_label, a.action, a.entity_type,
              a.entity_id, a.details, a.ip_address, a.severity
         FROM audit_logs a ${whereSql}
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      items: rows.rows.map(mapAuditRow),
      page: q.page,
      pageSize: q.pageSize,
      total: total.rows[0]?.count ?? 0,
    };
  }

  async recent(limit: number): Promise<AuditLogEntry[]> {
    const rows = await this.pool.query<AuditRow>(
      `SELECT id, occurred_at, actor_user_id, actor_device_id, actor_label, action, entity_type, entity_id, details, ip_address, severity
         FROM audit_logs ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.rows.map(mapAuditRow);
  }

  async distinctActions(): Promise<string[]> {
    const rows = await this.pool.query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_logs ORDER BY action',
    );
    return rows.rows.map((r) => r.action);
  }
}
