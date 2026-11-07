/**
 * 0.19.1: a product with extras (e.g. "Tost" with "Kackavall" for an extra price). The cashier
 * ticks the extras and adds the line; each combination of extras is its own sale line. Enter adds
 * the product with the ticked extras (none ticked = the plain product).
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProductSummary } from '@likapcs/shared';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { unitPriceOf } from '../../lib/cart';
import { Button, Checkbox, Dialog, Kbd } from '../ui/primitives';

export function AddonDialog({
  product,
  onClose,
  onAdd,
}: {
  product: ProductSummary;
  onClose: () => void;
  onAdd: (addonIds: string[]) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [picked, setPicked] = useState<string[]>([]);
  const extrasTotal = (product.addons ?? [])
    .filter((a) => picked.includes(a.id))
    .reduce((n, a) => n + a.priceCents, 0);
  const unit = unitPriceOf(product) + extrasTotal;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAdd(picked);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={product.name}
      description={t('pos.addonsHint')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button variant="primary" onClick={() => onAdd(picked)} data-testid="addon-add">
            <Plus size={14} /> {t('pos.addonsAdd')} {fmt.money(unit)} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" onKeyDown={onEnter}>
        {(product.addons ?? []).map((a) => (
          <Checkbox
            key={a.id}
            checked={picked.includes(a.id)}
            onChange={() => toggle(a.id)}
            label={a.name}
            description={`+ ${fmt.money(a.priceCents)}`}
          />
        ))}
      </div>
    </Dialog>
  );
}
