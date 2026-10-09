/**
 * Permission codes and system roles.
 *
 * The database (database/migrations/0001_core.sql) is the authoritative store of permissions
 * and role assignments; this file mirrors it for type-safe checks in the applications.
 * An integration test verifies both stay in sync.
 */

export const PERMISSIONS = {
  // Dashboard & reports
  DASHBOARD_VIEW: 'dashboard.view',
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  // Gaming stations
  STATIONS_VIEW: 'stations.view',
  STATIONS_MANAGE: 'stations.manage',
  STATIONS_CONTROL: 'stations.control',
  STATIONS_POWER: 'stations.power',
  DEVICES_MANAGE: 'devices.manage',
  PRICING_MANAGE: 'pricing.manage',

  // Point of sale
  POS_SELL: 'pos.sell',
  POS_DISCOUNT: 'pos.discount',
  POS_REFUND: 'pos.refund',
  POS_SUSPEND: 'pos.suspend',
  POS_REPRINT: 'pos.reprint',

  // Catalog & inventory
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_MANAGE: 'products.manage',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_COUNT: 'inventory.count',

  // Purchasing
  PURCHASES_VIEW: 'purchases.view',
  PURCHASES_MANAGE: 'purchases.manage',
  PURCHASES_PAY: 'purchases.pay',
  SUPPLIERS_MANAGE: 'suppliers.manage',

  // Customers
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_MANAGE: 'customers.manage',

  // Staff
  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',

  // Cash & finance
  CASH_VIEW: 'cash.view',
  CASH_OPEN_CLOSE: 'cash.open_close',
  CASH_MOVE: 'cash.move',
  EXPENSES_VIEW: 'expenses.view',
  EXPENSES_MANAGE: 'expenses.manage',

  // System
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
  BACKUPS_MANAGE: 'backups.manage',
  UPDATES_MANAGE: 'updates.manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_CODES: readonly PermissionCode[] = Object.values(PERMISSIONS);

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  CASHIER: 'cashier',
  INVENTORY: 'inventory',
  ACCOUNTANT: 'accountant',
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLE_CODES: readonly RoleCode[] = Object.values(ROLES);

/** Rank: lower number = more powerful. A user may only manage users of a strictly higher rank. */
export const ROLE_RANK: Record<RoleCode, number> = {
  owner: 0,
  admin: 10,
  manager: 20,
  cashier: 30,
  inventory: 30,
  accountant: 30,
};

export function hasPermission(
  granted: ReadonlySet<string> | readonly string[],
  required: PermissionCode | PermissionCode[],
): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  const list = Array.isArray(required) ? required : [required];
  return list.every((p) => set.has(p));
}
