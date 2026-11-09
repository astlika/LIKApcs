/**
 * 0.32.0 — the badges of one PC (V.I.P, tournament, premium, birthday). Staff set them by hand;
 * nothing sets them on its own. "Reserved" is not a badge here: a reservation shows it by itself.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STATION_BADGES, type StationBadge, type StationSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Checkbox, Dialog } from '../ui/primitives';

export function BadgesDialog({ station, onClose }: { station: StationSummary; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<StationBadge[]>(station.badges);

  const save = useMutation({
    mutationFn: () =>
      api<StationSummary>(`/stations/${station.id}/badges`, {
        method: 'PUT',
        body: { badges: picked },
      }),
    onSuccess: () => {
      toast.success(t('board.badgesSaved', { code: station.code }));
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const toggle = (b: StationBadge) =>
    setPicked((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]));

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t('board.badgesTitle')} · ${station.code}`}
      description={t('board.badgesHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="badge-pick">
        {STATION_BADGES.map((b) => (
          <Checkbox
            key={b}
            checked={picked.includes(b)}
            onChange={() => toggle(b)}
            label={t(`board.badges.${b}`)}
            description={t(`board.badgeHelp.${b}`)}
          />
        ))}
      </div>
    </Dialog>
  );
}
