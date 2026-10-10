/**
 * Cash register ("Arka"): the open shift with its live drawer total, pay-in / pay-out,
 * closing with a counted amount (difference shown before confirming), the movement ledger and
 * the history of closed shifts with a printable shift report (Z report).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Lock, LockOpen, Printer, Wallet } from 'lucide-react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type CashMovementSummary,
  type CashMovementType,
  type CashShiftDetail,
  type CashShiftSummary,
  type CashStatusResponse,
  type Paginated,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useAppSettings } from '../state/app-settings';
import { useToast } from '../state/toast';
import { useShiftGuard } from '../state/shift-guard';
import {
  Badge,
  Button,
  Card,
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

const PAGE_SIZE = 25;

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MOVEMENT_TONE: Record<
  CashMovementType,
  'default' | 'success' | 'warning' | 'danger' | 'info'
> = {
  opening: 'info',
  sale: 'success',
  refund: 'danger',
  deposit: 'success',
  withdrawal: 'warning',
  expense: 'warning',
  supplier_payment: 'warning',
  wallet_topup: 'success',
  customer_payment: 'success',
  correction: 'default',
};

export function CashPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shiftGuard = useShiftGuard();
  const [movementDialog, setMovementDialog] = useState<'deposit' | 'withdrawal' | null>(null);
  const [closing, setClosing] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<'' | 'open' | 'closed'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayLocal());
  const [page, setPage] = useState(1);
  const [openShiftId, setOpenShiftId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['cash', 'status'],
    queryFn: () => api<CashStatusResponse>('/cash/status'),
    refetchInterval: 30_000,
    staleTime: 0,
  });
  const history = useQuery({
    queryKey: ['cash', 'shifts', { historyStatus, from, to, page }],
    queryFn: () =>
      api<Paginated<CashShiftSummary>>('/cash/shifts', {
        query: {
          status: historyStatus || undefined,
          from: from || undefined,
          to: to || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cash'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const current = status.data?.current ?? null;
  const warnCents = status.data?.differenceWarningCents ?? 500;
  const canOpenClose = can(PERMISSIONS.CASH_OPEN_CLOSE);
  const canMove = can(PERMISSIONS.CASH_MOVE);

  return (
    <>
      <PageHeader
        title={t('cash.title')}
        subtitle={
          status.data
            ? status.data.requireOpenShift
              ? t('cash.subtitleRequired')
              : t('cash.subtitleOptional')
            : undefined
        }
        actions={
          <>
            {current && canMove && (
              <>
                <Button onClick={() => setMovementDialog('deposit')}>
                  <ArrowDownToLine size={14} /> {t('cash.deposit')}
                </Button>
                <Button onClick={() => setMovementDialog('withdrawal')}>
                  <ArrowUpFromLine size={14} /> {t('cash.withdrawal')}
                </Button>
              </>
            )}
            {current && canOpenClose && (
              <Button variant="danger" onClick={() => setClosing(true)}>
                <Lock size={14} /> {t('cash.closeShift')}
              </Button>
            )}
            {!current && canOpenClose && status.isSuccess && (
              <Button variant="primary" onClick={() => shiftGuard.requestOpenShift()}>
                <LockOpen size={14} /> {t('cash.openShift')}
              </Button>
            )}
          </>
        }
      />

      {status.isLoading && <Loading />}
      {status.isSuccess && !current && (
        <EmptyState
          icon={<Wallet size={22} />}
          title={t('cash.noOpenShift')}
          hint={
            status.data.requireOpenShift ? t('cash.noOpenShiftHint') : t('cash.subtitleOptional')
          }
        />
      )}
      {current && (
        <>
          <div className="grid grid--stats" style={{ marginBottom: 16 }}>
            <StatTile
              label={t('cash.expectedCash')}
              value={fmt.money(current.totals.expectedCashCents)}
              sub={t('cash.openedBy', {
                name: current.openedBy.name,
                time: fmt.dateTime(current.openedAt),
              })}
            />
            <StatTile
              label={t('cash.cashSales')}
              value={fmt.money(current.totals.cashSalesCents)}
              sub={t('cash.salesCount', { count: current.totals.salesCount })}
            />
            <StatTile
              label={t('cash.cashRefunds')}
              value={fmt.money(current.totals.cashRefundsCents)}
              sub={t('cash.refundsCount', { count: current.totals.refundsCount })}
            />
            <StatTile label={t('cash.expenses')} value={fmt.money(current.totals.expensesCents)} />
            <StatTile
              label={t('cash.inOut')}
              value={`+${fmt.money(current.totals.depositsCents)} / −${fmt.money(current.totals.withdrawalsCents)}`}
            />
          </div>
          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <ShiftLedger shift={current} />
            <ShiftBreakdown shift={current} />
          </div>
        </>
      )}

      <h2 className="subhead" style={{ marginTop: 28 }}>
        {t('cash.history')}
      </h2>
      <div className="toolbar">
        <Select
          value={historyStatus}
          onChange={(e) => {
            setHistoryStatus(e.target.value as '' | 'open' | 'closed');
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          <option value="">{t('common.all')}</option>
          <option value="open">{t('cash.status.open')}</option>
          <option value="closed">{t('cash.status.closed')}</option>
        </Select>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.from')}</span>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.to')}</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {history.isSuccess && history.data.items.length === 0 && (
        <EmptyState title={t('cash.historyEmpty')} />
      )}
      {history.isSuccess && history.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th>{t('cash.opened')}</th>
                <th>{t('cash.closed')}</th>
                <th>{t('cash.register')}</th>
                <th>{t('common.status')}</th>
                <th className="right">{t('cash.openingFloat')}</th>
                <th className="right">{t('cash.expectedCash')}</th>
                <th className="right">{t('cash.counted')}</th>
                <th className="right">{t('cash.difference')}</th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setOpenShiftId(s.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpenShiftId(s.id)}
                >
                  <td className="num">
                    {fmt.dateTime(s.openedAt)}
                    <div className="faint" style={{ fontSize: 12 }}>
                      {s.openedBy.name}
                    </div>
                  </td>
                  <td className="num">
                    {s.closedAt ? fmt.dateTime(s.closedAt) : '—'}
                    {s.closedBy && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {s.closedBy.name}
                      </div>
                    )}
                  </td>
                  <td>{s.registerName}</td>
                  <td>
                    <Badge tone={s.status === 'open' ? 'success' : 'default'}>
                      {t(`cash.status.${s.status}` as 'cash.status.open')}
                    </Badge>
                  </td>
                  <td className="right num">{fmt.money(s.openingCents)}</td>
                  <td className="right num">
                    {s.expectedCashCents != null ? fmt.money(s.expectedCashCents) : '—'}
                  </td>
                  <td className="right num">
                    {s.countedCashCents != null ? fmt.money(s.countedCashCents) : '—'}
                  </td>
                  <td className="right num">
                    {s.differenceCents != null ? (
                      <DifferenceBadge cents={s.differenceCents} warnCents={warnCents} />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={history.data.total}
            onPage={setPage}
          />
        </div>
      )}

      {movementDialog && current && (
        <MovementDialog
          type={movementDialog}
          available={current.totals.expectedCashCents}
          onClose={() => setMovementDialog(null)}
          onDone={() => {
            setMovementDialog(null);
            invalidate();
          }}
        />
      )}
      {closing && current && (
        <CloseShiftDialog
          shift={current}
          warnCents={warnCents}
          onClose={() => setClosing(false)}
          onDone={(closed) => {
            setClosing(false);
            invalidate();
            toast.success(t('cash.shiftClosed'));
            setOpenShiftId(closed.id);
          }}
        />
      )}
      {openShiftId && (
        <ShiftDetailDialog
          shiftId={openShiftId}
          warnCents={warnCents}
          onClose={() => setOpenShiftId(null)}
        />
      )}
    </>
  );
}

function DifferenceBadge({ cents, warnCents }: { cents: number; warnCents: number }) {
  const fmt = useFormat();
  const tone = cents === 0 ? 'success' : Math.abs(cents) > warnCents ? 'danger' : 'warning';
  return (
    <Badge tone={tone}>
      {cents > 0 ? '+' : ''}
      {fmt.money(cents)}
    </Badge>
  );
}

// ─── Ledger & breakdown ────────────────────────────────────────────────────────
function ShiftLedger({ shift }: { shift: CashShiftDetail }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const label = (m: CashMovementSummary) => t(`cash.movement.${m.type}` as 'cash.movement.sale');
  return (
    <Card title={t('cash.ledger')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('cash.ledgerHint')}
      </p>
      {shift.movements.length === 0 ? (
        <p className="muted">{t('cash.noMovements')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('common.time')}</th>
                <th>{t('cash.movementType')}</th>
                <th>{t('cash.reason')}</th>
                <th className="right">{t('receipt.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {[...shift.movements].reverse().map((m) => (
                <tr key={m.id}>
                  <td className="num">{fmt.time(m.createdAt)}</td>
                  <td>
                    <Badge tone={MOVEMENT_TONE[m.type]}>{label(m)}</Badge>
                  </td>
                  <td className="muted">
                    {m.reason ?? ''}
                    {m.createdBy && (
                      <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                        {m.createdBy.name}
                      </span>
                    )}
                  </td>
                  <td className={`right num ${m.amountCents < 0 ? 'text-danger' : ''}`}>
                    {m.amountCents > 0 ? '+' : ''}
                    {fmt.money(m.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ShiftBreakdown({ shift }: { shift: CashShiftDetail }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const tt = shift.totals;
  const rows: { label: string; cents: number; sign?: boolean }[] = [
    { label: t('cash.openingFloat'), cents: tt.openingCents },
    { label: t('cash.cashSales'), cents: tt.cashSalesCents, sign: true },
    { label: t('cash.cashRefunds'), cents: -tt.cashRefundsCents, sign: true },
    { label: t('cash.deposit'), cents: tt.depositsCents, sign: true },
    { label: t('cash.withdrawal'), cents: -tt.withdrawalsCents, sign: true },
    { label: t('cash.expenses'), cents: -tt.expensesCents, sign: true },
    { label: t('cash.other'), cents: tt.otherCents, sign: true },
  ];
  return (
    <div className="stack">
      <Card title={t('cash.drawerSummary')}>
        <table className="table table--compact">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className={`right num ${r.cents < 0 ? 'text-danger' : ''}`}>
                  {r.sign && r.cents > 0 ? '+' : ''}
                  {fmt.money(r.cents)}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>{t('cash.expectedCash')}</strong>
              </td>
              <td className="right num">
                <strong>{fmt.money(tt.expectedCashCents)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      <Card title={t('cash.salesBreakdown')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('cash.salesBreakdownHint')}
        </p>
        <div className="grid grid--2">
          <table className="table table--compact">
            <tbody>
              {tt.salesByMethod.length === 0 && (
                <tr>
                  <td className="muted">{t('common.none')}</td>
                </tr>
              )}
              {tt.salesByMethod.map((m) => (
                <tr key={m.method}>
                  <td>
                    {t(`sessions.methods.${m.method}` as 'sessions.methods.cash')}
                    <span className="faint" style={{ marginLeft: 6 }}>
                      ×{m.count}
                    </span>
                  </td>
                  <td className="right num">{fmt.money(m.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="table table--compact">
            <tbody>
              {tt.salesBySource.map((s) => (
                <tr key={s.source}>
                  <td>
                    {t(`sales.source.${s.source}` as 'sales.source.retail')}
                    <span className="faint" style={{ marginLeft: 6 }}>
                      ×{s.count}
                    </span>
                  </td>
                  <td className="right num">{fmt.money(s.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── Dialogs ───────────────────────────────────────────────────────────────────
function MovementDialog({
  type,
  available,
  onClose,
  onDone,
}: {
  type: 'deposit' | 'withdrawal';
  available: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const cents = amount.trim() ? parseMoneyInput(amount) : null;
  const tooMuch = type === 'withdrawal' && cents !== null && cents > available;
  const valid = cents !== null && cents > 0 && reason.trim().length > 0 && !tooMuch;
  const mutation = useMutation({
    mutationFn: () =>
      api<CashShiftDetail>('/cash/movements', {
        method: 'POST',
        body: { type, amountCents: cents, reason: reason.trim() },
      }),
    onSuccess: () => {
      toast.success(type === 'deposit' ? t('cash.depositDone') : t('cash.withdrawalDone'));
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={type === 'deposit' ? t('cash.deposit') : t('cash.withdrawal')}
      description={type === 'deposit' ? t('cash.depositHint') : t('cash.withdrawalHint')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t('common.confirm')}
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
        <Field
          label={t('receipt.amount')}
          error={
            amount.trim() && cents === null
              ? t('common.invalid')
              : tooMuch
                ? t('cash.exceedsDrawer', { available: fmt.money(available) })
                : undefined
          }
        >
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid || undefined}
              autoFocus
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('cash.reason')}>
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid || undefined}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          )}
        </Field>
        {type === 'withdrawal' && (
          <p className="muted">{t('cash.inDrawer', { amount: fmt.money(available) })}</p>
        )}
      </form>
    </Dialog>
  );
}

function CloseShiftDialog({
  shift,
  warnCents,
  onClose,
  onDone,
}: {
  shift: CashShiftDetail;
  warnCents: number;
  onClose: () => void;
  onDone: (closed: CashShiftDetail) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const cents = counted.trim() ? parseMoneyInput(counted) : null;
  const expected = shift.totals.expectedCashCents;
  const difference = cents === null ? null : cents - expected;
  const mutation = useMutation({
    mutationFn: () =>
      api<CashShiftDetail>(`/cash/shifts/${shift.id}/close`, {
        method: 'POST',
        body: { countedCashCents: cents, notes: notes.trim() || undefined },
      }),
    onSuccess: onDone,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cash.closeShift')}
      description={t('cash.closeHint')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={cents === null}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Lock size={14} /> {t('cash.closeShift')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (cents !== null && !mutation.isPending) mutation.mutate();
        }}
      >
        <div className="row row--between">
          <span className="muted">{t('cash.expectedCash')}</span>
          <strong className="num">{fmt.money(expected)}</strong>
        </div>
        <Field
          label={t('cash.countedCash')}
          hint={t('cash.countedHint')}
          error={counted.trim() && cents === null ? t('common.invalid') : undefined}
        >
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid || undefined}
              autoFocus
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          )}
        </Field>
        {difference !== null && (
          <div className="row row--between">
            <span className="muted">{t('cash.difference')}</span>
            <DifferenceBadge cents={difference} warnCents={warnCents} />
          </div>
        )}
        {difference !== null && Math.abs(difference) > warnCents && (
          <p className="text-danger">{t('cash.differenceWarning')}</p>
        )}
        <Field label={t('common.notes')} optional>
          {(id, invalid) => (
            <Textarea
              id={id}
              aria-invalid={invalid || undefined}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function ShiftDetailDialog({
  shiftId,
  warnCents,
  onClose,
}: {
  shiftId: string;
  warnCents: number;
  onClose: () => void;
}) {
  const { t, td } = useI18n();
  const fmt = useFormat();
  const settings = useAppSettings();
  const shift = useQuery({
    queryKey: ['cash', 'shift', shiftId],
    queryFn: () => api<CashShiftDetail>(`/cash/shifts/${shiftId}`),
  });
  const s = shift.data;
  const printable = useMemo(() => (s ? buildShiftReportRows(s, td, fmt.money) : []), [s, td, fmt]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('cash.shiftReport')}
      size="lg"
      footer={
        s && (
          <Button onClick={() => window.print()}>
            <Printer size={14} /> {t('cash.print')}
          </Button>
        )
      }
    >
      {shift.isLoading && <Loading />}
      {s && (
        <div className="stack">
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Badge tone={s.status === 'open' ? 'success' : 'default'}>
              {t(`cash.status.${s.status}` as 'cash.status.open')}
            </Badge>
            <span className="muted">
              {t('cash.opened')}: {fmt.dateTime(s.openedAt)} · {s.openedBy.name}
            </span>
            {s.closedAt && (
              <span className="muted">
                {t('cash.closed')}: {fmt.dateTime(s.closedAt)} · {s.closedBy?.name}
              </span>
            )}
          </div>
          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <ShiftBreakdown shift={s} />
            <div className="stack">
              {s.status === 'closed' && (
                <Card title={t('cash.closing')} className="shift-closing">
                  <table className="table table--compact">
                    <tbody>
                      <tr>
                        <td>{t('cash.expectedCash')}</td>
                        <td className="right num">{fmt.money(s.expectedCashCents ?? 0)}</td>
                      </tr>
                      <tr>
                        <td>{t('cash.counted')}</td>
                        <td className="right num">{fmt.money(s.countedCashCents ?? 0)}</td>
                      </tr>
                      <tr>
                        <td>{t('cash.difference')}</td>
                        <td className="right num">
                          <DifferenceBadge cents={s.differenceCents ?? 0} warnCents={warnCents} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  {s.notes && (
                    <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                      {s.notes}
                    </p>
                  )}
                </Card>
              )}
            </div>
          </div>
          <ShiftLedger shift={s} />
          {/* Printable Z report (print styles isolate #printable-receipt) */}
          <div id="printable-receipt" className="receipt print-only" aria-hidden>
            <div className="receipt__head">
              <div className="receipt__name">{settings['business.name']}</div>
              <div>{t('cash.shiftReport')}</div>
              <div>
                {fmt.dateTime(s.openedAt)} →{' '}
                {s.closedAt ? fmt.dateTime(s.closedAt) : t('cash.status.open')}
              </div>
            </div>
            <table className="receipt__items">
              <tbody>
                {printable.map((r, i) => (
                  <tr key={i} className={r.strong ? 'receipt__total' : undefined}>
                    <td>{r.label}</td>
                    <td className="right">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="receipt__foot">
              {t('cash.openedBy', { name: s.openedBy.name, time: fmt.dateTime(s.openedAt) })}
              {s.closedBy && (
                <>
                  <br />
                  {t('cash.closedBy', { name: s.closedBy.name, time: fmt.dateTime(s.closedAt) })}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function buildShiftReportRows(
  s: CashShiftDetail,
  tr: (key: string, fallback?: string) => string,
  money: (cents: number) => string,
): { label: string; value: string; strong?: boolean }[] {
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: tr('cash.openingFloat'), value: money(s.totals.openingCents) },
    { label: tr('cash.cashSales'), value: money(s.totals.cashSalesCents) },
    { label: tr('cash.cashRefunds'), value: money(-s.totals.cashRefundsCents) },
    { label: tr('cash.deposit'), value: money(s.totals.depositsCents) },
    { label: tr('cash.withdrawal'), value: money(-s.totals.withdrawalsCents) },
    { label: tr('cash.expenses'), value: money(-s.totals.expensesCents) },
    { label: tr('cash.expectedCash'), value: money(s.totals.expectedCashCents), strong: true },
  ];
  for (const m of s.totals.salesByMethod) {
    rows.push({
      label: `${tr('cash.salesBreakdown')} · ${tr(`sessions.methods.${m.method}`, m.method)} ×${m.count}`,
      value: money(m.amountCents),
    });
  }
  if (s.status === 'closed') {
    rows.push({ label: tr('cash.counted'), value: money(s.countedCashCents ?? 0), strong: true });
    rows.push({ label: tr('cash.difference'), value: money(s.differenceCents ?? 0), strong: true });
  }
  return rows;
}
