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
  Import,
  Lock,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  PERMISSIONS,
  type BackupEncryptionStatus,
  type BackupSummary,
  type BackupsResponse,
  type RestoreResult,
  type SettingsMap,
} from '@likapcs/shared';
import { api, ApiError, apiDownload, apiUpload } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { ImportWizard } from '../components/backups/ImportWizard';
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

/** Server errors that mean "this encrypted archive needs its backup password" (0.26.0). */
const ARCHIVE_PASSWORD_CODES = ['ARCHIVE_PASSWORD_REQUIRED', 'ARCHIVE_PASSWORD_WRONG'];

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
  const [importing, setImporting] = useState(false);
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
  // An encrypted archive this PC has no key for asks for its backup password (0.26.0).
  const [uploadRetry, setUploadRetry] = useState<{ file: File; wrong: boolean } | null>(null);
  const upload = useMutation({
    mutationFn: ({ file, password }: { file: File; password?: string }) =>
      apiUpload<BackupSummary>(
        '/backups/upload',
        file,
        { fileName: file.name.replace(/[^A-Za-z0-9._-]/g, '_') },
        { headers: password ? { 'x-archive-password': password } : undefined },
      ),
    onSuccess: (b) => {
      setUploadRetry(null);
      toast.success(t('backups.uploaded', { name: b.fileName ?? '' }));
      invalidate();
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && ARCHIVE_PASSWORD_CODES.includes(err.code)) {
        setUploadRetry({ file: vars.file, wrong: err.code === 'ARCHIVE_PASSWORD_WRONG' });
        return;
      }
      onError(err);
    },
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
                  if (file) upload.mutate({ file });
                  e.target.value = '';
                }}
              />
              <Button onClick={() => setImporting(true)} data-testid="backups-import">
                <Import size={14} /> {t('imports.open')}
              </Button>
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
      {data && <ProtectionCard canManage={canManage} />}
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
                      {(b.encrypted || b.externalCopy) && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {b.encrypted && (
                            <Badge tone="info">
                              <Lock size={11} /> {t('backups.archiveBadge')}
                            </Badge>
                          )}
                          {b.externalCopy && (
                            <span
                              title={b.externalCopy.error ?? b.externalCopy.path ?? ''}
                              style={{ display: 'inline-flex' }}
                            >
                              <Badge tone={b.externalCopy.ok ? 'success' : 'danger'}>
                                {b.externalCopy.ok
                                  ? t('backups.externalOk')
                                  : t('backups.externalFailed')}
                              </Badge>
                            </span>
                          )}
                        </div>
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
      {uploadRetry && (
        <ArchivePasswordDialog
          fileName={uploadRetry.file.name}
          wrong={uploadRetry.wrong}
          pending={upload.isPending}
          onSubmit={(password) => upload.mutate({ file: uploadRetry.file, password })}
          onClose={() => setUploadRetry(null)}
        />
      )}
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
      {canManage && <ImportWizard open={importing} onClose={() => setImporting(false)} />}
    </>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupSummary; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [archivePassword, setArchivePassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api<RestoreResult>(`/backups/${backup.id}/restore`, {
        method: 'POST',
        body: {
          password,
          confirm: true,
          archivePassword: archivePassword || undefined,
        },
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
      if (err instanceof ApiError && err.code === 'ARCHIVE_PASSWORD_REQUIRED') {
        toast.error(t('backups.archiveRequiredBody'));
        return;
      }
      if (err instanceof ApiError && err.code === 'ARCHIVE_PASSWORD_WRONG') {
        toast.error(t('backups.archiveWrong'));
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
          {backup.encrypted && (
            <Field
              label={t('backups.archivePasswordLabel')}
              hint={t('backups.archivePasswordHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={archivePassword}
                  onChange={(e) => setArchivePassword(e.target.value)}
                />
              )}
            </Field>
          )}
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

/** Backup password + copy outside the PC (0.26.0). The folder is only a setting; no network. */
function ProtectionCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [encOpen, setEncOpen] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['backups', 'encryption'],
    queryFn: () => api<BackupEncryptionStatus>('/backups/encryption'),
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsMap>('/settings'),
  });
  const savedFolder = (settings.data?.['backup.external_dir'] as string | undefined) ?? '';
  const shown = folder ?? savedFolder;
  const saveFolder = useMutation({
    mutationFn: (value: string) =>
      api<SettingsMap>('/settings', { method: 'PATCH', body: { 'backup.external_dir': value } }),
    onSuccess: () => {
      setFolder(null);
      toast.success(t('backups.extSaved'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <ShieldCheck size={16} className="muted" />
        <strong>{t('backups.encCardTitle')}</strong>
        {status.data && (
          <Badge tone={status.data.enabled ? 'success' : 'warning'}>
            {status.data.enabled ? t('backups.encOn') : t('backups.encOff')}
          </Badge>
        )}
        {canManage && (
          <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setEncOpen(true)}>
            <Lock size={13} /> {status.data?.enabled ? t('backups.encChange') : t('backups.encSet')}
          </Button>
        )}
      </div>
      {status.data?.changedAt && (
        <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          {t('backups.encChanged', { when: fmt.dateTime(status.data.changedAt) })}
        </p>
      )}
      <p className="muted" style={{ marginTop: 8 }}>
        {t('backups.encHelp')}
      </p>

      <div
        className="row"
        style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 16 }}
      >
        <FolderOpen size={16} className="muted" />
        <strong>{t('backups.extTitle')}</strong>
        {settings.data && !savedFolder && <Badge>{t('backups.extOff')}</Badge>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {t('backups.extHelp')}
      </p>
      <form
        className="row"
        style={{ gap: 8, marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (canManage && !saveFolder.isPending) saveFolder.mutate(shown.trim());
        }}
      >
        <Input
          value={shown}
          placeholder={t('backups.extPlaceholder')}
          disabled={!canManage}
          aria-label={t('backups.extTitle')}
          onChange={(e) => setFolder(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        {canManage && (
          <Button
            type="submit"
            loading={saveFolder.isPending}
            disabled={shown.trim() === savedFolder.trim()}
          >
            {t('backups.extSave')}
          </Button>
        )}
      </form>
      {encOpen && <EncryptionDialog onClose={() => setEncOpen(false)} />}
    </div>
  );
}

function EncryptionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [archivePassword, setArchivePassword] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api<BackupEncryptionStatus>('/backups/encryption', {
        method: 'PUT',
        body: { archivePassword, password, confirm: true },
      }),
    onSuccess: () => {
      toast.success(t('backups.encSaved'));
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'PASSWORD_MISMATCH') {
        toast.error(t('backups.wrongPassword'));
        return;
      }
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const valid = archivePassword.length >= 8 && password.length > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('backups.encSet')}
      size="md"
      locked={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t('backups.encSave')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !mutation.isPending) mutation.mutate();
        }}
      >
        <p className="muted">{t('backups.encHelp')}</p>
        <Alert tone="warning" icon={<AlertTriangle size={16} />}>
          {t('backups.encWarning')}
        </Alert>
        <Field label={t('backups.encNewPassword')}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={archivePassword}
              onChange={(e) => setArchivePassword(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('backups.yourPassword')}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function ArchivePasswordDialog({
  fileName,
  wrong,
  pending,
  onSubmit,
  onClose,
}: {
  fileName: string;
  wrong: boolean;
  pending: boolean;
  onSubmit: (password: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('backups.archiveRequiredTitle')}
      size="md"
      locked={pending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={password.length === 0}
            loading={pending}
            onClick={() => onSubmit(password)}
          >
            <Upload size={14} /> {t('backups.archiveRetry')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !pending) onSubmit(password);
        }}
      >
        <p className="muted">{t('backups.archiveRequiredBody')}</p>
        <p className="mono" style={{ fontSize: 12 }}>
          {fileName}
        </p>
        {wrong && <Alert tone="danger">{t('backups.archiveWrong')}</Alert>}
        <Field label={t('backups.archivePasswordLabel')}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
