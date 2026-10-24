/**
 * 0.19.1: the extras of a product (e.g. "Tost" with "Kackavall" at an extra price). It is its own
 * card with its own Save, so it does not touch the product form's save. Saving replaces the whole
 * list; an extra saved again under the same name keeps its id, so parked sales still resolve it.
 * The product line's extras are chosen at the till (POS), so an extra with no product is never sold
 * on its own.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { parseMoneyInput, type ProductAddonSummary, type ProductSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Field, Input } from '../ui/primitives';

interface Draft {
  name: string;
  price: string;
}

const MAX_EXTRAS = 30;

export function ProductExtrasEditor({
  productId,
  addons,
}: {
  productId: string;
  addons: ProductAddonSummary[];
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft whenever the saved extras change (after a save or a reload of the product).
  const savedKey = addons.map((a) => `${a.name}:${a.priceCents}`).join('|');
  useEffect(() => {
    setRows(addons.map((a) => ({ name: a.name, price: (a.priceCents / 100).toFixed(2) })));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, savedKey]);

  const save = useMutation({
    mutationFn: (payload: { name: string; priceCents: number }[]) =>
      api<ProductSummary>(`/products/${productId}/addons`, {
        method: 'PUT',
        body: { addons: payload },
      }),
    onSuccess: () => {
      toast.success(t('products.extrasSaved'));
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const onSave = () => {
    const payload: { name: string; priceCents: number }[] = [];
    for (const r of rows) {
      const name = r.name.trim();
      if (!name && !r.price.trim()) continue; // an empty row is ignored
      const cents = parseMoneyInput(r.price);
      if (!name || name.length > 60 || cents === null || cents < 0) {
        setError(t('products.extrasInvalid'));
        return;
      }
      payload.push({ name, priceCents: cents });
    }
    if (payload.length > MAX_EXTRAS) {
      setError(t('products.extrasInvalid'));
      return;
    }
    setError(null);
    save.mutate(payload);
  };

  const dirty =
    rows.map((r) => `${r.name.trim()}:${r.price.trim()}`).join('|') !==
    addons.map((a) => `${a.name}:${(a.priceCents / 100).toFixed(2)}`).join('|');

  return (
    // Enter inside this card must not submit the product form around it.
    <div
      className="card stack"
      data-testid="product-extras"
      style={{ padding: 12 }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.preventDefault();
      }}
    >
      <div className="subhead">{t('products.extras')}</div>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        {t('products.extrasHint')}
      </p>
      {rows.length === 0 && <p className="faint">{t('products.extrasNone')}</p>}
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label={t('products.extraName')} className="grow">
            {(id) => (
              <Input
                id={id}
                value={r.name}
                maxLength={60}
                onChange={(e) =>
                  setRows((list) =>
                    list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
                data-testid="product-extra-name"
              />
            )}
          </Field>
          <Field label={t('products.extraPrice')} className="w-24">
            {(id) => (
              <Input
                id={id}
                value={r.price}
                inputMode="decimal"
                placeholder="0.00"
                className="num"
                onChange={(e) =>
                  setRows((list) =>
                    list.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)),
                  )
                }
                data-testid="product-extra-price"
              />
            )}
          </Field>
          <button
            type="button"
            className="chip__x"
            aria-label={t('common.delete')}
            onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
        <Button
          type="button"
          onClick={() => setRows((list) => [...list, { name: '', price: '' }])}
          disabled={rows.length >= MAX_EXTRAS}
        >
          <Plus size={14} /> {t('products.addExtra')}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onSave}
          loading={save.isPending}
          disabled={!dirty && !error}
          data-testid="product-extras-save"
        >
          {t('products.saveExtras')}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ fontSize: 13, margin: 0, color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          {rows
            .filter((r) => r.name.trim() && parseMoneyInput(r.price) !== null)
            .map((r) => `${r.name.trim()} +${fmt.money(parseMoneyInput(r.price) ?? 0)}`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
