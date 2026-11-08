import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, type CustomerSummary, type Paginated } from '@likapcs/shared';
import { api, errorText } from '../api';
import { can, useMe } from '../me';
import { useDebounced } from '../useDebounced';
import { useNotify } from '../notify';
import { useT } from '../i18n';
import { Btn, Field, Notice } from './ui';

/** Pick a customer by name or phone. Used for POS sales, PC bills and debts on credit. */
export function CustomerPicker({
  selected,
  onSelect,
  label,
  required = false,
}: {
  selected: CustomerSummary | null;
  onSelect: (c: CustomerSummary | null) => void;
  label?: string;
  required?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const me = useMe(true);
  const canCreate = can(me.data, PERMISSIONS.CUSTOMERS_MANAGE);
  const q = useDebounced(text.trim(), 250);
  const customers = useQuery({
    queryKey: ['phone', 'customers', q],
    queryFn: () => api<Paginated<CustomerSummary>>(`/customers?${new URLSearchParams({ pageSize: '8', q }).toString()}`),
    enabled: q.length > 0,
  });

  if (selected) {
    return (
      <div className="field">
        <span className="field__label">Klienti</span>
        <div className="picked">
          <span>
            <strong>{selected.name}</strong>
            <span className="muted small block">{selected.code}</span>
          </span>
          <button type="button" className="ghost" onClick={() => onSelect(null)}>
            {t('Hiq')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <span className="field__label">{required ? t('Klienti') : (label ?? t('Klienti (opsional)'))}</span>
      <input
        type="search"
        placeholder={t('Kërko klientin me emër ose telefon')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
      />
      {canCreate && !adding && (
        <button type="button" className="ghost small-btn" onClick={() => setAdding(true)}>
          {t('+ Klient i ri')}
        </button>
      )}
      {adding && <NewCustomer name={text.trim()} onCancel={() => setAdding(false)} onCreated={(c) => { setAdding(false); onSelect(c); }} />}
      {text.trim() && customers.data && (
        <ul className="list list--tight">
          {customers.data.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="list-btn" onClick={() => onSelect(c)}>
                <span>{c.name}</span>
                <span className="muted small">{c.phone ?? c.code}</span>
              </button>
            </li>
          ))}
          {customers.data.items.length === 0 && <li className="muted small">{t('Asnjë klient.')}</li>}
        </ul>
      )}
    </div>
  );
}

/** Creates a customer from the sale screen (name and phone). The new customer is picked right away. */
function NewCustomer({
  name,
  onCancel,
  onCreated,
}: {
  name: string;
  onCancel: () => void;
  onCreated: (c: CustomerSummary) => void;
}) {
  const notify = useNotify();
  const t = useT();
  const qc = useQueryClient();
  const [fullName, setFullName] = useState(name);
  const [phone, setPhone] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<CustomerSummary>('/customers', {
        method: 'POST',
        body: { name: fullName.trim(), phone: phone.trim() || null, status: 'active' },
      }),
    onSuccess: (c) => {
      notify(t('Klienti u shtua: {name}', { name: c.name }));
      void qc.invalidateQueries({ queryKey: ['phone', 'customers'] });
      onCreated(c);
    },
  });
  return (
    <div className="card card--flat stack-sm">
      <Field label={t('Emri')}>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} autoFocus />
      </Field>
      <Field label={t('Telefoni (opsional)')}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />
      </Field>
      {create.isError && <Notice tone="danger">{errorText(create.error)}</Notice>}
      <div className="grid-2">
        <Btn variant="ghost" onClick={onCancel}>
          {t('Anulo')}
        </Btn>
        <Btn onClick={() => create.mutate()} disabled={fullName.trim() === '' || create.isPending}>
          {create.isPending ? t('Duke ruajtur…') : t('Ruaj klientin')}
        </Btn>
      </div>
    </div>
  );
}
