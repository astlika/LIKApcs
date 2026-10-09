import type { Queryable } from '../db/pool.js';

export interface AuditActor {
  userId?: string | null;
  deviceId?: string | null;
  label?: string | null;
  ip?: string | null;
}

export interface AuditEntryInput {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  severity?: 'info' | 'warning' | 'critical';
}

/**
 * Appends an audit log row. Call it with the transaction client so the audit entry is committed
 * atomically with the change it describes.
 */
export async function recordAudit(
  db: Queryable,
  actor: AuditActor,
  entry: AuditEntryInput,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_device_id, actor_label, action, entity_type, entity_id, details, ip_address, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      actor.userId ?? null,
      actor.deviceId ?? null,
      actor.label ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.details ?? {}),
      actor.ip ?? null,
      entry.severity ?? 'info',
    ],
  );
}
