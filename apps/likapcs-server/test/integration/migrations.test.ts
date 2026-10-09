import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_CODES,
  ALL_ROLE_CODES,
  SETTING_DEFAULTS,
  SETTING_KEYS,
} from '@likapcs/shared';
import { getMigrationStatus, loadMigrationFiles, runMigrations } from '../../src/db/migrate.js';
import { createTestContext, type TestContext } from '../helpers.js';

const REQUIRED_TABLES = [
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
  'user_sessions',
  'audit_logs',
  'stations',
  'station_devices',
  'station_heartbeats',
  'station_connection_logs',
  'gaming_sessions',
  'session_events',
  'pricing_rules',
  'gaming_packages',
  'products',
  'product_barcodes',
  'categories',
  'suppliers',
  'tax_categories',
  'units_of_measure',
  'purchases',
  'purchase_items',
  'purchase_payments',
  'purchase_receipts',
  'purchase_receipt_items',
  'purchase_returns',
  'purchase_return_items',
  'inventory_movements',
  'stock_counts',
  'stock_count_items',
  'customers',
  'customer_ledger',
  'sales',
  'sale_items',
  'payments',
  'refunds',
  'refund_items',
  'expenses',
  'expense_categories',
  'cash_registers',
  'cash_shifts',
  'cash_movements',
  'invoices',
  'print_jobs',
  'document_sequences',
  'settings',
  'backup_history',
  'application_versions',
  'update_history',
  'schema_migrations',
];

describe('database migrations', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('applies every migration file exactly once and is idempotent', async () => {
    const files = await loadMigrationFiles(ctx.config.migrationsDir);
    const status = await getMigrationStatus(ctx.pool, ctx.config.migrationsDir);
    expect(status.pending).toHaveLength(0);
    expect(status.applied.map((a) => a.version)).toEqual(files.map((f) => f.version));
    const again = await runMigrations(ctx.pool, ctx.config.migrationsDir);
    expect(again.applied).toHaveLength(0);
    expect(again.currentVersion).toBe(files.at(-1)!.version);
  });

  it('creates all tables required by the specification', async () => {
    const result = await ctx.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const tables = new Set(result.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    expect(missing).toEqual([]);
  });

  it('detects tampering with an already-applied migration', async () => {
    await ctx.pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    await expect(getMigrationStatus(ctx.pool, ctx.config.migrationsDir)).rejects.toThrow(
      /checksum mismatch/,
    );
    const files = await loadMigrationFiles(ctx.config.migrationsDir);
    await ctx.pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 1', [
      files[0]!.checksum,
    ]);
  });

  it('keeps seeded permissions, roles and settings in sync with the shared package', async () => {
    const perms = await ctx.pool.query<{ code: string }>(
      'SELECT code FROM permissions ORDER BY code',
    );
    expect(perms.rows.map((r) => r.code)).toEqual([...ALL_PERMISSION_CODES].sort());

    const roles = await ctx.pool.query<{ code: string }>('SELECT code FROM roles ORDER BY code');
    expect(roles.rows.map((r) => r.code)).toEqual([...ALL_ROLE_CODES].sort());

    const settings = await ctx.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM settings',
    );
    const keys = settings.rows.map((r) => r.key).sort();
    expect(keys).toEqual([...SETTING_KEYS].sort());
    for (const row of settings.rows) {
      expect(row.value, row.key).toEqual(
        SETTING_DEFAULTS[row.key as keyof typeof SETTING_DEFAULTS],
      );
    }
  });

  it('owner and admin hold every permission; cashier cannot refund or manage users', async () => {
    const q = async (role: string) =>
      (
        await ctx.pool.query<{ permission_code: string }>(
          'SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1',
          [role],
        )
      ).rows.map((r) => r.permission_code);
    expect((await q('owner')).length).toBe(ALL_PERMISSION_CODES.length);
    expect((await q('admin')).length).toBe(ALL_PERMISSION_CODES.length);
    const cashier = await q('cashier');
    expect(cashier).toContain('pos.sell');
    expect(cashier).not.toContain('pos.refund');
    expect(cashier).not.toContain('users.manage');
    expect(cashier).not.toContain('inventory.adjust');
  });

  it('enforces one live session per station at the database level', async () => {
    const station = await ctx.pool.query<{ id: string }>(
      "INSERT INTO stations (number, code, name) VALUES (99, 'PC 99', 'Test') RETURNING id",
    );
    const id = station.rows[0]!.id;
    const insert = (status: string) =>
      ctx.pool.query(
        `INSERT INTO gaming_sessions (station_id, billing_mode, status, started_at, ends_at)
         VALUES ($1, 'prepaid', $2, now(), now() + interval '1 hour')`,
        [id, status],
      );
    await insert('active');
    await expect(insert('active')).rejects.toThrow(/gaming_sessions_one_live_per_station_idx/);
    await expect(insert('paused')).rejects.toThrow(/gaming_sessions_one_live_per_station_idx/);
    await insert('completed'); // historic rows are fine
    await ctx.pool.query('DELETE FROM gaming_sessions WHERE station_id = $1', [id]);
    await ctx.pool.query('DELETE FROM stations WHERE id = $1', [id]);
  });
});
