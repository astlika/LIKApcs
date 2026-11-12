/**
 * 0.19.0: an off-inventory line at the till — a name and a price typed in, no product and no stock
 * (a service, a repair, something not in the catalogue). The line uses the default tax rate and
 * its price includes tax, exactly like a catalogue product. Enter adds it.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { parseMoneyInput } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';

export function FreeItemDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (item: { name: string; unitPriceCents: number; quantityMilli: number }) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    const cents = price.trim() === '' ? null : parseMoneyInput(price);
    const quantity = Number.parseInt(qty, 10);
    if (!trimmed || trimmed.length > 120) return setError(t('pos.freeItemNameInvalid'));
    if (cents === null || cents < 0 || cents > 100_000_00)
      return setError(t('pos.freeItemPriceInvalid'));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)
      return setError(t('pos.freeItemQtyInvalid'));
    onAdd({ name: trimmed, unitPriceCents: cents, quantityMilli: quantity * 1000 });
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('pos.freeItem')}
      description={t('pos.freeItemHint')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button variant="primary" onClick={submit} data-testid="free-item-add">
            <Plus size={14} /> {t('pos.freeItemAdd')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('pos.freeItemName')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              maxLength={120}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={onEnter}
              data-testid="free-item-name"
            />
          )}
        </Field>
        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label={t('pos.freeItemPrice')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={onEnter}
                  data-testid="free-item-price"
                />
              )}
            </Field>
          </div>
          <div style={{ maxWidth: 110 }}>
            <Field label={t('pos.qty')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={999}
                  value={qty}
                  onChange={(e) => {
                    setQty(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={onEnter}
                />
              )}
            </Field>
          </div>
        </div>
        {error && (
          <p role="alert" style={{ fontSize: 13, margin: 0, color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
