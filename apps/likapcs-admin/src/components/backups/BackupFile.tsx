/**
 * «Backup file» and «Restore from a backup» (0.38.0).
 *
 * `BackupFileDialog` makes ONE file that holds everything (the database and every uploaded
 * picture, wallpaper, video and voice clip), lets the owner choose where it goes, and reads the
 * saved copy back. `RestoreFileDialog` takes such a file — on the first screen of a new
 * installation, on the login screen, or on the Backups page — and puts everything back. Both show
 * one bar with the percentage of the whole operation.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArchiveRestore,
  CircleCheckBig,
  Download,
  FileArchive,
  FolderOpen,
  HardDriveDownload,
} from 'lucide-react';
import type {
  BackupEncryptionStatus,
  BackupFileResult,
  BackupJobStarted,
  BackupSummary,
  BackupUploadResult,
  LoginResponse,
  RestoreResult,
} from '@likapcs/shared';
import { api, ApiError, pauseUnauthorizedHandler } from '../../lib/api';
import {
  archiveKindOf,
  backupCheckingPercent,
  backupJobPercent,
  backupSavingPercent,
  canChooseSaveLocation,
  chooseSaveLocation,
  CopyMismatchError,
  downloadBackupByLink,
  followJob,
  JobLostError,
  restoreJobPercent,
  restoreUploadPercent,
  safeUploadName,
  saveBackupTo,
  suggestedBackupName,
  uploadWithProgress,
  type ArchiveKind,
  type ProgressView,
} from '../../lib/backup-file';
import { useI18n, type TranslationKey } from '../../i18n';
import { Alert, Button, Checkbox, Dialog, Field, Input } from '../ui/primitives';

type Translate = ReturnType<typeof useI18n>['t'];

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
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

/** Server answers that have a sentence of their own; anything else shows the server's text. */
const KNOWN_ERRORS: Record<string, TranslationKey> = {
  PASSWORD_MISMATCH: 'backupFile.errAccountPassword',
  unauthorized: 'backupFile.errLogin',
  account_locked: 'backupFile.errLocked',
  forbidden: 'backupFile.errNotOwner',
  ARCHIVE_PASSWORD_REQUIRED: 'backupFile.errFilePasswordNeeded',
  ARCHIVE_PASSWORD_WRONG: 'backupFile.errFilePasswordWrong',
  ARCHIVE_NEWER: 'backupFile.errNewer',
  ARCHIVE_INCOMPLETE: 'backupFile.errDamaged',
  ARCHIVE_CORRUPT: 'backupFile.errDamaged',
  ARCHIVE_UPGRADE_FAILED: 'backupFile.errUpgrade',
  NOT_ENOUGH_SPACE: 'backupFile.errSpace',
  BACKUP_BUSY: 'backupFile.errBusy',
  NOT_FRESH_INSTALL: 'backupFile.errNotFresh',
  RESTORE_FILES_INCOMPLETE: 'backupFile.errFilesIncomplete',
  payload_too_large: 'backupFile.errTooLarge',
};

interface Failure {
  message: string;
  /** The server's own words, shown small under the sentence (useful when asking for help). */
  detail: string | null;
  code: string | null;
}

function failureOf(err: unknown, t: Translate): Failure {
  if (err instanceof JobLostError) {
    return { message: t('backupFile.errLost'), detail: null, code: 'job_lost' };
  }
  if (err instanceof ApiError) {
    if (err.isNetwork) return { message: t('common.networkError'), detail: null, code: err.code };
    const key = KNOWN_ERRORS[err.code];
    return key
      ? { message: t(key), detail: err.message, code: err.code }
      : { message: err.message, detail: null, code: err.code };
  }
  return {
    message: t('common.errorGeneric'),
    detail: err instanceof Error ? err.message : null,
    code: null,
  };
}

function jobFailure(error: { code: string; message: string } | null, t: Translate): Failure {
  if (!error) return { message: t('common.errorGeneric'), detail: null, code: null };
  const key = KNOWN_ERRORS[error.code];
  return key
    ? { message: t(key), detail: error.message, code: error.code }
    : { message: error.message, detail: null, code: error.code };
}

// ─── The bar ───────────────────────────────────────────────────────────────────

export function JobProgress({ view, note }: { view: ProgressView; note: string }) {
  const { t } = useI18n();
  const percent = Math.max(0, Math.min(100, Math.round(view.percent)));
  const counted = view.current !== null && view.total !== null && view.total > 0;
  return (
    <div className="job-progress" data-testid="job-progress">
      <div className="job-progress__top">
        <span className="job-progress__percent num" data-testid="job-percent">
          {percent}%
        </span>
        <span className="job-progress__phase" data-testid="job-phase">
          {t(`backupFile.phase.${view.phase}`)}
          {counted && (
            <span className="faint num">
              {' '}
              · {view.current!.toLocaleString()} / {view.total!.toLocaleString()}
            </span>
          )}
        </span>
      </div>
      <div
        className="progress progress--lg"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="faint job-progress__note">{note}</div>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="job-fact">
      <div className="job-fact__label">{label}</div>
      <div className="job-fact__value num">{value}</div>
      {sub && <div className="job-fact__sub faint">{sub}</div>}
    </div>
  );
}

// ─── Make a backup file ────────────────────────────────────────────────────────

interface SavedCopy {
  name: string;
  bytes: number;
  checksumChecked: boolean;
}

export function BackupFileDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  /** A new archive is in the list. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [stage, setStage] = useState<'form' | 'running' | 'done'>('form');
  const [view, setView] = useState<ProgressView>({
    percent: 0,
    phase: 'starting',
    current: null,
    total: null,
  });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<BackupFileResult | null>(null);
  const [saved, setSaved] = useState<SavedCopy | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const encryption = useQuery({
    queryKey: ['backups', 'encryption'],
    queryFn: () => api<BackupEncryptionStatus>('/backups/encryption'),
  });
  const canChoose = canChooseSaveLocation();
  const passwordOk = password.length === 0 || (password.length >= 4 && password === repeat);

  const start = async () => {
    setFailure(null);
    setSaveFailure(null);
    const encrypted = password.length > 0 || encryption.data?.enabled === true;
    // Straight from the click: a "save as" window opens only on a user's action.
    const target = await chooseSaveLocation(suggestedBackupName(new Date(), encrypted));
    if (target === 'cancelled') return;
    const saves = target !== null;
    setStage('running');
    setView({ percent: 0, phase: 'starting', current: null, total: null });
    let made: BackupFileResult;
    try {
      const { jobId } = await api<BackupJobStarted>('/backups/file', {
        method: 'POST',
        body: password ? { password } : {},
      });
      const job = await followJob(jobId, (s) =>
        setView({
          percent: backupJobPercent(s.percent, saves),
          phase: s.phase,
          current: s.current,
          total: s.total,
        }),
      );
      if (job.state !== 'succeeded' || !job.backup) {
        setFailure(jobFailure(job.error, t));
        setStage('form');
        return;
      }
      made = job.backup;
    } catch (err) {
      setFailure(failureOf(err, t));
      setStage('form');
      return;
    }
    setResult(made);
    onChanged();
    if (target) {
      try {
        const copy = await saveBackupTo(target, made.backup, (step, fraction) =>
          setView({
            percent:
              step === 'saving' ? backupSavingPercent(fraction) : backupCheckingPercent(fraction),
            phase: step,
            current: null,
            total: null,
          }),
        );
        setSaved(copy);
      } catch (err) {
        setSaveFailure(
          err instanceof CopyMismatchError
            ? t('backupFile.copyMismatch')
            : t('backupFile.copyFailed', {
                reason: err instanceof Error ? err.message : String(err),
              }),
        );
      }
    }
    setView((v) => ({ ...v, percent: 100 }));
    setStage('done');
  };

  const download = async () => {
    if (!result) return;
    setDownloading(true);
    try {
      await downloadBackupByLink(result.backup);
    } catch (err) {
      setSaveFailure(failureOf(err, t).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('backupFile.title')}
      size="md"
      locked={stage === 'running'}
      footer={
        stage === 'done' ? (
          <Button variant="primary" onClick={onClose} data-testid="backup-file-close">
            {t('common.close')}
          </Button>
        ) : stage === 'form' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!passwordOk}
              onClick={() => void start()}
              data-testid="backup-file-start"
            >
              <HardDriveDownload size={14} />{' '}
              {canChoose ? t('backupFile.startChoose') : t('backupFile.start')}
            </Button>
          </>
        ) : undefined
      }
    >
      {stage === 'form' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (passwordOk) void start();
          }}
        >
          <p>{t('backupFile.intro')}</p>
          <ul className="job-list">
            <li>{t('backupFile.holdsData')}</li>
            <li>{t('backupFile.holdsFiles')}</li>
            <li>{t('backupFile.holdsPcs')}</li>
          </ul>
          {failure && (
            <Alert tone="danger" icon={<AlertTriangle size={16} />}>
              {failure.message}
              {failure.detail && <div className="faint job-detail">{failure.detail}</div>}
            </Alert>
          )}
          <Field
            label={t('backupFile.password')}
            optional
            hint={
              encryption.data?.enabled
                ? t('backupFile.passwordHintLocked')
                : t('backupFile.passwordHint')
            }
            error={
              password.length > 0 && password.length < 4 ? t('backupFile.passwordShort') : undefined
            }
          >
            {(id, invalid) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={invalid}
                data-testid="backup-file-password"
              />
            )}
          </Field>
          {password.length > 0 && (
            <Field
              label={t('backupFile.passwordRepeat')}
              error={
                repeat.length > 0 && repeat !== password
                  ? t('backupFile.passwordDiffers')
                  : undefined
              }
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  aria-invalid={invalid}
                  data-testid="backup-file-password-repeat"
                />
              )}
            </Field>
          )}
          {password.length > 0 && <Alert tone="warning">{t('backupFile.passwordWarning')}</Alert>}
          {/* Enter in a field starts the backup, like the button. */}
          <button type="submit" hidden />
        </form>
      )}
      {stage === 'running' && <JobProgress view={view} note={t('backupFile.keepOpen')} />}
      {stage === 'done' && result && (
        <div className="stack" data-testid="backup-file-done">
          <Alert tone="success" icon={<CircleCheckBig size={16} />}>
            {result.verified ? t('backupFile.doneVerified') : t('backupFile.done')}
          </Alert>
          <div className="job-facts">
            <Fact
              label={t('backupFile.factData')}
              value={result.contents.rows.toLocaleString()}
              sub={t('backupFile.factTables', { n: result.contents.tables })}
            />
            <Fact
              label={t('backupFile.factFiles')}
              value={result.contents.files.toLocaleString()}
              sub={formatFileSize(result.contents.fileBytes)}
            />
            <Fact
              label={t('backupFile.factSize')}
              value={formatFileSize(result.backup.sizeBytes)}
              sub={result.backup.encrypted ? t('backupFile.factLocked') : t('backupFile.factOpen')}
            />
          </div>
          {saved && (
            <Alert tone="success" icon={<FileArchive size={16} />}>
              <strong data-testid="backup-file-saved">
                {t('backupFile.savedAs', { name: saved.name })}
              </strong>
              <div>
                {saved.checksumChecked ? t('backupFile.savedChecked') : t('backupFile.savedSize')}
              </div>
            </Alert>
          )}
          {saveFailure && (
            <Alert tone="danger" icon={<AlertTriangle size={16} />}>
              {saveFailure}
            </Alert>
          )}
          {!saved && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                variant="primary"
                onClick={() => void download()}
                loading={downloading}
                data-testid="backup-file-download"
              >
                <Download size={14} /> {t('backupFile.download')}
              </Button>
              <span className="muted">{t('backupFile.downloadHint')}</span>
            </div>
          )}
          <div className="job-where">
            <FolderOpen size={15} className="muted" />
            <div>
              <div className="muted">{t('backupFile.alsoHere')}</div>
              <code className="mono" style={{ userSelect: 'all' }}>
                {result.directory}
              </code>
              <div className="mono faint" style={{ userSelect: 'all', fontSize: 12 }}>
                {result.backup.fileName}
              </div>
            </div>
          </div>
          <p className="muted">{t('backupFile.howToRestore')}</p>
        </div>
      )}
    </Dialog>
  );
}

// ─── Restore from a backup file ────────────────────────────────────────────────

/**
 * `fresh`    — the first screen of a new installation: nobody is signed in, nothing to lose.
 * `login`    — the login screen: the owner's account is checked for this one operation.
 * `signedIn` — the Backups page: the signed-in owner types their password again.
 */
export type RestoreMode = 'fresh' | 'login' | 'signedIn';

export function RestoreFileDialog({
  mode,
  backup,
  onClose,
}: {
  mode: RestoreMode;
  /** An archive already in the list (Backups page). Without it, the owner picks a file. */
  backup?: BackupSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<ArchiveKind | null>(null);
  const [archivePassword, setArchivePassword] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [stage, setStage] = useState<'form' | 'running' | 'done'>('form');
  const [view, setView] = useState<ProgressView>({
    percent: 0,
    phase: 'starting',
    current: null,
    total: null,
  });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const replaces = mode !== 'fresh';
  const encrypted = backup ? backup.encrypted : kind === 'encrypted';

  // Whatever happens to the dialog, a paused sign-out check must not stay paused.
  useEffect(() => () => pauseUnauthorizedHandler(false), []);

  const choose = async (chosen: File | null) => {
    setFailure(null);
    setFile(chosen);
    setKind(null);
    if (!chosen) return;
    try {
      setKind(await archiveKindOf(chosen));
    } catch {
      setKind('unknown');
    }
  };

  const valid =
    (backup !== undefined || (file !== null && (kind === 'plain' || kind === 'encrypted'))) &&
    (mode !== 'login' || username.trim().length > 0) &&
    (mode === 'fresh' || password.length > 0) &&
    (!replaces || acknowledged);

  const start = async () => {
    if (!valid) return;
    setFailure(null);
    setStage('running');
    const uploads = backup === undefined;
    setView({
      percent: 0,
      phase: uploads ? 'uploading' : 'starting',
      current: null,
      total: null,
    });
    const filePassword = archivePassword || undefined;
    let token: string | undefined;
    const signOut = async () => {
      if (!token) return;
      await api('/auth/logout', { method: 'POST', token }).catch(() => undefined);
      token = undefined;
    };
    try {
      if (mode === 'login') {
        const session = await api<LoginResponse>('/auth/login', {
          method: 'POST',
          auth: false,
          body: { username: username.trim(), password },
        });
        token = session.token;
      }
      // 1. The file goes to the server (not needed for an archive that is already in the list).
      let backupId = backup?.id;
      if (!backupId) {
        const onProgress = (loaded: number, total: number) =>
          setView({
            percent: restoreUploadPercent(loaded, total),
            phase: 'uploading',
            current: null,
            total: null,
          });
        const query = { fileName: safeUploadName(file!.name) };
        if (mode === 'fresh') {
          const uploaded = await uploadWithProgress<BackupUploadResult>(
            '/system/restore/upload',
            file!,
            query,
            { auth: false, archivePassword: filePassword, onProgress },
          );
          backupId = uploaded.backup.id;
        } else {
          const uploaded = await uploadWithProgress<BackupSummary>(
            '/backups/upload',
            file!,
            query,
            { token, archivePassword: filePassword, onProgress },
          );
          backupId = uploaded.id;
        }
      }
      // 2. The restore itself, followed without the sign-in (see lib/backup-file.ts).
      const started =
        mode === 'fresh'
          ? await api<BackupJobStarted>('/system/restore', {
              method: 'POST',
              auth: false,
              body: { backupId, archivePassword: filePassword },
            })
          : await api<BackupJobStarted>(`/backups/${backupId}/restore-job`, {
              method: 'POST',
              token,
              body: { password, confirm: true, archivePassword: filePassword },
            });
      // From here on the data is being replaced: the signed-in account may stop existing.
      pauseUnauthorizedHandler(true);
      const job = await followJob(started.jobId, (s) =>
        setView({
          percent: restoreJobPercent(s.percent, uploads),
          phase: s.phase,
          current: s.current,
          total: s.total,
        }),
      );
      if (job.state !== 'succeeded' || !job.restore) {
        pauseUnauthorizedHandler(false);
        await signOut();
        setFailure(jobFailure(job.error, t));
        setStage('form');
        return;
      }
      await signOut();
      setResult(job.restore);
      setView((v) => ({ ...v, percent: 100 }));
      setStage('done');
    } catch (err) {
      pauseUnauthorizedHandler(false);
      await signOut();
      setFailure(failureOf(err, t));
      setStage('form');
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('restoreFile.title')}
      size="md"
      locked={stage !== 'form'}
      footer={
        stage === 'done' ? (
          <Button
            variant="primary"
            onClick={() => window.location.reload()}
            data-testid="restore-file-continue"
          >
            {mode === 'signedIn' && result?.sessionKept
              ? t('restoreFile.reload')
              : t('restoreFile.toLogin')}
          </Button>
        ) : stage === 'form' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={replaces ? 'danger' : 'primary'}
              disabled={!valid}
              onClick={() => void start()}
              data-testid="restore-file-start"
            >
              <ArchiveRestore size={14} /> {t('restoreFile.start')}
            </Button>
          </>
        ) : undefined
      }
    >
      {stage === 'form' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <p>{backup ? t('restoreFile.introListed') : t('restoreFile.intro')}</p>
          {failure && (
            <Alert tone="danger" icon={<AlertTriangle size={16} />}>
              <span data-testid="restore-file-error">{failure.message}</span>
              {failure.detail && <div className="faint job-detail">{failure.detail}</div>}
            </Alert>
          )}
          {backup ? (
            <div className="job-where">
              <FileArchive size={15} className="muted" />
              <div>
                <div className="mono" style={{ fontSize: 12.5 }}>
                  {backup.fileName}
                </div>
                <div className="faint">{formatFileSize(backup.sizeBytes)}</div>
              </div>
            </div>
          ) : (
            <>
              {/* No `accept` filter: the file may have been renamed, and a file with a password
                  ends in `.enc`, which a filter for `.gz` would hide. */}
              <input
                ref={fileInput}
                type="file"
                hidden
                data-testid="restore-file-input"
                onChange={(e) => {
                  void choose(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="job-pick"
                onClick={() => fileInput.current?.click()}
                data-testid="restore-file-pick"
              >
                <FileArchive size={22} />
                <span>
                  <strong>{file ? file.name : t('restoreFile.pick')}</strong>
                  <span className="faint">
                    {file ? formatFileSize(file.size) : t('restoreFile.pickHint')}
                  </span>
                </span>
              </button>
              {kind === 'unknown' && <Alert tone="danger">{t('restoreFile.notABackup')}</Alert>}
            </>
          )}
          {encrypted && (
            <Field
              label={t('restoreFile.filePassword')}
              hint={
                backup || mode !== 'fresh'
                  ? t('restoreFile.filePasswordHintKnown')
                  : t('restoreFile.filePasswordHint')
              }
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={archivePassword}
                  onChange={(e) => setArchivePassword(e.target.value)}
                  data-testid="restore-file-password"
                />
              )}
            </Field>
          )}
          {mode === 'login' && (
            <>
              <p className="muted">{t('restoreFile.ownerNeeded')}</p>
              <Field label={t('auth.username')}>
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    data-testid="restore-file-username"
                  />
                )}
              </Field>
            </>
          )}
          {mode !== 'fresh' && (
            <Field label={mode === 'login' ? t('auth.password') : t('backups.yourPassword')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="restore-file-account-password"
                />
              )}
            </Field>
          )}
          {replaces ? (
            <>
              <Alert tone="danger" icon={<AlertTriangle size={16} />}>
                {t('restoreFile.replaces')}
              </Alert>
              <Checkbox
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                label={t('restoreFile.acknowledge')}
              />
            </>
          ) : (
            <p className="muted">{t('restoreFile.freshNote')}</p>
          )}
          <button type="submit" hidden />
        </form>
      )}
      {stage === 'running' && <JobProgress view={view} note={t('restoreFile.keepOpen')} />}
      {stage === 'done' && result && (
        <div className="stack" data-testid="restore-file-done">
          <Alert tone="success" icon={<CircleCheckBig size={16} />}>
            {t('restoreFile.done')}
          </Alert>
          <div className="job-facts">
            <Fact
              label={t('backupFile.factData')}
              value={result.rowsRestored.toLocaleString()}
              sub={t('backupFile.factTables', { n: result.tablesRestored })}
            />
            <Fact
              label={t('backupFile.factFiles')}
              value={result.filesRestored.toLocaleString()}
              sub={formatFileSize(result.fileBytesRestored)}
            />
            <Fact
              label={t('restoreFile.factTime')}
              value={`${(result.durationMs / 1000).toFixed(1)} s`}
              sub={
                result.preRestoreBackupId ? t('restoreFile.factSafety') : t('restoreFile.factEmpty')
              }
            />
          </div>
          <p className="muted">
            {result.verified ? t('restoreFile.verified') : t('restoreFile.verifiedCounts')}
          </p>
          {result.upgraded && (
            <Alert tone="info">
              {t('restoreFile.upgraded', { version: result.archiveVersion })}
            </Alert>
          )}
          {result.identityAdopted && <Alert tone="info">{t('restoreFile.adopted')}</Alert>}
          <p className="muted">
            {mode === 'signedIn' && result.sessionKept
              ? t('restoreFile.afterKept')
              : t('restoreFile.afterLogin')}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** The entry on the first screens: an icon, a name and one line that says what it does. */
export function RestoreEntry({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  const { t } = useI18n();
  if (compact) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={onClick}
        data-testid="restore-entry"
      >
        <ArchiveRestore size={14} /> {t('restoreFile.entry')}
      </button>
    );
  }
  return (
    <button type="button" className="restore-entry" onClick={onClick} data-testid="restore-entry">
      <span className="restore-entry__icon">
        <ArchiveRestore size={22} />
      </span>
      <span className="restore-entry__text">
        <strong>{t('restoreFile.entry')}</strong>
        <span className="muted">{t('restoreFile.entryHint')}</span>
      </span>
    </button>
  );
}
