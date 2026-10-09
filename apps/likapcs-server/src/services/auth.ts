import type { AuthenticatedUser, LoginResponse } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, unauthorized } from '../errors.js';
import {
  DUMMY_HASH_PROMISE,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../security/password.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { recordAudit } from './audit.js';
import type { SettingsService } from './settings.js';
import type { UsersService } from './users.js';

export interface AuthContext {
  sessionId: string;
  user: AuthenticatedUser;
  permissions: Set<string>;
}

interface LoginInput {
  username: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  clientApp?: string;
}

export class AuthService {
  constructor(
    private readonly pool: DbPool,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly sessionHours: number,
  ) {}

  async login(input: LoginInput): Promise<LoginResponse> {
    const maxFailed = await this.settings.get('security.max_failed_logins');
    const lockoutMinutes = await this.settings.get('security.lockout_minutes');

    const row = await this.pool.query<{
      id: string;
      password_hash: string;
      is_active: boolean;
      failed_login_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT id, password_hash, is_active, failed_login_attempts, locked_until
         FROM users WHERE lower(username) = lower($1)`,
      [input.username],
    );
    const user = row.rows[0];

    if (!user) {
      // Equalise response time so usernames cannot be enumerated by timing.
      await verifyPassword(input.password, await DUMMY_HASH_PROMISE);
      await this.auditFailure(null, input, 'unknown_user');
      throw unauthorized('Invalid username or password');
    }
    if (!user.is_active) {
      await this.auditFailure(user.id, input, 'inactive');
      throw unauthorized('Invalid username or password');
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await this.auditFailure(user.id, input, 'locked');
      throw new AppError(423, 'account_locked', 'Account is temporarily locked. Try again later.', {
        lockedUntil: user.locked_until.toISOString(),
      });
    }

    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      const attempts = user.failed_login_attempts + 1;
      const lock = attempts >= maxFailed;
      await this.pool.query(
        `UPDATE users SET failed_login_attempts = $2,
                locked_until = CASE WHEN $3::boolean THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1`,
        [user.id, lock ? 0 : attempts, lock, String(lockoutMinutes)],
      );
      await this.auditFailure(user.id, input, lock ? 'locked_now' : 'bad_password');
      throw unauthorized('Invalid username or password');
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.sessionHours * 3600 * 1000);
    const sessionId = await withTransaction(this.pool, async (client) => {
      if (needsRehash(user.password_hash)) {
        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          user.id,
          await hashPassword(input.password),
        ]);
      }
      await client.query(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
        [user.id],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO user_sessions (user_id, token_hash, client_app, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          user.id,
          hashToken(token),
          input.clientApp ?? 'admin',
          input.ip,
          input.userAgent,
          expiresAt,
        ],
      );
      await recordAudit(
        client,
        { userId: user.id, label: input.username, ip: input.ip },
        { action: 'auth.login', entityType: 'user', entityId: user.id },
      );
      return inserted.rows[0]!.id;
    });

    const summary = await this.users.getById(user.id);
    const permissions = await this.users.getPermissions(user.id);
    void sessionId;
    return { token, expiresAt: expiresAt.toISOString(), user: { ...summary, permissions } };
  }

  async logout(ctx: AuthContext, ip: string | null): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [ctx.sessionId],
      );
      await recordAudit(
        client,
        { userId: ctx.user.id, label: ctx.user.username, ip },
        { action: 'auth.logout', entityType: 'user', entityId: ctx.user.id },
      );
    });
  }

  /** Resolves a bearer token to an authenticated context, or null if invalid/expired/revoked. */
  async resolveToken(token: string): Promise<AuthContext | null> {
    if (!token || token.length < 16 || token.length > 512) return null;
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      last_used_at: Date | null;
    }>(
      `SELECT s.id, s.user_id, s.last_used_at
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
      [hashToken(token)],
    );
    const session = result.rows[0];
    if (!session) return null;
    const lastUsed = session.last_used_at?.getTime() ?? 0;
    if (Date.now() - lastUsed > 60_000) {
      await this.pool.query('UPDATE user_sessions SET last_used_at = now() WHERE id = $1', [
        session.id,
      ]);
    }
    const user = await this.users.getById(session.user_id);
    const permissions = await this.users.getPermissions(session.user_id);
    return {
      sessionId: session.id,
      user: { ...user, permissions },
      permissions: new Set(permissions),
    };
  }

  async revokeExpiredSessions(): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')",
    );
    return result.rowCount ?? 0;
  }

  private async auditFailure(
    userId: string | null,
    input: LoginInput,
    reason: string,
  ): Promise<void> {
    await recordAudit(
      this.pool,
      { userId, label: input.username, ip: input.ip },
      {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: userId,
        details: { reason },
        severity: reason === 'locked_now' ? 'critical' : 'warning',
      },
    );
  }
}
