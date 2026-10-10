/**
 * Backups: where the archives live, the daily schedule, back up now, download / upload archives
 * and — behind a password re-check and an explicit acknowledgement — restore one.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  Download,
  FolderOpen,
  HardDriveDownload,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  PERMISSIONS,
  type BackupSummary,
  type BackupsResponse,
  type RestoreResult,
} from '@likapcs/shared';
import { api, ApiError, apiDownload, apiUpload } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  StatTile,
} from '../components/ui/primitives';

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function BackupsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.BACKUPS_MANAGE);
  const [restoring, setRestoring] = useState<BackupSummary | null>(null);
  const [deleting, setDeleting] = useState<BackupSummary | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ['backups', { showDeleted }],
    queryFn: () =>
      api<BackupsResponse>('/backups', { query: { includeDeleted: showDeleted || undefined } }),
    refetchInterval: 30_000,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['backups'] });
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));

  const create = useMutation({
    mutationFn: () => api<BackupSummary>('/backups', { method: 'POST', body: {} }),
    onSuccess: (b) => {
      toast.success(
        t('backups.created', { name: b.fileName ?? '', size: formatBytes(b.sizeBytes) }),
      );
      invalidate();
    },
    onError,
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      apiUpload<BackupSummary>('/backups/upload', file, {
        fileName: file.name.replace(/[^A-Za-z0-9._-]/g, '_'),
      }),
    onSuccess: (b) => {
      toast.success(t('backups.uploaded', { name: b.fileName ?? '' }));
      invalidate();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (b: BackupSummary) => api<BackupSummary>(`/backups/${b.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('backups.deleted'));
      setDeleting(null);
      invalidate();
    },
    onError,
  });
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (b: BackupSummary) => {
    setDownloading(b.id);
    try {
      await apiDownload(`/backups/${b.id}/download`, b.fileName ?? 'backup.tar.gz');
    } catch (err) {
      onError(err);
    } finally {
      setDownloading(null);
    }
  };

  const data = list.data;
  const succeeded = data?.items.filter((b) => b.status === 'succeeded' && b.fileExists) ?? [];
  const latest = succeeded[0];

  return (
    <>
      <PageHeader
        title={t('backups.title')}
        subtitle={t('backups.subtitle')}
        actions={
          canManage && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".gz,.tgz,application/gzip"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = '';
                }}
              />
              <Button onClick={() => fileInput.current?.click()} loading={upload.isPending}>
                <Upload size={14} /> {t('backups.upload')}
              </Button>
              <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>
                <HardDriveDownload size={14} /> {t('backups.backupNow')}
              </Button>
            </>
          )
        }
      />
      {data && (
        <div className="grid grid--stats" style={{ marginBottom: 16 }}>
          <StatTile
            label={t('backups.lastBackup')}
            value={latest ? fmt.relative(latest.finishedAt ?? latest.startedAt) : t('common.never')}
            sub={
              latest
                ? `${t(`backups.kind.${latest.kind}`)} · ${formatBytes(latest.sizeBytes)}`
                : undefined
            }
            tone={latest ? undefined : 'warning'}
          />
          <StatTile
            label={t('backups.schedule')}
            value={data.schedule.enabled ? data.schedule.time : t('common.disabled')}
            sub={
              data.schedule.enabled
                ? t('backups.nextRun', { when: fmt.dateTime(data.schedule.nextRunAt) })
                : t('backups.scheduleOff')
            }
            tone={data.schedule.enabled ? 'success' : 'warning'}
          />
          <StatTile
            label={t('backups.retention')}
            value={String(data.schedule.keepCount)}
            sub={t('backups.retentionHint')}
          />
          <StatTile label={t('backups.stored')} value={String(succeeded.length)} />
        </div>
      )}
      {data && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <FolderOpen size={16} className="muted" />
            <span className="muted">{t('backups.directory')}</span>
            <code className="mono" style={{ userSelect: 'all' }}>
              {data.directory}
            </code>
            <span className="faint" style={{ marginLeft: 'auto' }}>
              {t('backups.directoryHint')}{' '}
              <Link to="/settings?tab=system">{t('backups.changeSchedule')}</Link>
            </span>
          </div>
        </div>
      )}
      <div className="toolbar">
        <Checkbox
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.target.checked)}
          label={t('backups.showDeleted')}
        />
      </div>
      {list.isLoading && <Loading />}
      {data && data.items.length === 0 && (
        <EmptyState icon={<Archive size={22} />} title={t('backups.empty')} />
      )}
      {data && data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('backups.file')}</th>
                <th>{t('backups.kindLabel')}</th>
                <th>{t('common.status')}</th>
                <th className="right">{t('backups.size')}</th>
                <th>{t('backups.createdBy')}</th>
                {canManage && <th className="right">{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => {
                const usable = b.status === 'succeeded' && b.fileExists;
                return (
                  <tr
                    key={b.id}
                    className={usable ? undefined : 'row--muted'}
                    data-testid="backup-row"
                  >
                    <td className="num">{fmt.dateTime(b.startedAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {b.fileName ?? '—'}
                      {b.schemaVersion !== null && (
                        <span className="faint"> · v{b.schemaVersion}</span>
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          b.kind === 'pre_restore'
                            ? 'purple'
                            : b.kind === 'scheduled'
                              ? 'info'
                              : 'default'
                        }
                      >
                        {t(`backups.kind.${b.kind}`)}
                      </Badge>
                    </td>
                    <td>
                      {b.status === 'succeeded' && !b.fileExists ? (
                        <Badge tone="warning">{t('backups.missing')}</Badge>
                      ) : (
                        <Badge
                          tone={
                            b.status === 'succeeded'
                              ? 'success'
                              : b.status === 'failed'
                                ? 'danger'
                                : b.status === 'running'
                                  ? 'info'
                                  : 'default'
                          }
                        >
                          {t(`backups.status.${b.status}`)}
                        </Badge>
                      )}
                      {b.errorMessage && (
                        <div className="faint" style={{ fontSize: 12 }} title={b.errorMessage}>
                          {b.errorMessage.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td className="right num">{formatBytes(b.sizeBytes)}</td>
                    <td className="muted">{b.createdByName ?? t('backups.system')}</td>
                    {canManage && (
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          {usable && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={downloading === b.id}
                                onClick={() => void download(b)}
                              >
                                <Download size={13} /> {t('backups.download')}
                              </Button>
                              <Button size="sm" onClick={() => setRestoring(b)}>
                                <RotateCcw size={13} /> {t('backups.restore')}
                              </Button>
                            </>
                          )}
                          {b.status !== 'deleted' && b.status !== 'running' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={t('common.delete')}
                              onClick={() => setDeleting(b)}
                            >
                              <Trash2 size={13} />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          title={t('backups.deleteTitle')}
          body={t('backups.deleteConfirm', { name: deleting.fileName ?? '' })}
          confirmLabel={t('common.delete')}
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupSummary; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api<RestoreResult>(`/backups/${backup.id}/restore`, {
        method: 'POST',
        body: { password, confirm: true },
      }),
    onSuccess: (r) => {
      setResult(r);
      // Everything the app has cached describes the old data.
      void queryClient.invalidateQueries();
      toast.success(t('backups.restored'));
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'PASSWORD_MISMATCH') {
        toast.error(t('backups.wrongPassword'));
        return;
      }
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const valid = password.length > 0 && acknowledged;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('backups.restoreTitle')}
      size="md"
      locked={mutation.isPending}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!valid}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              <RotateCcw size={14} /> {t('backups.restoreConfirm')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <Alert tone="success">{t('backups.restoreDone')}</Alert>
          <div className="grid grid--2">
            <StatTile label={t('backups.tablesRestored')} value={String(result.tablesRestored)} />
            <StatTile
              label={t('backups.rowsRestored')}
              value={result.rowsRestored.toLocaleString()}
            />
            <StatTile
              label={t('backups.duration')}
              value={`${(result.durationMs / 1000).toFixed(1)} s`}
            />
            <StatTile
              label={t('backups.safetyCopy')}
              value={result.preRestoreBackupId ? t('common.yes') : t('common.no')}
            />
          </div>
          {!result.sessionKept && <Alert tone="warning">{t('backups.sessionLost')}</Alert>}
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !mutation.isPending) mutation.mutate();
          }}
        >
          <Alert tone="danger" icon={<AlertTriangle size={16} />}>
            {t('backups.restoreWarning', {
              name: backup.fileName ?? '',
              when: fmt.dateTime(backup.startedAt),
            })}
          </Alert>
          <p className="muted">{t('backups.restoreSafety')}</p>
          <Field label={t('backups.yourPassword')}>
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Checkbox
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            label={t('backups.acknowledge')}
          />
        </form>
      )}
    </Dialog>
  );
}
