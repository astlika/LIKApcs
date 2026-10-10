/**
 * Suppliers: searchable list with purchase totals and open balance, create / edit dialog and
 * deactivation (suppliers are never deleted — purchases reference them).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Truck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PERMISSIONS, type SupplierSummary } from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Switch,
  Textarea,
} from '../components/ui/primitives';

export function SuppliersPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.SUPPLIERS_MANAGE);
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<SupplierSummary | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<SupplierSummary | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const list = useQuery({
    queryKey: ['suppliers', { q, includeInactive }],
    queryFn: () =>
      api<SupplierSummary[]>('/suppliers', {
        query: { q: q.trim() || undefined, includeInactive: includeInactive || undefined },
      }),
    placeholderData: (prev) => prev,
  });
  const deactivate = useMutation({
    mutationFn: (s: SupplierSummary) => api(`/suppliers/${s.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('suppliers.deactivated'));
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      setDeactivating(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <>
      <PageHeader
        title={t('suppliers.title')}
        subtitle={t('suppliers.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('suppliers.new')}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('suppliers.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 260 }}
          aria-label={t('suppliers.search')}
        />
        <Switch
          checked={includeInactive}
          onChange={setIncludeInactive}
          label={t('suppliers.showInactive')}
        />
      </div>
      {list.isLoading && <Loading />}
      {list.isSuccess && list.data.length === 0 && (
        <EmptyState icon={<Truck size={22} />} title={t('suppliers.empty')} />
      )}
      {list.isSuccess && list.data.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('suppliers.contact')}</th>
                <th className="right">{t('suppliers.purchases')}</th>
                <th className="right">{t('suppliers.purchased')}</th>
                <th className="right">{t('suppliers.balanceDue')}</th>
                <th>{t('suppliers.lastPurchase')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className={s.isActive ? undefined : 'row--muted'}>
                  <td>
                    <div className="stack" style={{ gap: 2 }}>
                      <strong>{s.name}</strong>
                      {s.businessName && <span className="faint">{s.businessName}</span>}
                    </div>
                    {!s.isActive && <Badge>{t('common.inactive')}</Badge>}
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 2 }}>
                      {s.contactPerson && <span>{s.contactPerson}</span>}
                      {s.phone && <span className="faint mono">{s.phone}</span>}
                      {s.email && <span className="faint">{s.email}</span>}
                    </div>
                  </td>
                  <td className="right num">
                    <Link to={`/purchases?supplierId=${s.id}`}>{s.purchasesCount}</Link>
                  </td>
                  <td className="right num">{fmt.money(s.purchasedCents)}</td>
                  <td className={`right num ${s.balanceDueCents > 0 ? 'text-warning' : ''}`}>
                    {fmt.money(s.balanceDueCents)}
                  </td>
                  <td className="faint">{fmt.date(s.lastPurchaseAt)}</td>
                  <td className="right">
                    {canManage && (
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                          <Pencil size={13} /> {t('common.edit')}
                        </Button>
                        {s.isActive && (
                          <Button size="sm" variant="ghost" onClick={() => setDeactivating(s)}>
                            {t('suppliers.deactivate')}
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <SupplierDialog
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deactivating && (
        <ConfirmDialog
          open
          title={t('suppliers.deactivate')}
          body={t('suppliers.deactivateConfirm', { name: deactivating.name })}
          confirmLabel={t('suppliers.deactivate')}
          danger
          loading={deactivate.isPending}
          onConfirm={() => deactivate.mutate(deactivating)}
          onClose={() => setDeactivating(null)}
        />
      )}
    </>
  );
}

interface SupplierForm {
  name: string;
  businessName: string;
  taxId: string;
  phone: string;
  email: string;
  address: string;
  contactPerson: string;
  notes: string;
  isActive: boolean;
}

function SupplierDialog({
  supplier,
  onClose,
}: {
  supplier: SupplierSummary | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SupplierForm>({
    name: supplier?.name ?? '',
    businessName: supplier?.businessName ?? '',
    taxId: supplier?.taxId ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    notes: supplier?.notes ?? '',
    isActive: supplier?.isActive ?? true,
  });
  const valid = form.name.trim().length > 0;
  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        businessName: form.businessName.trim() || null,
        taxId: form.taxId.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        contactPerson: form.contactPerson.trim() || null,
        notes: form.notes.trim() || null,
        isActive: form.isActive,
      };
      return supplier
        ? api<SupplierSummary>(`/suppliers/${supplier.id}`, { method: 'PATCH', body })
        : api<SupplierSummary>('/suppliers', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(t('suppliers.saved'));
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const err = mutation.error;
  const text = (key: keyof SupplierForm, label: string, extra?: { mono?: boolean }) => (
    <Field label={label} error={fieldError(err, key)}>
      {(id, invalid) => (
        <Input
          id={id}
          aria-invalid={invalid || undefined}
          className={extra?.mono ? 'mono' : undefined}
          value={form[key] as string}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={supplier ? t('suppliers.edit') : t('suppliers.new')}
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
          {text('businessName', t('suppliers.businessName'))}
        </div>
        <div className="grid grid--2">
          {text('contactPerson', t('suppliers.contactPerson'))}
          {text('taxId', t('suppliers.taxId'), { mono: true })}
        </div>
        <div className="grid grid--2">
          {text('phone', t('suppliers.phone'), { mono: true })}
          {text('email', t('suppliers.email'))}
        </div>
        {text('address', t('suppliers.address'))}
        <Field label={t('common.notes')} error={fieldError(err, 'notes')}>
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
        {supplier && (
          <Switch
            checked={form.isActive}
            onChange={(v) => setForm({ ...form, isActive: v })}
            label={t('common.active')}
          />
        )}
      </form>
    </Dialog>
  );
}
