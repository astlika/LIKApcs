/**
 * 0.20.0: named layouts for the customer screen. "Apply" loads a preset into the Settings draft
 * (press Save to send it to the PCs — one PATCH /settings, like every other change on the page).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LAYOUT_PRESET_NAME_MAX, type LayoutPresetSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Card, Field, Input } from '../ui/primitives';

export function LayoutPresetsCard({
  canManage,
  layout,
  onApply,
}: {
  canManage: boolean;
  /** The layout settings as they stand now (draft included). */
  layout: Record<string, unknown>;
  /** Loads a preset's values into the Settings draft. */
  onApply: (settings: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const presets = useQuery({
    queryKey: ['client-layout-presets'],
    queryFn: () => api<LayoutPresetSummary[]>('/client/layout-presets'),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['client-layout-presets'] });
  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      toast.error(t('settings.client.presets.nameTaken'));
    } else {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api<LayoutPresetSummary>('/client/layout-presets', {
        method: 'POST',
        body: { name: name.trim(), settings: layout },
      }),
    onSuccess: () => {
      setName('');
      toast.success(t('settings.client.presets.saved'));
      refresh();
    },
    onError: failed,
  });

  const overwrite = useMutation({
    mutationFn: (preset: LayoutPresetSummary) =>
      api<LayoutPresetSummary>(`/client/layout-presets/${preset.id}`, {
        method: 'PATCH',
        body: { name: preset.name, settings: layout },
      }),
    onSuccess: () => {
      toast.success(t('settings.client.presets.updated'));
      refresh();
    },
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/client/layout-presets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmId(null);
      toast.success(t('settings.client.presets.deleted'));
      refresh();
    },
    onError: failed,
  });

  const nameOk = name.trim().length > 0 && name.trim().length <= LAYOUT_PRESET_NAME_MAX;

  return (
    <Card
      title={t('settings.client.presets.title')}
      subtitle={t('settings.client.presets.hint')}
      testId="layout-presets"
    >
      <div className="stack">
        {canManage && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label={t('settings.client.presets.nameLabel')}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  maxLength={LAYOUT_PRESET_NAME_MAX}
                  placeholder={t('settings.client.presets.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="layout-preset-name"
                />
              )}
            </Field>
            <Button
              variant="primary"
              disabled={!nameOk || create.isPending}
              onClick={() => create.mutate()}
              data-testid="layout-preset-save"
            >
              {t('settings.client.presets.saveCurrent')}
            </Button>
          </div>
        )}

        {presets.data && presets.data.length === 0 && (
          <p className="muted">{t('settings.client.presets.empty')}</p>
        )}

        {(presets.data ?? []).map((preset) => (
          <div
            key={preset.id}
            className="row"
            style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
            data-testid="layout-preset-row"
          >
            <strong style={{ flex: 1, minWidth: 140 }}>{preset.name}</strong>
            <Button onClick={() => onApply(preset.settings)} disabled={!canManage}>
              {t('settings.client.presets.apply')}
            </Button>
            {canManage && (
              <Button onClick={() => overwrite.mutate(preset)} disabled={overwrite.isPending}>
                {t('settings.client.presets.overwrite')}
              </Button>
            )}
            {canManage &&
              (confirmId === preset.id ? (
                <Button
                  variant="danger"
                  onClick={() => remove.mutate(preset.id)}
                  disabled={remove.isPending}
                >
                  {t('common.confirm')}
                </Button>
              ) : (
                <Button onClick={() => setConfirmId(preset.id)}>
                  {t('settings.client.presets.delete')}
                </Button>
              ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
