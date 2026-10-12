/**
 * Customer wallet ("balanca", 0.11.0): money a regular pays in advance, kept on their name and
 * spent on PC time, drinks / snacks and debts. Rules:
 *
 * * The balance is `customers.wallet_balance_cents` (CHECK ≥ 0) and every change is one row in
 *   `customer_ledger` with the balance after it — the statement reads like a bank statement.
 * * Money in / out is real cash: a top-up records a `payments` row (kind `wallet_topup`) and a
 *   drawer movement in the open shift; paying a balance back out mirrors that (`wallet_refund`).
 *   Spending the balance moves no cash at all — the sale's `payments` row with method `wallet`
 *   says how the receipt was settled.
 * * `spend` runs inside the caller's transaction (POS sale, session bill, order, debt repayment)
 *   with the customer row locked, so two PCs cannot spend the same euro twice.
 * * A PC that is playing on the customer's account is told about every change
 *   (`server.customer`) once the transaction has committed.
 */
import {
  PERMISSIONS,
  WALLET_ERROR_CODES,
  type ClientCustomerInfo,
  type CustomerSummary,
  type WalletEntry,
  type WalletEntryType,
  type WalletMutationResult,
  type WalletTopUpRequest,
  type WalletWithdrawRequest,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { afterCommit, withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { CashService } from './cash.js';
import { CUSTOMER_SELECT, toCustomerSummary, type CustomerRow } from './customers.js';
import type { SettingsService } from './settings.js';

export interface WalletActor extends AuditActor {
  permissions: Set<string>;
}

interface LedgerRow {
  id: string;
  entry_type: WalletEntryType;
  amount_cents: number;
  balance_after_cents: number | null;
  reference_type: string | null;
  reference_id: string | null;
  receipt_no: string | null;
  note: string | null;
  created_by_name: string | null;
  created_at: Date;
}

const LEDGER_SELECT = `
  SELECT l.id::text, l.entry_type, l.amount_cents, l.balance_after_cents, l.reference_type, l.reference_id, l.note,
         u.full_name AS created_by_name, l.created_at,
         CASE WHEN l.reference_type = 'sale' THEN (SELECT s.receipt_no FROM sales s WHERE s.id::text = l.reference_id)
              WHEN l.reference_type = 'refund' THEN (SELECT r.refund_no FROM refunds r WHERE r.id::text = l.reference_id)
              ELSE NULL END AS receipt_no
    FROM customer_ledger l
    LEFT JOIN users u ON u.id = l.created_by`;

function toEntry(r: LedgerRow): WalletEntry {
  const ref = r.reference_type;
  return {
    id: r.id,
    type: r.entry_type,
    amountCents: Number(r.amount_cents),
    balanceAfterCents: Number(r.balance_after_cents ?? 0),
    referenceType:
      ref === 'sale' || ref === 'debt_payment' || ref === 'refund' || ref === 'payment'
        ? ref
        : null,
    referenceId: r.reference_id,
    receiptNo: r.receipt_no,
    note: r.note,
    createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  };
}

export class WalletService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly cash: CashService,
    private readonly hub: RealtimeHub,
  ) {}

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async entries(
    customerId: string,
    query: { page: number; pageSize: number },
    db: Queryable = this.pool,
  ): Promise<{ items: WalletEntry[]; total: number }> {
    const [rows, count] = await Promise.all([
      db.query<LedgerRow>(
        `${LEDGER_SELECT} WHERE l.customer_id = $1 AND l.entry_type LIKE 'wallet_%'
          ORDER BY l.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`,
        [customerId, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM customer_ledger WHERE customer_id = $1 AND entry_type LIKE 'wallet_%'`,
        [customerId],
      ),
    ]);
    return { items: rows.rows.map(toEntry), total: Number(count.rows[0]?.n ?? 0) };
  }

  /** What a PC may show about a customer: name, balance, debt. Null when unknown. */
  async clientInfo(
    customerId: string,
    db: Queryable = this.pool,
  ): Promise<ClientCustomerInfo | null> {
    const r = await db.query<{
      id: string;
      name: string;
      code: string;
      wallet_balance_cents: number;
      balance_due_cents: number;
    }>(
      'SELECT id, name, code, wallet_balance_cents, balance_due_cents FROM customers WHERE id = $1',
      [customerId],
    );
    const c = r.rows[0];
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      code: c.code,
      walletBalanceCents: Number(c.wallet_balance_cents),
      balanceDueCents: Number(c.balance_due_cents),
    };
  }

  async isEnabled(): Promise<boolean> {
    return this.settings.get('wallet.enabled');
  }

  // ─── Money in / out at the desk ─────────────────────────────────────────────

  /** Cash in → balance up. Needs `wallet.topup`; the cash goes into the open shift's drawer. */
  async topUp(
    customerId: string,
    input: WalletTopUpRequest,
    actor: WalletActor,
  ): Promise<WalletMutationResult> {
    if (!actor.permissions.has(PERMISSIONS.WALLET_TOPUP))
      throw forbidden('Missing permission: wallet.topup');
    await this.assertEnabled();
    if (input.tenderedCents !== undefined && input.tenderedCents < input.amountCents)
      throw badRequest('Cash received is less than the amount paid in', {
        field: 'tenderedCents',
        code: 'PAYMENT',
      });
    const change = input.tenderedCents === undefined ? 0 : input.tenderedCents - input.amountCents;
    return withTransaction(this.pool, async (client) => {
      const customer = await this.lockCustomer(client, customerId);
      const shiftId = await this.cash.attachTender(client, {
        method: 'cash',
        amountCents: input.amountCents,
        type: 'wallet_topup',
        referenceType: 'customer',
        referenceId: customerId,
        reason: `${customer.name} · top-up`,
        actorUserId: actor.userId ?? null,
      });
      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments (kind, method, amount_cents, customer_id, shift_id, received_at, created_by)
         VALUES ('wallet_topup', 'cash', $1, $2, $3, now(), $4) RETURNING id`,
        [input.amountCents, customerId, shiftId, actor.userId ?? null],
      );
      const entry = await this.apply(client, {
        customerId,
        type: 'wallet_topup',
        amountCents: input.amountCents,
        referenceType: 'payment',
        referenceId: payment.rows[0]!.id,
        note: input.note ?? null,
        actor,
      });
      await recordAudit(client, actor, {
        action: 'wallet.topup',
        entityType: 'customer',
        entityId: customerId,
        details: { amountCents: input.amountCents, balanceAfterCents: entry.balanceAfterCents },
      });
      return { customer: await this.summary(client, customerId), entry, changeCents: change };
    });
  }

  /** Balance down → cash out of the drawer. Needs `wallet.refund` (a correction / goodbye path). */
  async withdraw(
    customerId: string,
    input: WalletWithdrawRequest,
    actor: WalletActor,
  ): Promise<WalletMutationResult> {
    if (!actor.permissions.has(PERMISSIONS.WALLET_REFUND))
      throw forbidden('Missing permission: wallet.refund');
    return withTransaction(this.pool, async (client) => {
      const customer = await this.lockCustomer(client, customerId, { allowInactive: true });
      if (customer.walletBalanceCents < input.amountCents) throw this.insufficient(customer);
      const shiftId = await this.cash.attachTender(client, {
        method: 'cash',
        amountCents: -input.amountCents,
        type: 'wallet_refund',
        referenceType: 'customer',
        referenceId: customerId,
        reason: `${customer.name} · ${input.reason}`,
        actorUserId: actor.userId ?? null,
      });
      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments (kind, method, amount_cents, customer_id, shift_id, received_at, created_by)
         VALUES ('wallet_refund', 'cash', $1, $2, $3, now(), $4) RETURNING id`,
        [input.amountCents, customerId, shiftId, actor.userId ?? null],
      );
      const entry = await this.apply(client, {
        customerId,
        type: 'wallet_withdrawal',
        amountCents: -input.amountCents,
        referenceType: 'payment',
        referenceId: payment.rows[0]!.id,
        note: input.reason,
        actor,
      });
      await recordAudit(client, actor, {
        action: 'wallet.withdrawn',
        entityType: 'customer',
        entityId: customerId,
        details: {
          amountCents: input.amountCents,
          balanceAfterCents: entry.balanceAfterCents,
          reason: input.reason,
        },
        severity: 'warning',
      });
      return { customer: await this.summary(client, customerId), entry, changeCents: 0 };
    });
  }

  // ─── Hooks used inside sale / debt transactions ─────────────────────────────

  /**
   * Pays `amountCents` from the customer's balance. Caller's transaction; the customer row is
   * locked for the rest of it. 409 `wallet_insufficient` (with the balance) when short.
   */
  async spend(
    client: DbClient,
    input: {
      customerId: string | null | undefined;
      amountCents: number;
      referenceType: 'sale' | 'debt_payment';
      referenceId: string;
      note?: string | null;
      actor: AuditActor;
    },
  ): Promise<WalletEntry> {
    if (!input.customerId)
      throw new AppError(
        400,
        WALLET_ERROR_CODES.NEEDS_CUSTOMER,
        'Paying from a balance needs a customer on the sale',
      );
    await this.assertEnabled();
    const customer = await this.lockCustomer(client, input.customerId);
    if (customer.walletBalanceCents < input.amountCents) throw this.insufficient(customer);
    return this.apply(client, {
      customerId: input.customerId,
      type: 'wallet_payment',
      amountCents: -input.amountCents,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note ?? null,
      actor: input.actor,
    });
  }

  /** A refunded sale handed back to the balance (refund method `wallet`). Caller's transaction. */
  async creditBack(
    client: DbClient,
    input: {
      customerId: string | null | undefined;
      amountCents: number;
      refundId: string;
      note?: string | null;
      actor: AuditActor;
    },
  ): Promise<WalletEntry> {
    if (!input.customerId)
      throw new AppError(
        400,
        WALLET_ERROR_CODES.NEEDS_CUSTOMER,
        'Refunding to a balance needs a customer on the sale',
      );
    await this.lockCustomer(client, input.customerId, { allowInactive: true });
    return this.apply(client, {
      customerId: input.customerId,
      type: 'wallet_refund',
      amountCents: input.amountCents,
      referenceType: 'refund',
      referenceId: input.refundId,
      note: input.note ?? null,
      actor: input.actor,
    });
  }

  // ─── PC notifications ───────────────────────────────────────────────────────

  /**
   * Tells every PC whose running session belongs to this customer that the account changed.
   * Safe to call from inside a transaction: it is deferred until the commit.
   */
  announce(client: DbClient | null, customerId: string): void {
    const run = () => this.pushCustomer(customerId);
    if (client) afterCommit(client, run);
    else void run().catch(() => undefined);
  }

  private async pushCustomer(customerId: string): Promise<void> {
    const online = this.hub.listDevices();
    if (!online.length) return;
    const live = await this.pool.query<{ station_id: string }>(
      `SELECT station_id FROM gaming_sessions WHERE customer_id = $1 AND status IN ('active', 'paused')`,
      [customerId],
    );
    if (!live.rows.length) return;
    const info = await this.clientInfo(customerId);
    const stations = new Set(live.rows.map((r) => r.station_id));
    const message = JSON.stringify({ type: 'server.customer', customer: info });
    for (const presence of online) {
      if (!stations.has(presence.stationId)) continue;
      if (presence.socket.readyState === presence.socket.OPEN) presence.socket.send(message);
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled()))
      throw new AppError(403, WALLET_ERROR_CODES.DISABLED, 'The customer balance is switched off');
  }

  private insufficient(customer: CustomerSummary): AppError {
    return new AppError(
      409,
      WALLET_ERROR_CODES.INSUFFICIENT,
      `${customer.name} has only ${(customer.walletBalanceCents / 100).toFixed(2)} on the balance`,
      { balanceCents: customer.walletBalanceCents, customerId: customer.id },
    );
  }

  private async lockCustomer(
    client: DbClient,
    customerId: string,
    options: { allowInactive?: boolean } = {},
  ): Promise<CustomerSummary> {
    const r = await client.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.id = $1 FOR UPDATE`, [
      customerId,
    ]);
    if (!r.rows[0]) throw notFound('Customer');
    const customer = toCustomerSummary(r.rows[0]);
    if (!options.allowInactive && customer.status !== 'active')
      throw conflict(`Customer is ${customer.status}`);
    return customer;
  }

  private async summary(client: DbClient, customerId: string): Promise<CustomerSummary> {
    const r = await client.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.id = $1`, [customerId]);
    return toCustomerSummary(r.rows[0]!);
  }

  /** Moves the balance and writes the ledger row; the customer row must already be locked. */
  private async apply(
    client: DbClient,
    input: {
      customerId: string;
      type: WalletEntryType;
      amountCents: number;
      referenceType: 'sale' | 'debt_payment' | 'refund' | 'payment';
      referenceId: string;
      note: string | null;
      actor: AuditActor;
    },
  ): Promise<WalletEntry> {
    const updated = await client.query<{ wallet_balance_cents: number }>(
      `UPDATE customers SET wallet_balance_cents = wallet_balance_cents + $2, updated_at = now()
        WHERE id = $1 RETURNING wallet_balance_cents`,
      [input.customerId, input.amountCents],
    );
    const balanceAfter = Number(updated.rows[0]!.wallet_balance_cents);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO customer_ledger (customer_id, entry_type, amount_cents, balance_after_cents, reference_type, reference_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
      [
        input.customerId,
        input.type,
        input.amountCents,
        balanceAfter,
        input.referenceType,
        input.referenceId,
        input.note,
        input.actor.userId ?? null,
      ],
    );
    this.announce(client, input.customerId);
    const row = await client.query<LedgerRow>(`${LEDGER_SELECT} WHERE l.id = $1`, [
      inserted.rows[0]!.id,
    ]);
    return toEntry(row.rows[0]!);
  }
}
