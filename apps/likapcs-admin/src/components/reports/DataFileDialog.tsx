/**
 * «Skedar për AI» (0.39.0): the owner picks the days, what goes in and the format; the server
 * makes one JSON and/or text file with every figure of the business — the summaries on top, the
 * rows below — and the files are saved where the owner chooses, to hand to an AI.
 *
 * Every wait has a bar with a percentage: making the files (the server's job, row by row) and
 * saving each of them (written, then read back and compared; or read piece by piece when it is
 * saved as an ordinary download).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CircleCheckBig,
  Download,
  FileJson,
  FileText,
  Save,
  Sparkles,
} from 'lucide-react';
import {
  DATA_EXPORT_PARTS,
  type DataExportFile,
  type DataExportFormat,
  type DataExportPart,
  type DataExportPhase,
  type DataExportResult,
} from '@likapcs/shared';
import { ApiError } from '../../lib/api';
import {
  CopyMismatchError,
  JobLostError,
  canChooseSaveLocation,
  chooseSaveLocation,
} from '../../lib/backup-file';
import {
  ALL_DETAIL_PARTS,
  LARGE_FOR_AI_BYTES,
  deleteDataFile,
  downloadDataFile,
  followDataFile,
  periodRange,
  rangeIsValid,
  SAVE_CHECK_FROM_PERCENT,
  saveDataFileTo,
  startDataFile,
  type DataFilePeriod,
} from '../../lib/data-file';
import type { DateRange, RangePreset } from '../../lib/report-range';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatFileSize } from '../backups/BackupFile';
import { Alert, Button, Checkbox, Dialog, Input } from '../ui/primitives';

type Translate = ReturnType<typeof useI18n>['t'];

const PERIODS: readonly DataFilePeriod[] = [
  'today',
  'yesterday',
  'last7',
  'month',
  'lastMonth',
  'all',
  'custom',
];

/** Server answers that have a sentence of their own; anything else shows the server's text. */
const KNOWN_ERRORS: Record<string, TranslationKey> = {
  EXPORT_BUSY: 'dataFile.errBusy',
  NOT_ENOUGH_SPACE: 'dataFile.errSpace',
  forbidden: 'dataFile.errForbidden',
  not_found: 'dataFile.errExpired',
  TICKET_INVALID: 'dataFile.errExpired',
};

function messageOf(err: unknown, t: Translate): string {
  if (err instanceof JobLostError) return t('dataFile.errLost');
  if (err instanceof CopyMismatchError) return t('dataFile.copyMismatch');
  if (err instanceof ApiError) {
    if (err.isNetwork) return t('common.networkError');
    const key = KNOWN_ERRORS[err.code];
    return key ? t(key) : err.message;
  }
  return t('common.errorGeneric');
}

interface SaveState {
  state: 'idle' | 'working' | 'saved' | 'downloaded' | 'failed';
  percent: number;
  /** While working: the copy is being read back from where it was saved. */
  checking?: boolean;
  name?: string;
  checked?: boolean;
  error?: string;
}
const IDLE: SaveState = { state: 'idle', percent: 0 };
/** After «Anulo»: how long a server that gives no answer is still waited for. */
const CANCEL_PATIENCE_MS = 4000;

interface JobView {
  percent: number;
  phase: DataExportPhase;
  current: number | null;
  total: number | null;
}

export function DataFileDialog({
  initial,
  onClose,
}: {
  /** What the Reports page shows right now: the dialog opens on the same days. */
  initial: { preset: RangePreset; range: DateRange };
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const [stage, setStage] = useState<'form' | 'running' | 'done'>('form');
  const [period, setPeriod] = useState<DataFilePeriod>(
    initial.preset === 'week' ? 'custom' : initial.preset,
  );
  const [custom, setCustom] = useState<DateRange>(initial.range);
  const [parts, setParts] = useState<ReadonlySet<DataExportPart>>(new Set(ALL_DETAIL_PARTS));
  const [json, setJson] = useState(true);
  const [txt, setTxt] = useState(true);
  const [hideCustomers, setHideCustomers] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [view, setView] = useState<JobView>({
    percent: 0,
    phase: 'starting',
    current: null,
    total: null,
  });
  const [result, setResult] = useState<DataExportResult | null>(null);
  const [saves, setSaves] = useState<Record<DataExportFormat, SaveState>>({
    json: IDLE,
    txt: IDLE,
  });
  const [cancelling, setCancelling] = useState(false);
  const canChoose = useMemo(() => canChooseSaveLocation(), []);
  // What the server holds for this dialog: the job while it runs, its files once it is done.
  // It is given up when the dialog goes away, however it goes away (a running job is cancelled,
  // finished files are deleted).
  const exportId = useRef<string | null>(null);
  const gone = useRef(false);
  // «Anulo» was pressed for the job that runs (a ref: the job's own code must see it).
  const cancelRequested = useRef(false);
  useEffect(() => {
    // Strict mode mounts twice: the dialog is back, so it is not gone.
    gone.current = false;
    return () => {
      gone.current = true;
      if (exportId.current) void deleteDataFile(exportId.current);
    };
  }, []);

  const range = periodRange(period, custom);
  const formats: DataExportFormat[] = [
    ...(json ? (['json'] as const) : []),
    ...(txt ? (['txt'] as const) : []),
  ];
  const valid = rangeIsValid(range) && formats.length > 0;
  const saving = Object.values(saves).some((s) => s.state === 'working');

  const togglePart = (part: DataExportPart) =>
    setParts((current) => {
      const next = new Set(current);
      if (next.has(part)) next.delete(part);
      else next.add(part);
      return next;
    });

  const start = async () => {
    if (!valid) return;
    setFailure(null);
    cancelRequested.current = false;
    setCancelling(false);
    setStage('running');
    setView({ percent: 0, phase: 'starting', current: null, total: null });
    /** Nobody waits for this file any more: the dialog went away, or «Anulo» was pressed. */
    const givenUp = () => gone.current || cancelRequested.current;
    try {
      const jobId = await startDataFile({
        ...(range ? { from: range.from, to: range.to } : {}),
        formats,
        parts: DATA_EXPORT_PARTS.filter((part) => parts.has(part)),
        hideCustomers,
        language: language === 'sq' ? 'sq' : 'en',
      });
      exportId.current = jobId;
      // Given up while the request was on its way: the job is told right away.
      if (givenUp()) void deleteDataFile(jobId);
      if (gone.current) return;
      const final = await followDataFile(
        jobId,
        (status) =>
          setView({
            percent: status.percent,
            phase: status.phase,
            current: status.current,
            total: status.total,
          }),
        // After «Anulo» a silent server is not waited for a whole minute.
        { patienceMs: () => (cancelRequested.current ? CANCEL_PATIENCE_MS : 60_000) },
      );
      if (givenUp()) {
        // It may have finished a moment before the cancel reached it: delete what it made.
        if (final.state === 'succeeded') void deleteDataFile(jobId);
        exportId.current = null;
        setStage('form');
        return;
      }
      if (final.state !== 'succeeded' || !final.result) {
        exportId.current = null;
        const key = final.error ? KNOWN_ERRORS[final.error.code] : undefined;
        setFailure(key ? t(key) : (final.error?.message ?? t('common.errorGeneric')));
        setStage('form');
        return;
      }
      setResult(final.result);
      setSaves({ json: IDLE, txt: IDLE });
      setStage('done');
    } catch (err) {
      // The server went silent or no longer knows the job. Should it still be making the file,
      // give it up: nobody will come for it, and the next try must not find the server busy.
      if (exportId.current) void deleteDataFile(exportId.current);
      exportId.current = null;
      // After «Anulo» there is nothing to report: the file was not wanted any more.
      if (!cancelRequested.current) setFailure(messageOf(err, t));
      setStage('form');
    }
  };

  /** Gives the running job up; the bar stays until the server says that it has stopped. */
  const cancel = () => {
    if (cancelRequested.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    // Not known yet when the request to start is still on its way: `start` tells it then.
    if (exportId.current) void deleteDataFile(exportId.current);
  };

  const setSave = (format: DataExportFormat, next: SaveState) =>
    setSaves((current) => ({ ...current, [format]: next }));

  /** Saves one file: into the place chosen in the "save as" window, else as a download. */
  const save = async (file: DataExportFile, how: 'choose' | 'download') => {
    if (!result) return;
    const report = (percent: number, checking: boolean) =>
      setSaves((current) =>
        current[file.format].state === 'working'
          ? { ...current, [file.format]: { state: 'working', percent, checking } }
          : current,
      );
    try {
      if (how === 'choose') {
        // Straight from the click: the window opens only then.
        const handle = await chooseSaveLocation(file.fileName);
        if (handle === 'cancelled') return;
        if (handle) {
          setSave(file.format, { state: 'working', percent: 0 });
          const saved = await saveDataFileTo(handle, result.id, file, (percent) =>
            report(percent, percent >= SAVE_CHECK_FROM_PERCENT),
          );
          setSave(file.format, {
            state: 'saved',
            percent: 100,
            name: saved.name,
            checked: saved.checked,
          });
          return;
        }
      }
      setSave(file.format, { state: 'working', percent: 0 });
      await downloadDataFile(result.id, file, (percent) => report(percent, false));
      setSave(file.format, { state: 'downloaded', percent: 100, name: file.fileName });
    } catch (err) {
      setSave(file.format, { state: 'failed', percent: 0, error: messageOf(err, t) });
    }
  };

  const again = () => {
    if (exportId.current) void deleteDataFile(exportId.current);
    exportId.current = null;
    setResult(null);
    setFailure(null);
    setStage('form');
  };

  const percent = Math.max(0, Math.min(100, Math.round(view.percent)));
  const counted = view.current !== null && view.total !== null && view.total > 0;
  const largest = result ? Math.max(...result.files.map((f) => f.sizeBytes)) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dataFile.title')}
      size={stage === 'form' ? 'lg' : 'md'}
      locked={stage === 'running' || saving}
      footer={
        stage === 'form' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              onClick={() => void start()}
              data-testid="data-file-start"
            >
              <Sparkles size={14} /> {t('dataFile.start')}
            </Button>
          </>
        ) : stage === 'done' ? (
          <>
            <Button variant="ghost" onClick={again} disabled={saving} data-testid="data-file-again">
              {t('dataFile.again')}
            </Button>
            <Button
              variant="primary"
              onClick={onClose}
              disabled={saving}
              data-testid="data-file-close"
            >
              {t('common.close')}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            onClick={cancel}
            disabled={cancelling}
            data-testid="data-file-cancel"
          >
            {cancelling ? t('dataFile.cancelling') : t('dataFile.cancel')}
          </Button>
        )
      }
    >
      {stage === 'form' && (
        <div className="stack data-file">
          <p>{t('dataFile.intro')}</p>
          {failure && (
            <Alert tone="danger" icon={<AlertTriangle size={16} />}>
              <span data-testid="data-file-error">{failure}</span>
            </Alert>
          )}

          <section className="data-file__block">
            <h3 className="data-file__heading">{t('dataFile.period')}</h3>
            <div className="data-file__chips" role="radiogroup" aria-label={t('dataFile.period')}>
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={period === p}
                  className="data-file__chip"
                  data-active={period === p}
                  data-testid={`data-file-period-${p}`}
                  onClick={() => {
                    // Opening «dates» keeps the days of the period that was chosen until now.
                    if (p === 'custom' && range) setCustom(range);
                    setPeriod(p);
                  }}
                >
                  {t(`dataFile.periods.${p}`)}
                </button>
              ))}
            </div>
            {period === 'custom' ? (
              <div className="row data-file__dates">
                <label className="row" style={{ gap: 6 }}>
                  <span className="muted">{t('dataFile.from')}</span>
                  <Input
                    type="date"
                    value={custom.from}
                    max={custom.to || undefined}
                    onChange={(e) => setCustom({ ...custom, from: e.target.value })}
                    data-testid="data-file-from"
                  />
                </label>
                <label className="row" style={{ gap: 6 }}>
                  <span className="muted">{t('dataFile.to')}</span>
                  <Input
                    type="date"
                    value={custom.to}
                    min={custom.from || undefined}
                    onChange={(e) => setCustom({ ...custom, to: e.target.value })}
                    data-testid="data-file-to"
                  />
                </label>
              </div>
            ) : (
              <div className="faint data-file__range" data-testid="data-file-range">
                {range
                  ? range.from === range.to
                    ? range.from
                    : `${range.from} – ${range.to}`
                  : t('dataFile.allHint')}
              </div>
            )}
            {!rangeIsValid(range) && (
              <div className="field__error">{t('dataFile.invalidRange')}</div>
            )}
          </section>

          <section className="data-file__block">
            <div className="data-file__heading-row">
              <h3 className="data-file__heading">{t('dataFile.partsTitle')}</h3>
              <span className="data-file__links">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setParts(new Set(ALL_DETAIL_PARTS))}
                  data-testid="data-file-parts-all"
                >
                  {t('dataFile.partsAll')}
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setParts(new Set())}
                  data-testid="data-file-parts-none"
                >
                  {t('dataFile.partsNone')}
                </button>
              </span>
            </div>
            <div className="data-file__parts">
              {DATA_EXPORT_PARTS.map((part) => (
                <label
                  key={part}
                  className="data-file__part"
                  data-checked={parts.has(part)}
                  data-testid={`data-file-part-${part}`}
                  title={t(`dataFile.partHints.${part}`)}
                >
                  <input
                    type="checkbox"
                    checked={parts.has(part)}
                    onChange={() => togglePart(part)}
                  />
                  <span>{t(`dataFile.parts.${part}`)}</span>
                </label>
              ))}
            </div>
            <div className="faint data-file__hint">{t('dataFile.partsHint')}</div>
          </section>

          <section className="data-file__block">
            <h3 className="data-file__heading">{t('dataFile.formatTitle')}</h3>
            <div className="data-file__formats">
              <label
                className="data-file__part"
                data-checked={json}
                data-testid="data-file-format-json"
              >
                <input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} />
                <span>
                  <strong>JSON</strong>{' '}
                  <span className="faint">· {t('dataFile.formatJsonHint')}</span>
                </span>
              </label>
              <label
                className="data-file__part"
                data-checked={txt}
                data-testid="data-file-format-txt"
              >
                <input type="checkbox" checked={txt} onChange={(e) => setTxt(e.target.checked)} />
                <span>
                  <strong>TXT</strong>{' '}
                  <span className="faint">· {t('dataFile.formatTxtHint')}</span>
                </span>
              </label>
            </div>
            {formats.length === 0 && <div className="field__error">{t('dataFile.formatNone')}</div>}
          </section>

          <div data-testid="data-file-hide">
            <Checkbox
              checked={hideCustomers}
              onChange={(e) => setHideCustomers(e.target.checked)}
              label={t('dataFile.hide')}
              description={t('dataFile.hideHint')}
            />
          </div>
          <div className="faint data-file__hint">{t('dataFile.never')}</div>
        </div>
      )}

      {stage === 'running' && (
        <div className="job-progress" data-testid="job-progress">
          <div className="job-progress__top">
            <span className="job-progress__percent num" data-testid="job-percent">
              {percent}%
            </span>
            <span className="job-progress__phase" data-testid="job-phase">
              {cancelling ? t('dataFile.cancelling') : t(`dataFile.phase.${view.phase}`)}
              {counted && !cancelling && (
                <span className="faint num">
                  {' '}
                  · {view.current!.toLocaleString()} / {view.total!.toLocaleString()}{' '}
                  {t('dataFile.rows')}
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
          <div className="faint job-progress__note">{t('dataFile.keepOpen')}</div>
        </div>
      )}

      {stage === 'done' && result && (
        <div className="stack data-file" data-testid="data-file-done">
          <Alert tone="success" icon={<CircleCheckBig size={16} />}>
            {result.files.length > 1 ? t('dataFile.doneBoth') : t('dataFile.done')}
          </Alert>
          <div className="job-facts data-file__facts">
            <div className="job-fact">
              <div className="job-fact__label">{t('dataFile.period')}</div>
              <div className="job-fact__value data-file__fact-text num">
                {result.from === result.to ? result.from : `${result.from} – ${result.to}`}
              </div>
              {result.wholeHistory && (
                <div className="job-fact__sub faint">{t('dataFile.factAll')}</div>
              )}
            </div>
            <div className="job-fact">
              <div className="job-fact__label">{t('dataFile.factRows')}</div>
              <div className="job-fact__value num" data-testid="data-file-rows">
                {result.totalRows.toLocaleString()}
              </div>
              <div className="job-fact__sub faint">
                {result.totalRows === 0
                  ? t('dataFile.factSummaryOnly')
                  : t('dataFile.factSales', { n: (result.counts.sales ?? 0).toLocaleString() })}
              </div>
            </div>
          </div>

          <div className="data-file__files">
            {result.files.map((file) => {
              const s = saves[file.format];
              const working = s.state === 'working';
              return (
                <div
                  className="data-file__file"
                  key={file.format}
                  data-testid={`data-file-${file.format}`}
                >
                  <div className="data-file__file-top">
                    {file.format === 'json' ? <FileJson size={20} /> : <FileText size={20} />}
                    <div className="data-file__file-name">
                      <strong>{file.fileName}</strong>
                      <span className="faint num">{formatFileSize(file.sizeBytes)}</span>
                    </div>
                    <div className="data-file__file-actions">
                      {canChoose && (
                        <Button
                          variant={s.state === 'saved' ? 'default' : 'primary'}
                          size="sm"
                          disabled={saving}
                          onClick={() => void save(file, 'choose')}
                          data-testid={`data-file-save-${file.format}`}
                        >
                          <Save size={14} /> {t('dataFile.save')}
                        </Button>
                      )}
                      <Button
                        variant={canChoose || s.state === 'downloaded' ? 'default' : 'primary'}
                        size="sm"
                        disabled={saving}
                        onClick={() => void save(file, 'download')}
                        data-testid={`data-file-download-${file.format}`}
                      >
                        <Download size={14} /> {t('dataFile.download')}
                      </Button>
                    </div>
                  </div>
                  {working && (
                    <div className="data-file__saving">
                      <span
                        className="num data-file__saving-percent"
                        data-testid={`data-file-percent-${file.format}`}
                      >
                        {s.percent}%
                      </span>
                      <div
                        className="progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={s.percent}
                      >
                        <div className="progress__bar" style={{ width: `${s.percent}%` }} />
                      </div>
                      <span className="faint">
                        {s.checking ? t('dataFile.checking') : t('dataFile.saving')}
                      </span>
                    </div>
                  )}
                  {s.state === 'saved' && (
                    <div
                      className="data-file__status data-file__status--ok"
                      data-testid={`data-file-saved-${file.format}`}
                    >
                      <CircleCheckBig size={14} />
                      <span>
                        {t('dataFile.saved', { name: s.name ?? file.fileName })}
                        {s.checked && (
                          <span className="faint"> · {t('dataFile.savedChecked')}</span>
                        )}
                      </span>
                    </div>
                  )}
                  {s.state === 'downloaded' && (
                    <div
                      className="data-file__status data-file__status--ok"
                      data-testid={`data-file-saved-${file.format}`}
                    >
                      <CircleCheckBig size={14} />
                      <span>{t('dataFile.downloaded', { name: s.name ?? file.fileName })}</span>
                    </div>
                  )}
                  {s.state === 'failed' && (
                    <div
                      className="data-file__status data-file__status--bad"
                      data-testid={`data-file-failed-${file.format}`}
                    >
                      <AlertTriangle size={14} />
                      <span>{s.error}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {largest > LARGE_FOR_AI_BYTES && (
            <Alert tone="warning" icon={<AlertTriangle size={16} />}>
              <span data-testid="data-file-large">
                {t('dataFile.large', { size: formatFileSize(largest) })}
              </span>
            </Alert>
          )}
          <div className="faint data-file__hint">
            {result.hideCustomers ? t('dataFile.hiddenNote') : t('dataFile.namesNote')}{' '}
            {t('dataFile.serverCopy')}
          </div>
        </div>
      )}
    </Dialog>
  );
}
