/**
 * Updates dashboard: which version runs on the main PC and on every client PC, the newest release
 * published on GitHub, one-click "update all clients" and the history of update attempts.
 *
 * Installing is still done by the signed Tauri updater inside each app (see `UpdatePanel` for the
 * Admin/main PC); this page only reports and triggers.
 */
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  History,
  MonitorSmartphone,
  RefreshCw,
  Rocket,
} from 'lucide-react';
import {
  PERMISSIONS,
  type ClientUpdatePushResponse,
  type ClientUpdateRow,
  type UpdateStatus,
  type UpdatesOverview,
} from '@likapcs/shared';
import { UpdatePanel } from '../components/UpdatePanel';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  PageHeader,
  StatTile,
} from '../components/ui/primitives';
import { useI18n } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { GITHUB_RELEASES_URL } from '../lib/updater';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

const ADMIN_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';
const ACTIVE: UpdateStatus[] = ['pending', 'downloading', 'downloaded', 'installing'];

function statusTone(status: UpdateStatus): 'success' | 'danger' | 'info' | 'warning' | 'default' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'rolled_back') return 'warning';
  if (ACTIVE.includes(status)) return 'info';
  return 'default';
}

function stateTone(state: ClientUpdateRow['state']): 'success' | 'warning' | 'danger' | 'default' {
  if (state === 'current') return 'success';
  if (state === 'outdated') return 'warning';
  if (state === 'newer') return 'danger';
  return 'default';
}

export function UpdatesPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.UPDATES_MANAGE);

  const overview = useQuery({
    queryKey: ['updates'],
    queryFn: () => api<UpdatesOverview>('/system/updates'),
    refetchInterval: 15_000,
  });
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
  const check = useMutation({
    mutationFn: () => api<UpdatesOverview>('/system/updates/check', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      queryClient.setQueryData(['updates'], data);
      if (data.check.ok) toast.success(t('updates.checked'));
      else toast.error(t('updates.checkFailed', { error: data.check.error ?? '' }));
    },
    onError,
  });
  const push = useMutation({
    mutationFn: () =>
      api<ClientUpdatePushResponse>('/system/updates/push', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      if (r.outdated === 0) toast.toast('info', t('updates.pushNone'));
      else toast.success(t('updates.pushed', { sent: r.sent, outdated: r.outdated }));
      void queryClient.invalidateQueries({ queryKey: ['updates'] });
    },
    onError,
  });

  const row = (label: string, value: ReactNode) => (
    <div
      className="row row--between"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', gap: 12 }}
    >
      <span className="muted">{label}</span>
      <span className="num" style={{ textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );

  const data = overview.data;
  const latestAdmin = data?.latest.admin ?? null;
  const latestClient = data?.latest.client ?? null;
  const outdatedOnline =
    data?.clients.filter((c) => c.state === 'outdated' && c.online).length ?? 0;

  return (
    <>
      <PageHeader
        title={t('updates.title')}
        subtitle={t('updates.subtitle')}
        actions={
          canManage && (
            <>
              <Button onClick={() => check.mutate()} loading={check.isPending}>
                <RefreshCw size={14} /> {t('updates.check')}
              </Button>
              <Button
                variant="primary"
                onClick={() => push.mutate()}
                loading={push.isPending}
                disabled={!data || data.counts.outdated === 0}
                title={data && data.counts.outdated === 0 ? t('updates.pushNone') : undefined}
              >
                <Rocket size={14} /> {t('updates.pushAll')}
              </Button>
            </>
          )
        }
      />

      {overview.isLoading && <Loading />}

      {data && (
        <>
          <div className="grid grid--stats" style={{ marginBottom: 16 }}>
            <StatTile
              label={t('updates.tiles.mainPc')}
              value={`v${data.server.version}`}
              sub={t('updates.tiles.mainPcSub', {
                admin: ADMIN_VERSION,
                schema: data.server.schemaVersion,
              })}
              tone={data.latest.serverUpdateAvailable ? 'warning' : 'success'}
              icon={<MonitorSmartphone size={18} />}
            />
            <StatTile
              label={t('updates.tiles.latest')}
              value={latestAdmin ? `v${latestAdmin.version}` : t('common.unknown')}
              sub={
                data.check.checkedAt
                  ? t('updates.tiles.checkedAt', { when: fmt.relative(data.check.checkedAt) })
                  : t('updates.tiles.neverChecked')
              }
              tone={data.check.ok === false && !latestAdmin ? 'danger' : undefined}
              icon={<ArrowUpCircle size={18} />}
            />
            <StatTile
              label={t('updates.tiles.clients')}
              value={`${data.counts.online} / ${data.counts.clients}`}
              sub={t('updates.tiles.clientsSub')}
            />
            <StatTile
              label={t('updates.tiles.outdated')}
              value={String(data.counts.outdated)}
              sub={
                data.counts.updating > 0
                  ? t('updates.tiles.updating', { n: data.counts.updating })
                  : t('updates.tiles.target', { version: data.targetVersion })
              }
              tone={data.counts.outdated > 0 ? 'warning' : 'success'}
            />
          </div>

          {data.check.ok === false && (
            <Alert tone="warning" icon={<AlertTriangle size={18} />}>
              {t('updates.checkFailed', { error: data.check.error ?? '' })}
            </Alert>
          )}
          {data.latest.serverUpdateAvailable && latestAdmin && (
            <Alert tone="info" icon={<ArrowUpCircle size={18} />}>
              <strong>{t('updates.serverUpdate', { version: latestAdmin.version })}</strong>{' '}
              {t('updates.serverUpdateHint')}
              {latestAdmin.releaseNotes && (
                <div className="faint" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                  {latestAdmin.releaseNotes.slice(0, 400)}
                </div>
              )}
            </Alert>
          )}
          {!data.latest.serverUpdateAvailable && data.check.ok && (
            <Alert tone="success" icon={<CheckCircle2 size={18} />}>
              {t('updates.allCurrent')}
            </Alert>
          )}

          <div className="grid grid--2" style={{ marginTop: 16, alignItems: 'start' }}>
            <UpdatePanel />
            <Card title={t('updates.policy.title')}>
              {row(
                t('updates.policy.channel'),
                t(`updates.policy.channels.${data.policy.channel}`),
              )}
              {row(
                t('updates.policy.checkOnStartup'),
                data.policy.checkOnStartup ? t('common.yes') : t('common.no'),
              )}
              {row(
                t('updates.policy.clientPolicy'),
                <>
                  {t(`updates.policy.clientPolicies.${data.policy.clientPolicy}`)}
                  {data.policy.clientPolicy === 'maintenance_window' && (
                    <span className="faint"> · {data.policy.maintenanceWindow}</span>
                  )}
                </>,
              )}
              {row(
                t('updates.policy.feed'),
                <>
                  <a href={GITHUB_RELEASES_URL} target="_blank" rel="noreferrer">
                    GitHub Releases <ExternalLink size={12} />
                  </a>
                  {latestClient && (
                    <span className="faint">
                      {' '}
                      · {t('updates.policy.clientLatest', { version: latestClient.version })}
                      {latestClient.signed ? ` · ${t('updates.policy.signed')}` : ''}
                    </span>
                  )}
                </>,
              )}
              <p className="faint" style={{ marginTop: 10 }}>
                {t('updates.policy.hint')}{' '}
                <Link to="/settings?tab=system">{t('nav.settings')}</Link>
              </p>
            </Card>
          </div>

          <h2 className="subhead" style={{ marginTop: 24, marginBottom: 10 }}>
            {t('updates.clients.title')}
            <span className="faint" style={{ fontWeight: 400, marginLeft: 8 }}>
              {t('updates.clients.hint', { version: data.targetVersion })}
            </span>
          </h2>
          {data.clients.length === 0 && (
            <EmptyState icon={<MonitorSmartphone size={22} />} title={t('updates.clients.empty')} />
          )}
          {data.clients.length > 0 && (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('updates.clients.station')}</th>
                    <th>{t('updates.clients.hostname')}</th>
                    <th>{t('updates.clients.version')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('updates.clients.lastSeen')}</th>
                    <th>{t('updates.clients.lastUpdate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr key={c.deviceId} data-testid="update-client-row">
                      <td>
                        <strong>{c.stationCode ?? '—'}</strong>
                        {c.stationName && <span className="faint"> · {c.stationName}</span>}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {c.hostname ?? '—'}
                      </td>
                      <td className="num">{c.appVersion ? `v${c.appVersion}` : '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <Badge tone={stateTone(c.state)}>{t(`updates.state.${c.state}`)}</Badge>
                          <Badge tone={c.online ? 'success' : 'default'}>
                            {c.online ? t('stations.online') : t('stations.offline')}
                          </Badge>
                        </div>
                      </td>
                      <td className="muted">
                        {c.lastSeenAt ? fmt.relative(c.lastSeenAt) : t('common.never')}
                      </td>
                      <td>
                        {c.lastUpdate ? (
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <Badge tone={statusTone(c.lastUpdate.status)}>
                              {t(`updates.status.${c.lastUpdate.status}`)}
                            </Badge>
                            <span className="faint num">
                              → v{c.lastUpdate.toVersion} · {fmt.relative(c.lastUpdate.startedAt)}
                            </span>
                            {c.lastUpdate.errorMessage && (
                              <span
                                className="faint"
                                style={{ fontSize: 12 }}
                                title={c.lastUpdate.errorMessage}
                              >
                                {c.lastUpdate.errorMessage.slice(0, 60)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.counts.outdated > outdatedOnline && (
            <p className="faint" style={{ marginTop: 8 }}>
              {t('updates.clients.offlineNote', { n: data.counts.outdated - outdatedOnline })}
            </p>
          )}

          <h2 className="subhead" style={{ marginTop: 24, marginBottom: 10 }}>
            <History size={16} /> {t('updates.history.title')}
          </h2>
          {data.history.length === 0 && <EmptyState title={t('updates.history.empty')} />}
          {data.history.length > 0 && (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('updates.history.component')}</th>
                    <th>{t('updates.history.where')}</th>
                    <th>{t('updates.history.change')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('updates.history.initiatedBy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id} data-testid="update-history-row">
                      <td className="num">{fmt.dateTime(h.startedAt)}</td>
                      <td>{t(`updates.component.${h.component}`)}</td>
                      <td>
                        {h.stationCode ?? (h.component === 'client' ? '—' : t('updates.mainPc'))}
                      </td>
                      <td className="num">
                        {h.fromVersion ? `v${h.fromVersion} → ` : ''}v{h.toVersion}
                      </td>
                      <td>
                        <Badge tone={statusTone(h.status)}>{t(`updates.status.${h.status}`)}</Badge>
                        {h.errorMessage && (
                          <div className="faint" style={{ fontSize: 12 }} title={h.errorMessage}>
                            {h.errorMessage.slice(0, 80)}
                          </div>
                        )}
                      </td>
                      <td className="muted">
                        {h.initiatedByName ??
                          (h.trigger === 'command'
                            ? t('updates.history.byCommand')
                            : h.trigger === 'incompatible'
                              ? t('updates.history.byIncompatible')
                              : t('updates.history.automatic'))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
