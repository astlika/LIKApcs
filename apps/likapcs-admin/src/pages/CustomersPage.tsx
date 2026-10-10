/**
 * Customers: searchable directory (name / phone / code), create & edit, status (active,
 * blocked, archived) and a detail view with visit statistics, recent sales and sessions.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, UserRound } from 'lucide-react';
import {
  CUSTOMER_STATUSES,
  PERMISSIONS,
  formatDuration,
  type CustomerDetail,
  type CustomerStatus,
  type CustomerSummary,
  type Paginated,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
const STATUS_TONE: Record<CustomerStatus, 'success' | 'danger' | 'default'> = {
  active: 'success',
  blocked: 'danger',
  archived: 'default',
};

export function CustomersPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.CUSTOMERS_MANAGE);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | CustomerStatus>('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CustomerSummary | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useMemo(
    () => ({ q: q.trim() || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }),
    [q, status, page],
  );
  const list = useQuery({
    queryKey: ['customers', 'list', query],
    queryFn: () => api<Paginated<CustomerSummary>>('/customers', { query }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        subtitle={t('customers.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('customers.new')}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('customers.search')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 280 }}
          aria-label={t('customers.search')}
          autoFocus
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | CustomerStatus);
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          <option value="">{t('customers.activeOnly')}</option>
          {CUSTOMER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`customers.status.${s}` as 'customers.status.active')}
            </option>
          ))}
        </Select>
      </div>
      {list.isLoading && <Loading />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState
          icon={<UserRound size={22} />}
          title={t('customers.empty')}
          hint={canManage ? t('customers.emptyHint') : undefined}
        />
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th>{t('customers.code')}</th>
                <th>{t('common.name')}</th>
                <th>{t('customers.phone')}</th>
                <th>{t('customers.membership')}</th>
                <th className="right">{t('customers.discount')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.created')}</th>
                {canManage && <th className="right">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setOpenId(c.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpenId(c.id)}
                >
                  <td className="mono">{c.code}</td>
                  <td>
                    <strong>{c.name}</strong>
                    {c.email && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {c.email}
                      </div>
                    )}
                  </td>
                  <td className="num">{c.phone ?? '—'}</td>
                  <td>
                    {c.membership ?? '—'}
                    {c.membershipUntil && (
                      <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                        → {fmt.date(c.membershipUntil)}
                      </span>
                    )}
                  </td>
                  <td className="right num">{c.discountBp ? `${c.discountBp / 100}%` : '—'}</td>
                  <td>
                    <Badge tone={STATUS_TONE[c.status]}>
                      {t(`customers.status.${c.status}` as 'customers.status.active')}
                    </Badge>
                  </td>
                  <td className="num muted">{fmt.date(c.createdAt)}</td>
                  {canManage && (
                    <td className="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(c);
                        }}
                        title={t('common.edit')}
                      >
                        <Pencil size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </div>
      )}
      {editing && (
        <CustomerDialog
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {openId && (
        <CustomerDetailDialog
          customerId={openId}
          canManage={canManage}
          onEdit={(c) => {
            setOpenId(null);
            setEditing(c);
          }}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

// ─── Create / edit ─────────────────────────────────────────────────────────────
function CustomerDialog({
  customer,
  onClose,
}: {
  customer: CustomerSummary | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    membership: customer?.membership ?? '',
    membershipUntil: customer?.membershipUntil ?? '',
    discountPct: customer ? String(customer.discountBp / 100) : '0',
    notes: customer?.notes ?? '',
    status: (customer?.status ?? 'active') as CustomerStatus,
  });
  const discountBp = Math.round(Number(form.discountPct.replace(',', '.')) * 100);
  const valid =
    form.name.trim().length > 0 &&
    Number.isFinite(discountBp) &&
    discountBp >= 0 &&
    discountBp <= 10_000;
  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        code: form.code.trim() || undefined,
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        membership: form.membership.trim() || null,
        membershipUntil: form.membershipUntil || null,
        discountBp,
        notes: form.notes.trim() || null,
        status: form.status,
      };
      return customer
        ? api<CustomerSummary>(`/customers/${customer.id}`, { method: 'PATCH', body })
        : api<CustomerSummary>('/customers', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(t('customers.saved'));
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const err = mutation.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={customer ? t('customers.edit', { name: customer.name }) : t('customers.new')}
      size="md"
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
            {t('common.save')}
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
        <div className="grid grid--2">
          <Field label={t('common.name')} error={fieldError(err, 'name')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={120}
              />
            )}
          </Field>
          <Field
            label={t('customers.code')}
            hint={customer ? undefined : t('customers.codeHint')}
            error={fieldError(err, 'code')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                maxLength={32}
                placeholder={customer ? undefined : 'C-000001'}
              />
            )}
          </Field>
        </div>
        <div className="grid grid--2">
          <Field label={t('customers.phone')} optional error={fieldError(err, 'phone')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                maxLength={40}
                inputMode="tel"
              />
            )}
          </Field>
          <Field label={t('customers.email')} optional error={fieldError(err, 'email')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                maxLength={120}
                inputMode="email"
              />
            )}
          </Field>
        </div>
        <div className="grid grid--2">
          <Field label={t('customers.membership')} optional hint={t('customers.membershipHint')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                value={form.membership}
                onChange={(e) => setForm({ ...form, membership: e.target.value })}
                maxLength={40}
              />
            )}
          </Field>
          <Field label={t('customers.membershipUntil')} optional>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                type="date"
                value={form.membershipUntil}
                onChange={(e) => setForm({ ...form, membershipUntil: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="grid grid--2">
          <Field
            label={t('customers.discount')}
            hint={t('customers.discountHint')}
            error={!valid && form.name.trim() ? t('common.invalid') : undefined}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                inputMode="decimal"
                value={form.discountPct}
                onChange={(e) => setForm({ ...form, discountPct: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('common.status')}>
            {(id, invalid) => (
              <Select
                id={id}
                aria-invalid={invalid || undefined}
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as CustomerStatus })}
              >
                {CUSTOMER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`customers.status.${s}` as 'customers.status.active')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('common.notes')} optional>
          {(id, invalid) => (
            <Textarea
              id={id}
              aria-invalid={invalid || undefined}
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              maxLength={1000}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

// ─── Detail ────────────────────────────────────────────────────────────────────
function CustomerDetailDialog({
  customerId,
  canManage,
  onEdit,
  onClose,
}: {
  customerId: string;
  canManage: boolean;
  onEdit: (c: CustomerSummary) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [archiving, setArchiving] = useState(false);
  const detail = useQuery({
    queryKey: ['customers', 'detail', customerId],
    queryFn: () => api<CustomerDetail>(`/customers/${customerId}`),
  });
  const archive = useMutation({
    mutationFn: () => api<CustomerSummary>(`/customers/${customerId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('customers.archived'));
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const c = detail.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={c ? `${c.name} · ${c.code}` : '…'}
      size="lg"
      footer={
        c &&
        canManage && (
          <>
            {c.status !== 'archived' && (
              <Button variant="danger" onClick={() => setArchiving(true)}>
                <Archive size={14} /> {t('customers.archive')}
              </Button>
            )}
            <Button variant="primary" onClick={() => onEdit(c)}>
              <Pencil size={14} /> {t('common.edit')}
            </Button>
          </>
        )
      }
    >
      {detail.isLoading && <Loading />}
      {c && (
        <div className="stack">
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Badge tone={STATUS_TONE[c.status]}>
              {t(`customers.status.${c.status}` as 'customers.status.active')}
            </Badge>
            {c.phone && <span className="muted">{c.phone}</span>}
            {c.email && <span className="muted">{c.email}</span>}
            {c.membership && (
              <span className="muted">
                {t('customers.membership')}: {c.membership}
                {c.membershipUntil ? ` → ${fmt.date(c.membershipUntil)}` : ''}
              </span>
            )}
            {c.discountBp > 0 && (
              <span className="muted">
                {t('customers.discount')}: {c.discountBp / 100}%
              </span>
            )}
          </div>
          {c.notes && (
            <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>
              {c.notes}
            </p>
          )}
          <div className="grid grid--stats">
            <StatTile label={t('customers.visits')} value={String(c.stats.salesCount)} />
            <StatTile label={t('customers.spent')} value={fmt.money(c.stats.salesTotalCents)} />
            <StatTile
              label={t('customers.playTime')}
              value={formatDuration(c.stats.sessionsMinutes * 60)}
              sub={t('customers.sessionsCount', { count: c.stats.sessionsCount })}
            />
            <StatTile
              label={t('customers.lastVisit')}
              value={c.stats.lastVisitAt ? fmt.date(c.stats.lastVisitAt) : '—'}
            />
          </div>
          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <Card title={t('customers.recentSales')}>
              {c.recentSales.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <table className="table table--compact">
                  <tbody>
                    {c.recentSales.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.receiptNo ?? '—'}</td>
                        <td className="num muted">{fmt.dateTime(s.completedAt ?? s.createdAt)}</td>
                        <td className="right num">{fmt.money(s.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('customers.recentSessions')}>
              {c.recentSessions.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <table className="table table--compact">
                  <tbody>
                    {c.recentSessions.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.stationCode}</td>
                        <td className="num muted">{fmt.dateTime(s.startedAt)}</td>
                        <td className="num">{formatDuration(s.billableSeconds)}</td>
                        <td className="right num">
                          {fmt.money(s.finalPriceCents ?? s.currentPriceCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        onConfirm={() => archive.mutate()}
        title={t('customers.archive')}
        body={t('customers.archiveConfirm', { name: c?.name ?? '' })}
        confirmLabel={t('customers.archive')}
        danger
        loading={archive.isPending}
      />
    </Dialog>
  );
}
