/**
 * Expenses: a filtered list with period total, recording new expenses (cash expenses can be
 * taken straight from the open drawer), voiding with a reason, and expense categories.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, FolderPlus, Plus, Receipt } from 'lucide-react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type ExpenseCategorySummary,
  type ExpenseListResponse,
  type ExpenseSummary,
  type PaymentMethod,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useShiftGuard } from '../state/shift-guard';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Select,
  StatTile,
  Switch,
  Textarea,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;
const EXPENSE_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'other'];

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStart(): string {
  return `${todayLocal().slice(0, 8)}01`;
}

export function ExpensesPage() {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.EXPENSES_MANAGE);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const [category, setCategory] = useState('');
  const [method, setMethod] = useState<'' | PaymentMethod>('');
  const [q, setQ] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [categories, setCategories] = useState(false);
  const [voiding, setVoiding] = useState<ExpenseSummary | null>(null);

  const cats = useQuery({
    queryKey: ['expenses', 'categories', { includeInactive: false }],
    queryFn: () => api<ExpenseCategorySummary[]>('/expenses/categories'),
    staleTime: 60_000,
  });
  const catName = (code: string, fallback?: { en: string; sq: string }) => {
    const c = cats.data?.find((x) => x.code === code);
    const names = c ? { en: c.nameEn, sq: c.nameSq } : fallback;
    return names ? (language === 'sq' ? names.sq : names.en) : code;
  };
  const query = useMemo(
    () => ({
      from: from || undefined,
      to: to || undefined,
      categoryCode: category || undefined,
      paymentMethod: method || undefined,
      q: q.trim() || undefined,
      includeVoided: includeVoided || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [from, to, category, method, q, includeVoided, page],
  );
  const list = useQuery({
    queryKey: ['expenses', 'list', query],
    queryFn: () => api<ExpenseListResponse>('/expenses', { query }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title={t('expenses.title')}
        subtitle={t('expenses.subtitle')}
        actions={
          canManage && (
            <>
              <Button onClick={() => setCategories(true)}>
                <FolderPlus size={14} /> {t('expenses.categories')}
              </Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> {t('expenses.new')}
              </Button>
            </>
          )
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('expenses.search')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 220 }}
          aria-label={t('expenses.search')}
        />
        <Select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
          aria-label={t('expenses.category')}
        >
          <option value="">{t('expenses.allCategories')}</option>
          {cats.data?.map((c) => (
            <option key={c.code} value={c.code}>
              {language === 'sq' ? c.nameSq : c.nameEn}
            </option>
          ))}
        </Select>
        <Select
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as '' | PaymentMethod);
            setPage(1);
          }}
          aria-label={t('sessions.paymentMethod')}
        >
          <option value="">{t('expenses.allMethods')}</option>
          {EXPENSE_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`sessions.methods.${m}` as 'sessions.methods.cash')}
            </option>
          ))}
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
        <Switch
          checked={includeVoided}
          onChange={(v) => {
            setIncludeVoided(v);
            setPage(1);
          }}
          label={t('expenses.showVoided')}
        />
      </div>
      {list.data && (
        <div className="grid grid--stats" style={{ marginBottom: 16 }}>
          <StatTile label={t('expenses.count')} value={String(list.data.total)} />
          <StatTile label={t('expenses.periodTotal')} value={fmt.money(list.data.totalCents)} />
        </div>
      )}
      {list.isLoading && <Loading />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState icon={<Receipt size={22} />} title={t('expenses.empty')} />
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('expenses.category')}</th>
                <th>{t('expenses.description')}</th>
                <th>{t('sessions.paymentMethod')}</th>
                <th>{t('expenses.recordedBy')}</th>
                <th className="right">{t('receipt.amount')}</th>
                {canManage && <th className="right">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((e) => (
                <tr key={e.id} className={e.voidedAt ? 'row--muted' : undefined}>
                  <td className="num">{fmt.date(e.expenseDate)}</td>
                  <td>{catName(e.categoryCode, e.categoryName)}</td>
                  <td>
                    {e.description}
                    {e.voidedAt && (
                      <span style={{ marginLeft: 8 }}>
                        <Badge tone="danger">{t('expenses.voided')}</Badge>
                      </span>
                    )}
                    {e.voidReason && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {e.voidReason}
                      </div>
                    )}
                  </td>
                  <td>
                    {t(`sessions.methods.${e.paymentMethod}` as 'sessions.methods.cash')}
                    {e.shiftId && (
                      <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                        {t('expenses.fromDrawerShort')}
                      </span>
                    )}
                  </td>
                  <td className="muted">{e.createdBy?.name ?? '—'}</td>
                  <td className={`right num ${e.voidedAt ? 'faint' : ''}`}>
                    {fmt.money(e.amountCents)}
                  </td>
                  {canManage && (
                    <td className="right">
                      {!e.voidedAt && (
                        <Button size="sm" variant="ghost" onClick={() => setVoiding(e)}>
                          <Ban size={14} /> {t('expenses.void')}
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
      {creating && (
        <ExpenseDialog categories={cats.data ?? []} onClose={() => setCreating(false)} />
      )}
      {categories && <CategoriesDialog onClose={() => setCategories(false)} />}
      {voiding && <VoidDialog expense={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

// ─── New expense ───────────────────────────────────────────────────────────────
function ExpenseDialog({
  categories,
  onClose,
}: {
  categories: ExpenseCategorySummary[];
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shiftGuard = useShiftGuard();
  const [form, setForm] = useState({
    expenseDate: todayLocal(),
    categoryCode: categories[0]?.code ?? '',
    amount: '',
    paymentMethod: 'cash' as PaymentMethod,
    description: '',
    fromDrawer: true,
  });
  const cents = form.amount.trim() ? parseMoneyInput(form.amount) : null;
  const valid =
    cents !== null && cents > 0 && form.categoryCode && form.description.trim() && form.expenseDate;
  const mutation = useMutation({
    mutationFn: () =>
      api<ExpenseSummary>('/expenses', {
        method: 'POST',
        body: {
          expenseDate: form.expenseDate,
          categoryCode: form.categoryCode,
          amountCents: cents,
          paymentMethod: form.paymentMethod,
          description: form.description.trim(),
          fromDrawer: form.paymentMethod === 'cash' ? form.fromDrawer : false,
        },
      }),
    onSuccess: () => {
      toast.success(t('expenses.saved'));
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => mutation.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const err = mutation.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('expenses.new')}
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
          <Field label={t('common.date')} error={fieldError(err, 'expenseDate')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                type="date"
                value={form.expenseDate}
                onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('expenses.category')} error={fieldError(err, 'categoryCode')}>
            {(id, invalid) => (
              <Select
                id={id}
                aria-invalid={invalid || undefined}
                value={form.categoryCode}
                onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {language === 'sq' ? c.nameSq : c.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid--2">
          <Field
            label={t('receipt.amount')}
            error={form.amount.trim() && cents === null ? t('common.invalid') : undefined}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                autoFocus
                inputMode="decimal"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('sessions.paymentMethod')}>
            {(id, invalid) => (
              <Select
                id={id}
                aria-invalid={invalid || undefined}
                value={form.paymentMethod}
                onChange={(e) =>
                  setForm({ ...form, paymentMethod: e.target.value as PaymentMethod })
                }
              >
                {EXPENSE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('expenses.description')} error={fieldError(err, 'description')}>
          {(id, invalid) => (
            <Textarea
              id={id}
              aria-invalid={invalid || undefined}
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={300}
            />
          )}
        </Field>
        {form.paymentMethod === 'cash' && (
          <Checkbox
            checked={form.fromDrawer}
            onChange={(e) => setForm({ ...form, fromDrawer: e.target.checked })}
            label={t('expenses.fromDrawer')}
            description={t('expenses.fromDrawerHint')}
          />
        )}
      </form>
    </Dialog>
  );
}

// ─── Void ──────────────────────────────────────────────────────────────────────
function VoidDialog({ expense, onClose }: { expense: ExpenseSummary; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api<ExpenseSummary>(`/expenses/${expense.id}/void`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: () => {
      toast.success(t('expenses.voidDone'));
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('expenses.voidTitle')}
      description={t('expenses.voidHint', {
        amount: fmt.money(expense.amountCents),
        description: expense.description,
      })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!reason.trim()}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Ban size={14} /> {t('expenses.void')}
          </Button>
        </>
      }
    >
      <Field label={t('sales.refundReason')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid || undefined}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
          />
        )}
      </Field>
      {expense.shiftId && <p className="muted">{t('expenses.voidDrawerNote')}</p>}
    </Dialog>
  );
}

// ─── Categories ────────────────────────────────────────────────────────────────
function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ code: '', nameEn: '', nameSq: '' });
  const all = useQuery({
    queryKey: ['expenses', 'categories', { includeInactive: true }],
    queryFn: () =>
      api<ExpenseCategorySummary[]>('/expenses/categories', { query: { includeInactive: true } }),
  });
  const create = useMutation({
    mutationFn: () =>
      api<ExpenseCategorySummary>('/expenses/categories', {
        method: 'POST',
        body: {
          code: form.code.trim().toLowerCase(),
          nameEn: form.nameEn.trim(),
          nameSq: form.nameSq.trim() || form.nameEn.trim(),
        },
      }),
    onSuccess: () => {
      toast.success(t('expenses.categorySaved'));
      setForm({ code: '', nameEn: '', nameSq: '' });
      void queryClient.invalidateQueries({ queryKey: ['expenses', 'categories'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const valid = /^[a-z0-9_]{2,40}$/.test(form.code.trim().toLowerCase()) && form.nameEn.trim();
  return (
    <Dialog open onClose={onClose} title={t('expenses.categories')} size="md">
      <div className="stack">
        {all.isLoading && <Loading />}
        {all.data && (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>{t('expenses.code')}</th>
                  <th>English</th>
                  <th>Shqip</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {all.data.map((c) => (
                  <tr key={c.code}>
                    <td className="mono">{c.code}</td>
                    <td>{c.nameEn}</td>
                    <td>{c.nameSq}</td>
                    <td>
                      {c.isSystem && <Badge>{t('expenses.system')}</Badge>}
                      {!c.isActive && <Badge tone="warning">{t('common.inactive')}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <h4 className="subhead">{t('expenses.newCategory')}</h4>
          <div className="grid grid--2">
            <Field
              label={t('expenses.code')}
              hint={t('expenses.codeHint')}
              error={fieldError(create.error, 'code')}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  aria-invalid={invalid || undefined}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="internet"
                />
              )}
            </Field>
            <Field label={language === 'sq' ? 'Emri (anglisht)' : 'Name (English)'}>
              {(id, invalid) => (
                <Input
                  id={id}
                  aria-invalid={invalid || undefined}
                  value={form.nameEn}
                  onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                />
              )}
            </Field>
          </div>
          <Field label={language === 'sq' ? 'Emri (shqip)' : 'Name (Albanian)'} optional>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                value={form.nameSq}
                onChange={(e) => setForm({ ...form, nameSq: e.target.value })}
              />
            )}
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="primary" type="submit" disabled={!valid} loading={create.isPending}>
              <Plus size={14} /> {t('common.add')}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
