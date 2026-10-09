import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  PUBLIC_SETTING_KEYS,
  validateSettingsPatch,
  type SettingKey,
  type SettingsMap,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { recordAudit, type AuditActor } from './audit.js';

export class SettingsService {
  private cache: SettingsMap | null = null;

  constructor(private readonly pool: DbPool) {}

  /** Inserts defaults for keys introduced after the initial migration (idempotent). */
  async ensureDefaults(): Promise<void> {
    const existing = await this.pool.query<{ key: string }>('SELECT key FROM settings');
    const have = new Set(existing.rows.map((r) => r.key));
    for (const key of SETTING_KEYS) {
      if (!have.has(key)) {
        await this.pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING',
          [key, JSON.stringify(SETTING_DEFAULTS[key])],
        );
      }
    }
    this.cache = null;
  }

  async getAll(db: Queryable = this.pool): Promise<SettingsMap> {
    if (this.cache && db === this.pool) return this.cache;
    const result = await db.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM settings',
    );
    const merged: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const row of result.rows) {
      if (row.key in SETTING_DEFAULTS) merged[row.key] = row.value;
    }
    const map = merged as SettingsMap;
    if (db === this.pool) this.cache = map;
    return map;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
    const all = await this.getAll();
    return all[key];
  }

  async getPublic(): Promise<Partial<SettingsMap>> {
    const all = await this.getAll();
    const out: Partial<SettingsMap> = {};
    for (const key of PUBLIC_SETTING_KEYS) (out as Record<string, unknown>)[key] = all[key];
    return out;
  }

  async update(patchInput: unknown, actor: AuditActor): Promise<SettingsMap> {
    const patch = validateSettingsPatch(patchInput);
    const keys = Object.keys(patch) as SettingKey[];
    if (keys.length === 0) return this.getAll();
    const before = await this.getAll();
    await withTransaction(this.pool, async (client) => {
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of keys) {
        const value = patch[key];
        if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
        await client.query(
          `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [key, JSON.stringify(value), actor.userId ?? null],
        );
        changed[key] = { from: before[key], to: value };
      }
      if (Object.keys(changed).length > 0) {
        await recordAudit(client, actor, {
          action: 'settings.update',
          entityType: 'settings',
          details: { changed },
        });
      }
    });
    this.cache = null;
    return this.getAll();
  }

  invalidate(): void {
    this.cache = null;
  }
}
