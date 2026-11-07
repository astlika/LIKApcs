import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CustomerSummary, Paginated } from '@likapcs/shared';
import { api } from '../api';
import { useDebounced } from '../useDebounced';

/** Pick a customer by name or phone. Used for POS sales, PC bills and debts on credit. */
export function CustomerPicker({
  selected,
  onSelect,
  label = 'Klienti (opsional)',
  required = false,
}: {
  selected: CustomerSummary | null;
  onSelect: (c: CustomerSummary | null) => void;
  label?: string;
  required?: boolean;
}) {
  const [text, setText] = useState('');
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
            Hiq
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <span className="field__label">{required ? label.replace(' (opsional)', '') : label}</span>
      <input
        type="search"
        placeholder="Kërko klientin me emër ose telefon"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
      />
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
          {customers.data.items.length === 0 && <li className="muted small">Asnjë klient.</li>}
        </ul>
      )}
    </div>
  );
}
