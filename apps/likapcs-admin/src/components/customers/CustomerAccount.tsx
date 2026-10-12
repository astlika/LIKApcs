/**
 * Customer account (0.11.0): the prepaid balance and the account statement.
 *
 *   TopUpDialog / WithdrawDialog   money in / out of the balance (cash through the drawer)
 *   StatementPanel                 every receipt (how it was paid, debt state), repayment,
 *                                  refund and balance move — newest first, filterable, paged;
 *                                  a receipt row opens the sale (reprint / refund from there)
 *   WalletLedgerPanel              the balance ledger with the running balance
 *   WalletPill                     the small green "balance" badge used next to customer names
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Gamepad2,
  Receipt as ReceiptIcon,
  RotateCcw,
  Wallet,
} from 'lucide-react';
import {
  PERMISSIONS,
  STATEMENT_FILTERS,
  formatDuration,
  parseMoneyInput,
  type CustomerStatement,
  type CustomerSummary,
  type Paginated,
  type StatementEntry,
  type StatementFilter,
  type WalletEntry,
  type WalletMutationResult,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { SaleDetailDialog } from '../../pages/SalesPage';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Pagination,
  Segmented,
} from '../ui/primitives';

const PAGE_SIZE = 25;

export function WalletPill({ cents, testId }: { cents: number; testId?: string }) {
  const fmt = useFormat();
  if (cents <= 0) return null;
  return (
    <span className="wallet-pill" data-testid={testId}>
      <Wallet size={11} /> {fmt.money(cents)}
    </span>
  );
}

/** Invalidates everything that shows a balance or a debt after a wallet move. */
function useAccountInvalidation(customerId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
    void queryClient.invalidateQueries({ queryKey: ['statement', customerId] });
    void queryClient.invalidateQueries({ queryKey: ['wallet', customerId] });
    void queryClient.invalidateQueries({ queryKey: ['cash'] });
  };
}

// ─── Top up ────────────────────────────────────────────────────────────────────

export function TopUpDialog({
  customer,
  onClose,
}: {
  customer: CustomerSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const invalidate = useAccountInvalidation(customer.id);
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [note, setNote] = useState('');
  const amountCents = amount.trim() ? parseMoneyInput(amount) : null;
  const tenderedCents = tendered.trim() ? parseMoneyInput(tendered) : null;
  const tenderedOk =
    tendered.trim() === '' ||
    (tenderedCents !== null && amountCents !== null && tenderedCents >= amountCents);
  const valid = amountCents !== null && amountCents > 0 && tenderedOk;
  const change =
    valid && tenderedCents !== null && amountCents !== null ? tenderedCents - amountCents : 0;
  const mutation = useMutation({
    mutationFn: () =>
      api<WalletMutationResult>(`/customers/${customer.id}/wallet/topup`, {
        method: 'POST',
        body: {
          amountCents,
          tenderedCents: tendered.trim() ? tenderedCents : undefined,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (r) => {
      toast.success(
        t('customers.topUpDone', {
          amount: fmt.money(r.entry.amountCents),
          balance: fmt.money(r.customer.walletBalanceCents),
        }) +
          (r.changeCents > 0
            ? ` ${t('customers.topUpChange', { amount: fmt.money(r.changeCents) })}`
            : ''),
      );
      invalidate();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'wallet_disabled')
        toast.error(t('customers.walletDisabled'));
      else toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const err = mutation.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('customers.topUpTitle', { name: customer.name })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="wallet-topup-submit"
          >
            <ArrowDownToLine size={14} /> {t('customers.topUp')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !mutation.isPending) mutation.mutate();
        }}
      >
        <div className="row row--between">
          <span className="muted">{t('customers.balance')}</span>
          <strong className="num">{fmt.money(customer.walletBalanceCents)}</strong>
        </div>
        <Field label={t('customers.topUpAmount')} error={fieldError(err, 'amountCents')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              inputMode="decimal"
              className="num"
              style={{ fontSize: 22, height: 48 }}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={amount.trim() !== '' && (amountCents === null || amountCents <= 0)}
              data-testid="wallet-topup-amount"
            />
          )}
        </Field>
        <Field
          label={t('customers.topUpTendered')}
          optional
          error={fieldError(err, 'tenderedCents')}
        >
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              className="num"
              placeholder={amountCents ? (amountCents / 100).toFixed(2) : '0.00'}
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              aria-invalid={!tenderedOk}
              data-testid="wallet-topup-tendered"
            />
          )}
        </Field>
        <Field label={t('customers.topUpNote')} optional>
          {(id) => (
            <Input id={id} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
        {change > 0 && (
          <div className="pos__change" data-testid="wallet-topup-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(change)}</strong>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ─── Pay out ───────────────────────────────────────────────────────────────────

export function WithdrawDialog({
  customer,
  onClose,
}: {
  customer: CustomerSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const invalidate = useAccountInvalidation(customer.id);
  const [amount, setAmount] = useState((customer.walletBalanceCents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const amountCents = amount.trim() ? parseMoneyInput(amount) : null;
  const valid =
    amountCents !== null &&
    amountCents > 0 &&
    amountCents <= customer.walletBalanceCents &&
    reason.trim().length >= 2;
  const mutation = useMutation({
    mutationFn: () =>
      api<WalletMutationResult>(`/customers/${customer.id}/wallet/withdraw`, {
        method: 'POST',
        body: { amountCents, reason: reason.trim() },
      }),
    onSuccess: (r) => {
      toast.success(
        t('customers.withdrawDone', {
          amount: fmt.money(-r.entry.amountCents),
          balance: fmt.money(r.customer.walletBalanceCents),
        }),
      );
      invalidate();
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('customers.withdrawTitle', { name: customer.name })}
      description={t('customers.withdrawHint')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={!valid}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="wallet-withdraw-submit"
          >
            <ArrowUpFromLine size={14} /> {t('customers.withdraw')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row--between">
          <span className="muted">{t('customers.balance')}</span>
          <strong className="num">{fmt.money(customer.walletBalanceCents)}</strong>
        </div>
        <Field label={t('customers.withdrawAmount')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              inputMode="decimal"
              className="num"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              aria-invalid={
                amountCents === null ||
                amountCents <= 0 ||
                amountCents > customer.walletBalanceCents
              }
              data-testid="wallet-withdraw-amount"
            />
          )}
        </Field>
        <Field label={t('customers.withdrawReason')}>
          {(id) => (
            <Input
              id={id}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              data-testid="wallet-withdraw-reason"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Statement ─────────────────────────────────────────────────────────────────

function PaidHow({ entry }: { entry: StatementEntry }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const parts: { key: string; label: string; cents: number }[] = [
    { key: 'cash', label: t('customers.statement.paidCash'), cents: entry.paid.cashCents },
    { key: 'wallet', label: t('customers.statement.paidWallet'), cents: entry.paid.walletCents },
    { key: 'credit', label: t('customers.statement.paidCredit'), cents: entry.paid.creditCents },
    { key: 'other', label: t('customers.statement.paidOther'), cents: entry.paid.otherCents },
  ].filter((p) => p.cents > 0);
  if (entry.kind === 'wallet_topup' || entry.kind === 'wallet_withdrawal' || !parts.length)
    return <span className="faint">—</span>;
  return (
    <div className="statement__paid">
      {parts.map((p) => (
        <span key={p.key}>
          <strong className="num">{fmt.money(p.cents)}</strong> {p.label}
        </span>
      ))}
    </div>
  );
}

function EntryState({ entry }: { entry: StatementEntry }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (entry.kind === 'sale') {
    const d = entry.debt;
    if (!d) return <Badge tone="success">{t('debts.status.paid')}</Badge>;
    if (d.status === 'open')
      return (
        <Badge tone="danger">
          {t('customers.statement.debtOpen', { date: fmt.date(d.dueDate) })}
        </Badge>
      );
    if (d.status === 'partial')
      return (
        <Badge tone="warning">
          {t('customers.statement.debtPartial', {
            amount: fmt.money(d.remainingCents),
            date: fmt.date(d.dueDate),
          })}
        </Badge>
      );
    if (d.status === 'written_off')
      return <Badge tone="default">{t('customers.statement.debtWrittenOff')}</Badge>;
    return (
      <Badge tone="success">
        {t('customers.statement.debtPaid', { date: fmt.date(d.settledAt ?? entry.at) })}
      </Badge>
    );
  }
  if (entry.kind === 'debt_payment') {
    const receipts = entry.settles.map((s) => s.receiptNo).filter(Boolean);
    return (
      <span className="muted">
        {receipts.length
          ? t('customers.statement.settles', { receipts: receipts.join(', ') })
          : t('customers.statement.settlesDebt')}
      </span>
    );
  }
  return <span className="faint">—</span>;
}

const KIND_ICON: Record<StatementEntry['kind'], JSX.Element> = {
  sale: <ReceiptIcon size={14} />,
  refund: <RotateCcw size={14} />,
  debt_payment: <Banknote size={14} />,
  wallet_topup: <ArrowDownToLine size={14} />,
  wallet_withdrawal: <ArrowUpFromLine size={14} />,
};

export function StatementPanel({ customer }: { customer: CustomerSummary }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const [filter, setFilter] = useState<StatementFilter>('all');
  const [page, setPage] = useState(1);
  const [openSale, setOpenSale] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['statement', customer.id, filter, page],
    queryFn: () =>
      api<CustomerStatement>(`/customers/${customer.id}/statement`, {
        query: { filter, page, pageSize: PAGE_SIZE },
      }),
    placeholderData: (prev) => prev,
  });
  const s = query.data;
  return (
    <div className="stack" data-testid="customer-statement">
      {s && (
        <div className="statement__totals" data-testid="statement-totals">
          <div>
            <span className="faint">{t('customers.statement.totals.spent')}</span>
            <strong>{fmt.money(s.totals.spentCents)}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('customers.statement.totals.receipts')}: {s.totals.receiptsCount}
            </span>
          </div>
          <div>
            <span className="faint">{t('customers.statement.totals.cash')}</span>
            <strong>{fmt.money(s.totals.paidCashCents)}</strong>
          </div>
          <div>
            <span className="faint">{t('customers.statement.totals.wallet')}</span>
            <strong>{fmt.money(s.totals.paidWalletCents)}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('customers.statement.totals.topUps')}: {fmt.money(s.totals.walletTopUpsCents)}
            </span>
          </div>
          <div>
            <span className="faint">{t('customers.statement.totals.credit')}</span>
            <strong>{fmt.money(s.totals.onCreditCents)}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('customers.statement.totals.debtPaid')}: {fmt.money(s.totals.debtPaidCents)}
            </span>
          </div>
          <div>
            <span className="faint">{t('customers.statement.totals.debtOpen')}</span>
            <strong className={s.totals.debtOpenCents > 0 ? 'text-danger' : ''}>
              {fmt.money(s.totals.debtOpenCents)}
            </strong>
          </div>
          <div>
            <span className="faint">{t('customers.statement.totals.play')}</span>
            <strong>{formatDuration(s.totals.playSeconds)}</strong>
            {s.totals.firstVisitAt && (
              <span className="muted" style={{ fontSize: 12 }}>
                {t('customers.statement.totals.since')}: {fmt.date(s.totals.firstVisitAt)}
              </span>
            )}
          </div>
        </div>
      )}
      <Segmented
        value={filter}
        options={STATEMENT_FILTERS.map((f) => ({
          value: f,
          label: t(`customers.statement.filter.${f}`),
        }))}
        onChange={(f) => {
          setFilter(f);
          setPage(1);
        }}
        testId="statement-filter"
      />
      {query.isLoading && <Loading />}
      {s && s.items.length === 0 && (
        <EmptyState icon={<ReceiptIcon size={22} />} title={t('customers.statement.empty')} />
      )}
      {s && s.items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact table--clickable">
            <thead>
              <tr>
                <th>{t('customers.statement.when')}</th>
                <th>{t('customers.statement.what')}</th>
                <th className="right">{t('customers.statement.amount')}</th>
                <th>{t('customers.statement.paidHow')}</th>
                <th>{t('customers.statement.state')}</th>
                <th>{t('customers.statement.by')}</th>
              </tr>
            </thead>
            <tbody>
              {s.items.map((e) => {
                const clickable = !!e.saleId;
                return (
                  <tr
                    key={e.key}
                    data-testid="statement-row"
                    data-kind={e.kind}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={() => clickable && setOpenSale(e.saleId)}
                    onKeyDown={(ev) => ev.key === 'Enter' && clickable && setOpenSale(e.saleId)}
                    title={clickable ? t('customers.statement.receipt') : undefined}
                    style={clickable ? undefined : { cursor: 'default' }}
                  >
                    <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                      {fmt.dateTime(e.at)}
                    </td>
                    <td>
                      <div className="statement__kind">
                        {e.stationCode ? <Gamepad2 size={14} /> : KIND_ICON[e.kind]}
                        <strong>{t(`customers.statement.kind.${e.kind}`)}</strong>
                        {e.receiptNo && <span className="mono muted">{e.receiptNo}</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {e.stationCode && e.durationSeconds !== null
                          ? `${t('customers.statement.session', {
                              station: e.stationCode,
                              duration: formatDuration(e.durationSeconds),
                            })}${e.description ? ` · ${e.description}` : ''}`
                          : e.description || e.note || ''}
                      </div>
                    </td>
                    <td className="right num">
                      <strong
                        className={
                          e.kind === 'refund' || e.kind === 'wallet_withdrawal'
                            ? 'text-danger'
                            : e.kind === 'wallet_topup' || e.kind === 'debt_payment'
                              ? 'text-success'
                              : ''
                        }
                      >
                        {e.kind === 'refund' || e.kind === 'wallet_withdrawal' ? '−' : ''}
                        {fmt.money(e.amountCents)}
                      </strong>
                    </td>
                    <td>
                      <PaidHow entry={e} />
                    </td>
                    <td>
                      <EntryState entry={e} />
                    </td>
                    <td className="muted">{e.createdByName ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={s.total} onPage={setPage} />
        </div>
      )}
      {openSale && (
        <SaleDetailDialog
          saleId={openSale}
          onClose={() => setOpenSale(null)}
          canRefund={can(PERMISSIONS.POS_REFUND)}
          canReprint={can(PERMISSIONS.POS_REPRINT)}
          canInvoice={can(PERMISSIONS.INVOICES_MANAGE)}
          canViewInvoice={can(PERMISSIONS.INVOICES_VIEW)}
          onResume={() => setOpenSale(null)}
        />
      )}
    </div>
  );
}

// ─── Wallet ledger ─────────────────────────────────────────────────────────────

export function WalletLedgerPanel({ customer }: { customer: CustomerSummary }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['wallet', customer.id, page],
    queryFn: () =>
      api<Paginated<WalletEntry>>(`/customers/${customer.id}/wallet`, {
        query: { page, pageSize: PAGE_SIZE },
      }),
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  return (
    <div className="stack" data-testid="customer-wallet">
      <div className="row row--between">
        <span className="muted">{t('customers.wallet.subtitle')}</span>
        <strong className="num" style={{ fontSize: 18 }} data-testid="wallet-balance">
          {fmt.money(customer.walletBalanceCents)}
        </strong>
      </div>
      {query.isLoading && <Loading />}
      {data && data.items.length === 0 && (
        <EmptyState icon={<Wallet size={22} />} title={t('customers.wallet.empty')} />
      )}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('customers.statement.when')}</th>
                <th>{t('customers.statement.what')}</th>
                <th className="right">{t('customers.statement.amount')}</th>
                <th className="right">{t('customers.wallet.after')}</th>
                <th>{t('customers.statement.by')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id} data-testid="wallet-row" data-type={e.type}>
                  <td className="num muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmt.dateTime(e.createdAt)}
                  </td>
                  <td>
                    <strong>{t(`customers.wallet.type.${e.type}`)}</strong>
                    {e.receiptNo && <span className="mono muted"> {e.receiptNo}</span>}
                    {e.note && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {e.note}
                      </div>
                    )}
                  </td>
                  <td className={`right num ${e.amountCents < 0 ? 'text-danger' : 'text-success'}`}>
                    {e.amountCents > 0 ? '+' : ''}
                    {fmt.money(e.amountCents)}
                  </td>
                  <td className="right num">{fmt.money(e.balanceAfterCents)}</td>
                  <td className="muted">{e.createdByName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </div>
      )}
      {!query.isLoading && query.isError && (
        <Alert tone="danger">
          {query.error instanceof ApiError ? query.error.message : t('common.errorGeneric')}
        </Alert>
      )}
    </div>
  );
}
