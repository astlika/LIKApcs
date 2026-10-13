/**
 * Debts — the "pay later" ledger. Who owes what, since when and until when; overdue first.
 *
 * Collecting money is a cash-drawer operation (`pos.sell`): the pay dialog takes the amount
 * (the remainder by default, or any part of it), the method, the cash handed over for the change,
 * and posts `POST /debts/:id/pay`. "Pay everything" for a customer posts
 * `POST /customers/:id/debts/pay` and the server settles the oldest debts first.
 * A new due date needs `customers.manage`; forgiving a debt needs `debts.write_off` and a reason.
 */
import { useMemo, useState } from 'react';
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
  type DebtDetail,
  type DebtSummary,
  type DebtsOverview,
  type Paginated,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { dueDateFromToday } from '../components/payments/TenderPanel';
import { PayDebtDialog } from '../components/debts/PayDebtDialog';
import { RescheduleAllDialog } from '../components/debts/RescheduleAllDialog';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
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
        <PayDebtDialog
          customer={{ id: paying.debt.customerId, name: paying.debt.customerName }}
          debt={paying.all ? undefined : paying.debt}
          onClose={() => setPaying(null)}
        />
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
    // Decides which bulk buttons show — always fresh.
    staleTime: 0,
  });
  const [mode, setMode] = useState<'view' | 'reschedule' | 'writeOff'>('view');
  const [extendingAll, setExtendingAll] = useState(false);
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
              <>
                {(openForCustomer.data?.total ?? 0) > 1 && (
                  <Button onClick={() => setExtendingAll(true)} data-testid="debt-extend-all">
                    <CalendarClock size={14} />{' '}
                    {t('debts.extendAllN', { n: openForCustomer.data!.total })}
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setDueDate(d.dueDate);
                    setMode('reschedule');
                  }}
                >
                  <CalendarClock size={14} /> {t('debts.reschedule')}
                </Button>
              </>
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
      {d && extendingAll && (
        <RescheduleAllDialog
          customer={{ id: d.customerId, name: d.customerName }}
          count={openForCustomer.data?.total}
          onClose={() => setExtendingAll(false)}
        />
      )}
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
