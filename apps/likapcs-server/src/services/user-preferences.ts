import { userPreferencesSchema, type UserPreferences, type UserPreferencesPatch } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';

/** Display preferences saved on the account (the same username gets the same settings everywhere). */
export class UserPreferencesService {
  constructor(private readonly pool: DbPool) {}

  async get(userId: string): Promise<UserPreferences> {
    const result = await this.pool.query<{ data: unknown }>(
      'SELECT data FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return userPreferencesSchema.parse(result.rows[0]?.data ?? {});
  }

  async update(userId: string, patch: UserPreferencesPatch): Promise<UserPreferences> {
    const current = await this.get(userId);
    const next = userPreferencesSchema.parse({ ...current, ...patch });
    await this.pool.query(
      `INSERT INTO user_preferences (user_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [userId, JSON.stringify(next)],
    );
    return next;
  }
}
