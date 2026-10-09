import {
  ROLES,
  ROLE_RANK,
  type CreateUserRequest,
  type Paginated,
  type RoleSummary,
  type UpdateUserRequest,
  type UserSummary,
  type RoleCode,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { recordAudit, type AuditActor } from './audit.js';

interface UserRow {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  roles: string[];
}

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.must_change_password,
         u.last_login_at, u.created_at, u.updated_at,
         COALESCE(array_agg(r.code ORDER BY r.rank, r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id`;

function mapUser(row: UserRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    roles: row.roles,
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The "power" of a user = the lowest rank among their roles (owner = 0). */
export function bestRank(roles: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const code of roles) {
    const rank = ROLE_RANK[code as RoleCode];
    if (rank !== undefined && rank < best) best = rank;
  }
  return best;
}

/**
 * Authorisation rule for staff management: an actor may only manage users whose power is strictly
 * lower than their own — except owners, who may also manage other owners.
 */
export function assertCanManageRoles(
  actorRoles: readonly string[],
  targetRoles: readonly string[],
): void {
  const actorRank = bestRank(actorRoles);
  const targetRank = bestRank(targetRoles);
  const actorIsOwner = actorRoles.includes(ROLES.OWNER);
  if (targetRank < actorRank || (targetRank === actorRank && !actorIsOwner)) {
    throw forbidden('You cannot manage a user with equal or higher privileges than your own');
  }
}

export class UsersService {
  constructor(private readonly pool: DbPool) {}

  async count(db: Queryable = this.pool): Promise<number> {
    const result = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users');
    return result.rows[0]?.count ?? 0;
  }

  async list(options: {
    page: number;
    pageSize: number;
    search?: string;
    includeInactive?: boolean;
  }): Promise<Paginated<UserSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeInactive) where.push('u.is_active = true');
    if (options.search) {
      params.push(`%${options.search.toLowerCase()}%`);
      where.push(
        `(lower(u.username) LIKE $${params.length} OR lower(u.full_name) LIKE $${params.length})`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM users u ${whereSql}`,
      params,
    );
    const offset = (options.page - 1) * options.pageSize;
    const rows = await this.pool.query<UserRow>(
      `${USER_SELECT} ${whereSql}
       GROUP BY u.id ORDER BY u.is_active DESC, lower(u.full_name)
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.pageSize, offset],
    );
    return {
      items: rows.rows.map(mapUser),
      page: options.page,
      pageSize: options.pageSize,
      total: total.rows[0]?.count ?? 0,
    };
  }

  async getById(id: string, db: Queryable = this.pool): Promise<UserSummary> {
    const result = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
    const row = result.rows[0];
    if (!row) throw notFound('User');
    return mapUser(row);
  }

  async getPermissions(userId: string, db: Queryable = this.pool): Promise<string[]> {
    const result = await db.query<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code
         FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 ORDER BY rp.permission_code`,
      [userId],
    );
    return result.rows.map((r) => r.permission_code);
  }

  async listRoles(): Promise<RoleSummary[]> {
    const result = await this.pool.query<{
      id: string;
      code: string;
      name: string;
      description: string | null;
      is_system: boolean;
      rank: number;
      permissions: string[];
    }>(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.rank,
              COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY r.rank, r.code`,
    );
    return result.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      rank: r.rank,
      permissions: r.permissions,
    }));
  }

  /** Creates a user. `actorRoles` = null means "system bootstrap" (first owner during setup). */
  async create(
    input: CreateUserRequest,
    actor: AuditActor & { roles: readonly string[] | null },
    db?: Queryable,
  ): Promise<UserSummary> {
    if (actor.roles) assertCanManageRoles(actor.roles, input.roles);
    const run = async (client: Queryable): Promise<UserSummary> => {
      const existing = await client.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [
        input.username,
      ]);
      if (existing.rowCount) throw conflict('Username is already taken', { field: 'username' });
      const passwordHash = await hashPassword(input.password);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (username, full_name, password_hash, email, phone, must_change_password, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.username,
          input.fullName,
          passwordHash,
          input.email ?? null,
          input.phone ?? null,
          input.mustChangePassword,
          actor.userId ?? null,
        ],
      );
      const userId = inserted.rows[0]!.id;
      await this.setRoles(client, userId, input.roles, actor.userId ?? null);
      await recordAudit(client, actor, {
        action: 'user.create',
        entityType: 'user',
        entityId: userId,
        details: { username: input.username, roles: input.roles },
      });
      return this.getById(userId, client);
    };
    return db ? run(db) : withTransaction(this.pool, run);
  }

  async update(
    id: string,
    patch: UpdateUserRequest,
    actor: AuditActor & { roles: readonly string[] },
  ): Promise<UserSummary> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.getById(id, client);
      const isSelf = actor.userId === id;
      if (!isSelf) assertCanManageRoles(actor.roles, current.roles);
      if (patch.roles) {
        if (isSelf) throw forbidden('You cannot change your own roles');
        assertCanManageRoles(actor.roles, patch.roles);
      }
      if (patch.isActive === false && isSelf)
        throw forbidden('You cannot deactivate your own account');

      // Never leave the system without an active owner.
      const removesOwner =
        current.roles.includes(ROLES.OWNER) &&
        ((patch.roles && !patch.roles.includes(ROLES.OWNER)) || patch.isActive === false);
      if (removesOwner) {
        const owners = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM users u
             JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
            WHERE r.code = 'owner' AND u.is_active AND u.id <> $1`,
          [id],
        );
        if ((owners.rows[0]?.count ?? 0) === 0)
          throw conflict('At least one active owner must remain');
      }

      await client.query(
        `UPDATE users SET
           full_name = COALESCE($2, full_name),
           email = CASE WHEN $3::boolean THEN $4 ELSE email END,
           phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
           is_active = COALESCE($7, is_active)
         WHERE id = $1`,
        [
          id,
          patch.fullName ?? null,
          patch.email !== undefined,
          patch.email ?? null,
          patch.phone !== undefined,
          patch.phone ?? null,
          patch.isActive ?? null,
        ],
      );
      if (patch.roles) await this.setRoles(client, id, patch.roles, actor.userId ?? null);
      if (patch.isActive === false) {
        await client.query(
          'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [id],
        );
      }
      await recordAudit(client, actor, {
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        details: { changes: patch },
        severity: patch.isActive === false || patch.roles ? 'warning' : 'info',
      });
      return this.getById(id, client);
    });
  }

  async resetPassword(
    id: string,
    newPassword: string,
    mustChangePassword: boolean,
    actor: AuditActor & { roles: readonly string[] },
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const target = await this.getById(id, client);
      if (actor.userId !== id) assertCanManageRoles(actor.roles, target.roles);
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = $3, failed_login_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [id, passwordHash, mustChangePassword],
      );
      await client.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id],
      );
      await recordAudit(client, actor, {
        action: 'user.password_reset',
        entityType: 'user',
        entityId: id,
        severity: 'warning',
      });
    });
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
    actor: AuditActor,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const row = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const hash = row.rows[0]?.password_hash;
      if (!hash) throw notFound('User');
      if (!(await verifyPassword(currentPassword, hash))) {
        throw badRequest('Current password is incorrect', { field: 'currentPassword' });
      }
      if (currentPassword === newPassword) {
        throw badRequest('New password must be different from the current password', {
          field: 'newPassword',
        });
      }
      await client.query(
        'UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1',
        [userId, await hashPassword(newPassword)],
      );
      await client.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
        [userId, keepSessionId],
      );
      await recordAudit(client, actor, {
        action: 'user.password_change',
        entityType: 'user',
        entityId: userId,
      });
    });
  }

  private async setRoles(
    client: Queryable,
    userId: string,
    roles: readonly string[],
    assignedBy: string | null,
  ) {
    const roleRows = await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM roles WHERE code = ANY($1)',
      [roles],
    );
    if (roleRows.rowCount !== new Set(roles).size)
      throw badRequest('Unknown role code', { field: 'roles' });
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (const role of roleRows.rows) {
      await client.query(
        'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)',
        [userId, role.id, assignedBy],
      );
    }
  }
}
