import { useQuery } from '@tanstack/react-query';
import type { SettingsMap } from '@likapcs/shared';
import { api } from './api';

/**
 * Optional till features (Settings → Printing & POS). All default OFF; until the settings load,
 * every flag reads as off so the till never shows a hidden feature by mistake.
 */
export function usePosFlags() {
  const settings = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: () => api<SettingsMap>('/settings'),
  });
  const d = settings.data;
  return {
    offInventory: d?.['pos.off_inventory_items'] === true,
    timeItems: d?.['pos.time_items'] === true,
    installments: d?.['pos.installments'] === true,
  };
}
