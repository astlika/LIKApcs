/**
 * Debts — the "pay later" ledger. Who owes what, since when and until when; overdue first.
 *
 * Collecting money is a cash-drawer operation (`pos.sell`): the pay dialog takes the amount
 * (the remainder by default, or any part of it), the method, the cash handed over for the change,
 * and posts `POST /debts/:id/pay`. "Pay everything" for a customer posts
 * `POST /customers/:id/debts/pay` and the server settles the oldest debts first.
 * A new due date needs `customers.manage`; forgiving a debt needs `debts.write_off` and a reason.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  CheckCircle2,
  HandCoins,
  Receipt as ReceiptIcon,
  Users,
} from 'lucide-react';
import {
  DEBT_LIST_FILTERS,
  PERMISSIONS,
  parseMoneyInput,
  type DebtDetail,
  type DebtPaymentResult,
  type DebtSummary,
  type DebtsOverview,
  type Paginated,
  type CustomerSummary,
  type DebtPaymentRequest,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { usePaymentMethods } from '../lib/payment-methods';
import { suggestTenders } from '../lib/tender';
import { useI18n } from '../i18n';
import { useAppSettings } from '../state/app-settings';
import { useAuth } from '../state/auth';
import { useShiftGuard } from '../state/shift-guard';
import { useToast } from '../state/toast';
import { dueDateFromToday } from '../components/payments/TenderPanel';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Kbd,
  Loading,
  PageHeader,
  Pagination,
  Select,
  StatTile,
  Textarea,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;
type Filter = (typeof DEBT_LIST_FILTERS)[number];

function StatusBadge({ debt }: { debt: DebtSummary }) {
  const { t } = useI18n();
  if (debt.status === 'paid') return <Badge tone="success">{t('debts.status.paid')}</Badge>;
  if (debt.status === 'written_off') return <Badge>{t('debts.status.written_off')}</Badge>;
  if (debt.overdueDays > 0)
    return <Badge tone="danger">{t('debts.overdueDays', { n: debt.overdueDays })}</Badge>;
  if (debt.status === 'partial') return <Badge tone="warning">{t('debts.status.partial')}</Badge>;
  return <Badge tone="info">{t('debts.status.open')}</Badge>;
}

export function DebtsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canCollect = can(PERMISSIONS.POS_SELL);
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customer') ?? undefined;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>(customerId ? 'all' : 'open');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ debt: DebtSummary; all: boolean } | null>(null);

  const query = useMemo(
    () => ({ q: q.trim() || undefined, filter, customerId, page, pageSize: PAGE_SIZE }),
    [q, filter, customerId, page],
  );
  const list = useQuery({
    queryKey: ['debts', 'list', query],
    queryFn: () => api<Paginated<DebtSummary>>('/debts', { query }),
    placeholderData: (prev) => prev,
  });
  const overview = useQuery({
    queryKey: ['debts', 'overview'],
    queryFn: () => api<DebtsOverview>('/debts/overview'),
  });
  const ov = overview.data;
  const customerName = customerId
    ? (list.data?.items.find((d) => d.customerId === customerId)?.customerName ?? null)
    : null;

  return (
    <>
      <PageHeader title={t('debts.title')} subtitle={t('debts.subtitle')} />
      {!can(PERMISSIONS.DEBTS_GIVE) && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="info">{t('debts.disabledHint')}</Alert>
        </div>
      )}
      <div className="grid grid--stats" style={{ marginBottom: 14 }}>
        <StatTile
          label={t('debts.openTotal')}
          value={fmt.money(ov?.openCents ?? 0)}
          sub={t('debts.openCount', { n: ov?.openCount ?? 0 })}
          icon={<HandCoins size={18} />}
          tone="accent"
          onClick={() => {
            setFilter('open');
            setPage(1);
          }}
        />
        <StatTile
          label={t('debts.filter.overdue')}
          value={fmt.money(ov?.overdueCents ?? 0)}
          sub={t('debts.openCount', { n: ov?.overdueCount ?? 0 })}
          icon={<AlertTriangle size={18} />}
          tone={(ov?.overdueCount ?? 0) > 0 ? 'danger' : undefined}
          onClick={() => {
            setFilter('overdue');
            setPage(1);
          }}
        />
        <StatTile
          label={t('debts.filter.due_today')}
          value={fmt.money(ov?.dueTodayCents ?? 0)}
          icon={<CalendarClock size={18} />}
          tone={(ov?.dueTodayCents ?? 0) > 0 ? 'warning' : undefined}
          onClick={() => {
            setFilter('due_today');
            setPage(1);
          }}
        />
        <StatTile
          label={t('debts.debtors')}
          value={String(ov?.debtors ?? 0)}
          icon={<Users size={18} />}
        />
      </div>
      <div className="toolbar">
        <Input
          placeholder={t('debts.search')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 300 }}
          aria-label={t('debts.search')}
          autoFocus
        />
        <Select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as Filter);
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          {DEBT_LIST_FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`debts.filter.${f}` as 'debts.filter.open')}
            </option>
          ))}
        </Select>
        {customerId && (
          <Badge tone="accent">
            {customerName ?? t('debts.oneCustomer')}
            <button
              type="button"
              className="chip__x"
              aria-label={t('common.close')}
              onClick={() => {
                params.delete('customer');
                setParams(params, { replace: true });
                setFilter('open');
                setPage(1);
              }}
            >
              ×
            </button>
          </Badge>
        )}
      </div>
      {list.isLoading && <Loading />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 size={22} />}
          title={
            filter === 'open' || filter === 'overdue' ? t('debts.emptyOpen') : t('debts.empty')
          }
        />
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table table--clickable" data-testid="debts-table">
            <thead>
              <tr>
                <th>{t('pos.customer')}</th>
                <th>{t('debts.receipt')}</th>
                <th>{t('common.date')}</th>
                <th>{t('debts.due')}</th>
                <th className="right">{t('debts.amount')}</th>
                <th className="right">{t('debts.paid')}</th>
                <th className="right">{t('debts.remaining')}</th>
                <th>{t('common.status')}</th>
                {canCollect && <th className="right">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setOpenId(d.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpenId(d.id)}
                  data-testid="debt-row"
                >
                  <td>
                    <strong>{d.customerName}</strong>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {d.customerCode}
                      {d.customerPhone ? ` · ${d.customerPhone}` : ''}
                    </div>
                  </td>
                  <td className="mono">{d.receiptNo ?? '—'}</td>
                  <td className="num muted">{fmt.date(d.createdAt)}</td>
                  <td className={`num ${d.overdueDays > 0 ? 'text-danger' : ''}`}>
                    {fmt.date(d.dueDate)}
                  </td>
                  <td className="right num">{fmt.money(d.amountCents)}</td>
                  <td className="right num muted">{fmt.money(d.paidCents)}</td>
                  <td className="right num">
                    <strong>{fmt.money(d.remainingCents)}</strong>
                  </td>
                  <td>
                    <StatusBadge debt={d} />
                  </td>
                  {canCollect && (
                    <td className="right">
                      {d.remainingCents > 0 && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPaying({ debt: d, all: false });
                          }}
                          data-testid="debt-pay"
                        >
                          <Banknote size={14} /> {t('debts.pay')}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </div>
      )}
      {openId && (
        <DebtDetailDialog
          debtId={openId}
          onClose={() => setOpenId(null)}
          onPay={(debt, all) => {
            setOpenId(null);
            setPaying({ debt, all });
          }}
        />
      )}
      {paying && (
        <PayDebtDialog debt={paying.debt} all={paying.all} onClose={() => setPaying(null)} />
      )}
    </>
  );
}

// ─── Detail ────────────────────────────────────────────────────────────────────
function DebtDetailDialog({
  debtId,
  onClose,
  onPay,
}: {
  debtId: string;
  onClose: () => void;
  onPay: (debt: DebtSummary, all: boolean) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['debts', 'detail', debtId],
    queryFn: () => api<DebtDetail>(`/debts/${debtId}`),
  });
  const d = detail.data;
  const openForCustomer = useQuery({
    queryKey: ['debts', 'customer-open', d?.customerId],
    queryFn: () =>
      api<Paginated<DebtSummary>>('/debts', {
        query: { filter: 'open', customerId: d!.customerId, page: 1, pageSize: 1 },
      }),
    enabled: Boolean(d?.customerId),
  });
  const [mode, setMode] = useState<'view' | 'reschedule' | 'writeOff'>('view');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const open = d ? d.status === 'open' || d.status === 'partial' : false;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['debts'] });
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  };
  const reschedule = useMutation({
    mutationFn: () =>
      api<DebtDetail>(`/debts/${debtId}/reschedule`, {
        method: 'POST',
        body: { dueDate, notes: note.trim() || undefined },
      }),
    onSuccess: () => {
      toast.success(t('debts.rescheduled'));
      setMode('view');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const writeOff = useMutation({
    mutationFn: () =>
      api<DebtDetail>(`/debts/${debtId}/write-off`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success(t('debts.writtenOff'));
      setMode('view');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={d ? d.customerName : t('debts.title')}
      description={
        d ? `${d.customerCode}${d.customerPhone ? ` · ${d.customerPhone}` : ''}` : undefined
      }
      size="md"
      footer={
        d && (
          <>
            {open && can(PERMISSIONS.DEBTS_WRITE_OFF) && mode === 'view' && (
              <Button variant="ghost" onClick={() => setMode('writeOff')}>
                {t('debts.writeOff')}
              </Button>
            )}
            {open && can(PERMISSIONS.CUSTOMERS_MANAGE) && mode === 'view' && (
              <Button
                onClick={() => {
                  setDueDate(d.dueDate);
                  setMode('reschedule');
                }}
              >
                <CalendarClock size={14} /> {t('debts.reschedule')}
              </Button>
            )}
            {mode !== 'view' && (
              <Button onClick={() => setMode('view')}>{t('common.cancel')}</Button>
            )}
            {mode === 'reschedule' && (
              <Button
                variant="primary"
                loading={reschedule.isPending}
                disabled={!dueDate}
                onClick={() => reschedule.mutate()}
              >
                {t('common.save')}
              </Button>
            )}
            {mode === 'writeOff' && (
              <Button
                variant="danger"
                loading={writeOff.isPending}
                disabled={reason.trim().length < 2}
                onClick={() => writeOff.mutate()}
                data-testid="debt-write-off-confirm"
              >
                {t('debts.writeOffConfirm')}
              </Button>
            )}
            {open && can(PERMISSIONS.POS_SELL) && mode === 'view' && (
              <>
                {(openForCustomer.data?.total ?? 0) > 1 && (
                  <Button onClick={() => onPay(d, true)} data-testid="debt-pay-all">
                    {t('debts.payAll', { n: openForCustomer.data!.total })}
                  </Button>
                )}
                <Button variant="primary" onClick={() => onPay(d, false)} data-testid="debt-pay">
                  <Banknote size={14} /> {t('debts.pay')}
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {detail.isLoading && <Loading />}
      {d && (
        <div className="stack">
          <div className="debt-head">
            <div>
              <div className="faint">{t('debts.remaining')}</div>
              <div className="debt-head__amount num" data-testid="debt-remaining">
                {fmt.money(d.remainingCents)}
              </div>
              <div className="muted">
                {t('debts.ofAmount', { amount: fmt.money(d.amountCents) })}
                {d.paidCents > 0 &&
                  ` · ${t('debts.paidSoFar', { amount: fmt.money(d.paidCents) })}`}
              </div>
            </div>
            <div className="debt-head__meta">
              <StatusBadge debt={d} />
              <div className="muted">
                {t('debts.due')}:{' '}
                <strong className={d.overdueDays > 0 ? 'text-danger' : ''}>
                  {fmt.date(d.dueDate)}
                </strong>
              </div>
              <div className="muted">
                {t('debts.opened')}: {fmt.dateTime(d.createdAt)}
                {d.createdByName ? ` · ${d.createdByName}` : ''}
              </div>
              {d.receiptNo && (
                <div className="muted">
                  <ReceiptIcon size={12} /> {d.receiptNo}
                </div>
              )}
            </div>
          </div>
          {d.notes && <div className="muted">{d.notes}</div>}
          {d.writtenOffReason && (
            <Alert tone="warning">
              {t('debts.writtenOffReason', { reason: d.writtenOffReason })}
            </Alert>
          )}

          {mode === 'reschedule' && (
            <div className="grid grid--2">
              <Field label={t('debts.newDue')}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={dueDate}
                    min={dueDateFromToday(0)}
                    onChange={(e) => setDueDate(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <Field label={t('pos.notes')} optional>
                {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
            </div>
          )}
          {mode === 'writeOff' && (
            <Field label={t('debts.writeOffReason')} hint={t('debts.writeOffHint')}>
              {(id) => (
                <Textarea
                  id={id}
                  value={reason}
                  rows={2}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
              )}
            </Field>
          )}

          {d.items.length > 0 && (
            <div>
              <div className="field__label">{t('debts.items')}</div>
              <table className="table table--compact">
                <tbody>
                  {d.items.map((i, idx) => (
                    <tr key={idx}>
                      <td>{i.description}</td>
                      <td className="num muted right">×{i.quantityMilli / 1000}</td>
                      <td className="num right">{fmt.money(i.lineTotalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <div className="field__label">{t('debts.payments')}</div>
            {d.payments.length === 0 && <div className="faint">{t('debts.noPayments')}</div>}
            {d.payments.length > 0 && (
              <table className="table table--compact">
                <tbody>
                  {d.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="num muted">{fmt.dateTime(p.receivedAt)}</td>
                      <td>
                        {t(`sessions.methods.${p.method}` as 'sessions.methods.cash')}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </td>
                      <td className="muted">{p.receivedByName ?? ''}</td>
                      <td className="num right">{fmt.money(p.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ─── Pay ───────────────────────────────────────────────────────────────────────
function PayDebtDialog({
  debt,
  all,
  onClose,
}: {
  debt: DebtSummary;
  /** Customer-level payment: the server settles the oldest debts first. */
  all: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const { methods: cashMethods } = usePaymentMethods();
  const walletOn = useAppSettings()['wallet.enabled'];
  const outstanding = useQuery({
    queryKey: ['debts', 'customer-open', debt.customerId],
    queryFn: () =>
      api<Paginated<DebtSummary>>('/debts', {
        query: { filter: 'open', customerId: debt.customerId, page: 1, pageSize: 200 },
      }),
    enabled: all,
  });
  // The customer's prepaid balance (0.11.0) can settle the debt — offered when there is one.
  const customerQuery = useQuery({
    queryKey: ['customers', 'detail', debt.customerId],
    queryFn: () => api<CustomerSummary>(`/customers/${debt.customerId}`),
    enabled: walletOn,
  });
  const walletCents = walletOn ? (customerQuery.data?.walletBalanceCents ?? 0) : 0;
  const methods: DebtPaymentRequest['method'][] =
    walletCents > 0 ? [...cashMethods, 'wallet'] : cashMethods;
  const maxCents = all
    ? (outstanding.data?.items.reduce((a, d) => a + d.remainingCents, 0) ?? debt.remainingCents)
    : debt.remainingCents;
  const [amountText, setAmountText] = useState((debt.remainingCents / 100).toFixed(2));
  const [method, setMethod] = useState<DebtPaymentRequest['method']>('cash');
  const [tenderedText, setTenderedText] = useState('');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<DebtPaymentResult | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const tenderedRef = useRef<HTMLInputElement>(null);

  // "Pay everything" pre-fills the whole balance once it is known.
  useEffect(() => {
    if (all && outstanding.data) setAmountText((maxCents / 100).toFixed(2));
  }, [all, outstanding.data, maxCents]);

  const amountCents = amountText.trim() ? parseMoneyInput(amountText) : 0;
  const tenderedCents = tenderedText.trim() ? parseMoneyInput(tenderedText) : null;
  const walletShort = method === 'wallet' && amountCents !== null && amountCents > walletCents;
  const amountOk =
    amountCents !== null && amountCents > 0 && amountCents <= maxCents && !walletShort;
  const tenderedOk =
    method !== 'cash' ||
    tenderedCents === null ||
    (amountCents !== null && tenderedCents >= amountCents);
  const change =
    method === 'cash' &&
    tenderedCents !== null &&
    amountCents !== null &&
    tenderedCents >= amountCents
      ? tenderedCents - amountCents
      : 0;

  const pay = useMutation({
    mutationFn: () =>
      api<DebtPaymentResult>(
        all ? `/customers/${debt.customerId}/debts/pay` : `/debts/${debt.id}/pay`,
        {
          method: 'POST',
          body: {
            amountCents,
            method,
            tenderedCents: method === 'cash' && tenderedCents !== null ? tenderedCents : undefined,
            reference: reference.trim() || undefined,
          },
        },
      ),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['debts'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      setResult(r);
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => pay.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const submit = () => {
    if (amountOk && tenderedOk && !pay.isPending && !result) pay.mutate();
  };

  // Enter anywhere in the dialog pays; on the result screen it closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (result) onClose();
      else submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (result) {
    const settled = result.debts.filter((d) => d.status === 'paid').length;
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('debts.paidTitle')}
        size="sm"
        footer={
          <Button
            variant="primary"
            size="lg"
            onClick={onClose}
            data-testid="debt-paid-done"
            autoFocus
          >
            {t('pos.done')} <Kbd>Enter</Kbd>
          </Button>
        }
      >
        <div className="pos-done">
          <div className="pos-done__row">
            <span>{t('debts.paid')}</span>
            <span className="num">{fmt.money(result.paidCents)}</span>
          </div>
          <div className="pos-done__row">
            <span>{t('debts.stillOwes', { name: result.customer.name })}</span>
            <span className="num" data-testid="debt-paid-balance">
              {fmt.money(result.customer.balanceDueCents)}
            </span>
          </div>
          {settled > 0 && (
            <div className="pos-done__row">
              <span>{t('debts.settledCount', { n: settled })}</span>
              <span />
            </div>
          )}
          <div className="pos-done__change" data-testid="debt-paid-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(result.changeCents)}</strong>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={all ? t('debts.payAllTitle', { name: debt.customerName }) : t('debts.payTitle')}
      description={
        all
          ? t('debts.payAllHint')
          : `${debt.customerName}${debt.receiptNo ? ` · ${debt.receiptNo}` : ''} · ${t('debts.due')} ${fmt.date(debt.dueDate)}`
      }
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!amountOk || !tenderedOk}
            loading={pay.isPending}
            onClick={submit}
            data-testid="debt-pay-confirm"
          >
            {t('debts.confirmPay')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="pos__grand" style={{ fontSize: 24 }}>
          <span>{t('debts.remaining')}</span>
          <span className="num">{fmt.money(maxCents)}</span>
        </div>
        <div className="grid grid--2">
          <Field
            label={t('debts.amountToPay')}
            error={amountCents !== null && amountCents > maxCents ? t('debts.overpay') : undefined}
          >
            {(id) => (
              <Input
                id={id}
                ref={amountRef}
                inputMode="decimal"
                className="num"
                style={{ fontSize: 20, height: 44 }}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                aria-invalid={!amountOk}
                autoFocus
                data-testid="debt-amount"
              />
            )}
          </Field>
          {methods.length > 1 ? (
            <Field label={t('debts.method')}>
              {(id) => (
                <Select
                  id={id}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as DebtPaymentRequest['method'])}
                  data-testid="debt-method"
                >
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {m === 'wallet'
                        ? `${t('pos.wallet')} · ${fmt.money(walletCents)}`
                        : t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label={t('debts.method')}>
              {(id) => <Input id={id} value={t('pos.cash')} readOnly />}
            </Field>
          )}
        </div>
        <div className="chips">
          <button
            type="button"
            className="chip"
            onClick={() => setAmountText((maxCents / 100).toFixed(2))}
          >
            {t('debts.payFull')}
          </button>
          {[0.5, 0.25].map((f) => {
            const c = Math.floor((maxCents * f) / 10) * 10;
            return c > 0 && c < maxCents ? (
              <button
                key={f}
                type="button"
                className="chip"
                onClick={() => setAmountText((c / 100).toFixed(2))}
              >
                {f === 0.5 ? '½' : '¼'} · {fmt.money(c)}
              </button>
            ) : null;
          })}
        </div>
        {method === 'cash' && (
          <>
            <div className="chips">
              {suggestTenders(amountCents ?? 0).map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip chip--tender"
                  onClick={() => {
                    setTenderedText((c / 100).toFixed(2));
                    tenderedRef.current?.focus();
                  }}
                >
                  {fmt.money(c)}
                </button>
              ))}
            </div>
            <Field label={t('pos.tendered')} optional hint={t('debts.tenderedHint')}>
              {(id) => (
                <Input
                  id={id}
                  ref={tenderedRef}
                  inputMode="decimal"
                  className="num"
                  value={tenderedText}
                  onChange={(e) => setTenderedText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-invalid={!tenderedOk}
                  data-testid="debt-tendered"
                />
              )}
            </Field>
          </>
        )}
        {method === 'wallet' && (
          <div className="pos__change pos__change--wallet" data-testid="debt-wallet">
            <span>{t('pos.walletTaken')}</span>
            <strong className="num">
              {fmt.money(Math.min(amountCents ?? 0, walletCents))} ·{' '}
              {t('pos.walletLeft', {
                amount: fmt.money(Math.max(0, walletCents - (amountCents ?? 0))),
              })}
            </strong>
          </div>
        )}
        {walletShort && <Alert tone="danger">{t('pos.walletOver')}</Alert>}
        {method !== 'cash' && method !== 'wallet' && (
          <Field label={t('pos.reference')} optional>
            {(id) => (
              <Input
                id={id}
                value={reference}
                maxLength={80}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
        )}
        {!tenderedOk && <Alert tone="danger">{t('debts.tenderedShort')}</Alert>}
        {amountOk && method === 'cash' && tenderedCents !== null && tenderedOk && (
          <div className="pos__change" data-testid="debt-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(change)}</strong>
          </div>
        )}
      </div>
    </Dialog>
  );
}
