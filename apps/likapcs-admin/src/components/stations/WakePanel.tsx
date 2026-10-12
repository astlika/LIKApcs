/**
 * Wake-on-LAN block of the PC details (0.7.0): readiness badge (from the adapters the client
 * reported), the MAC the server will address, and the two actions — "Power on" for an offline PC
 * and "Enable Wake-on-LAN" for an online one (sends `wol.configure`; the PC may show a UAC
 * prompt). The BIOS side can only be documented, so the hint stays visible.
 */
import { useMutation } from '@tanstack/react-query';
import { CircleHelp, Zap } from 'lucide-react';
import {
  PERMISSIONS,
  wakeReadiness,
  type StationCommandResponse,
  type StationSummary,
  type StationWakeResponse,
  type WakeIssue,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { Badge, Button } from '../ui/primitives';

export function WakePanel({
  station,
  onChanged,
}: {
  station: StationSummary;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const device = station.device;
  const canPower = can(PERMISSIONS.STATIONS_POWER);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const readiness = wakeReadiness(device?.hardware, device?.lastIp);
  const online = !!device?.online;
  const issueText = (issues: WakeIssue[]) =>
    issues.map((i) => t(`stations.wake.issue.${i}`)).join(', ');

  const wake = useMutation({
    mutationFn: () => api<StationWakeResponse>(`/stations/${station.id}/wake`, { method: 'POST' }),
    onSuccess: (r) => {
      if (r.warnings.length === 0) toast.success(t('stations.wake.sent', { code: r.code }));
      else
        toast.toast(
          'warning',
          t('stations.wake.sentWarn', { code: r.code, issues: issueText(r.warnings) }),
        );
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const configure = useMutation({
    mutationFn: () =>
      api<StationCommandResponse>(`/stations/${station.id}/command`, {
        method: 'POST',
        body: { command: 'wol.configure' },
      }),
    onSuccess: (r) => {
      if (r.ok) toast.toast('info', t('stations.wake.configureSent'));
      else toast.error(t('stations.commandFailed', { error: r.error ?? '' }));
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  if (!device) return null;
  const tone = readiness.ready ? 'success' : readiness.mac ? 'warning' : 'default';
  const label = readiness.ready
    ? t('stations.wake.ready')
    : readiness.mac
      ? t('stations.wake.notReady')
      : t('stations.wake.unknown');
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="wake-panel" data-ready={readiness.ready}>
      <div className="row row--between">
        <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Zap size={14} /> {t('stations.wake.title')}
          <span title={t('stations.wake.configureHint')} style={{ display: 'inline-flex' }}>
            <CircleHelp size={13} className="faint" />
          </span>
        </span>
        <Badge tone={tone} dot={readiness.ready}>
          {label}
        </Badge>
      </div>
      <div className="row row--between">
        <span className="muted">{t('stations.wake.mac')}</span>
        <span className="mono" data-testid="wake-mac">
          {readiness.mac ?? '—'}
          {readiness.adapter?.name && <small className="faint"> · {readiness.adapter.name}</small>}
        </span>
      </div>
      {readiness.issues.length > 0 && (
        <div className="faint" style={{ fontSize: 12 }} data-testid="wake-issues">
          {readiness.mac ? issueText(readiness.issues) : t('stations.wake.noMac')}
        </div>
      )}
      <div className="row row--wrap">
        {canPower && !online && (
          <Button
            size="sm"
            variant="primary"
            disabled={!readiness.mac}
            loading={wake.isPending}
            onClick={() => wake.mutate()}
            data-testid="wake-now"
          >
            <Zap size={14} /> {t('stations.wake.action')}
          </Button>
        )}
        {canControl && online && (
          <Button
            size="sm"
            loading={configure.isPending}
            onClick={() => configure.mutate()}
            title={t('stations.wake.configureHint')}
            data-testid="wake-configure"
          >
            <Zap size={14} /> {t('stations.wake.configure')}
          </Button>
        )}
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        {t('stations.wake.biosHint')}
      </div>
    </div>
  );
}
