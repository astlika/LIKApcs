/**
 * "Import from another program" — a four-step wizard on the Backups page:
 *   1. pick the file (LIKApos Pro JSON backup) → the server recognises it and previews the content
 *   2. choose what to bring over (products, customers, open debts, sales history, expenses)
 *   3. dry run — same work, nothing written — shows exactly what would happen
 *   4. import: automatic backup first, then one transaction; report + picture download progress
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  FlaskConical,
  Import,
  Loader2,
  Upload,
} from 'lucide-react';
import {
  IMPORT_ENTITIES,
  type ImportAnalysis,
  type ImportEntity,
  type ImportReport,
  type ImportStatus,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n, type TranslationKey } from '../../i18n';
import { useToast } from '../../state/toast';
import { Alert, Badge, Button, Checkbox, Dialog } from '../ui/primitives';

type Step = 'file' | 'choose' | 'done';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { money, date, dateTime } = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [data, setData] = useState<unknown>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [selected, setSelected] = useState<Set<ImportEntity>>(new Set());
  const [dryReport, setDryReport] = useState<ImportReport | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep('file');
      setFileName('');
      setData(null);
      setAnalysis(null);
      setSelected(new Set());
      setDryReport(null);
      setReport(null);
      setFileError(null);
    }
  }, [open]);

  const analyze = useMutation({
    mutationFn: (payload: unknown) =>
      api<ImportAnalysis>('/imports/analyze', { method: 'POST', body: { data: payload } }),
    onSuccess: (a) => {
      setAnalysis(a);
      setSelected(new Set(IMPORT_ENTITIES.filter((e) => a.entities[e].total > 0)));
      setStep('choose');
    },
    onError: (err) =>
      setFileError(
        err instanceof ApiError && err.status === 400
          ? t('imports.notRecognised')
          : err instanceof ApiError
            ? err.message
            : t('common.errorGeneric'),
      ),
  });
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ImportReport>('/imports/run', {
        method: 'POST',
        body: { data, entities: [...selected], dryRun, fileName },
      }),
    onSuccess: (r) => {
      if (r.dryRun) {
        setDryReport(r);
      } else {
        setReport(r);
        setStep('done');
        void queryClient.invalidateQueries();
        toast.success(t('imports.doneToast'));
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const status = useQuery({
    queryKey: ['imports', 'status'],
    queryFn: () => api<ImportStatus>('/imports/status'),
    enabled: open && step === 'done' && (report?.imagesQueued ?? 0) > 0,
    refetchInterval: (q) => ((q.state.data?.images.pending ?? 0) > 0 ? 1500 : false),
  });

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    if (file.size > MAX_FILE_BYTES) {
      setFileError(t('imports.tooLarge'));
      return;
    }
    setFileName(file.name);
    file
      .text()
      .then((textContent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(textContent);
        } catch {
          setFileError(t('imports.notJson'));
          return;
        }
        setData(parsed);
        analyze.mutate(parsed);
      })
      .catch(() => setFileError(t('imports.notJson')));
  };

  const totalSelected = useMemo(
    () =>
      analysis
        ? [...selected].reduce(
            (sum, e) => sum + analysis.entities[e].total - analysis.entities[e].alreadyImported,
            0,
          )
        : 0,
    [analysis, selected],
  );

  const entityLabel = (e: ImportEntity) => t(`imports.entity.${e}` as TranslationKey);

  const renderReport = (r: ImportReport) => (
    <div className="import-report" data-testid="import-report">
      <table className="table table--compact">
        <thead>
          <tr>
            <th>{t('imports.what')}</th>
            <th className="right">{t('imports.created')}</th>
            <th className="right">{t('imports.skipped')}</th>
            <th className="right">{t('imports.failed')}</th>
          </tr>
        </thead>
        <tbody>
          {IMPORT_ENTITIES.filter((e) => selected.has(e)).map((e) => (
            <tr key={e} data-testid={`import-result-${e}`}>
              <td>{entityLabel(e)}</td>
              <td className="right num">{r.results[e].created}</td>
              <td className="right num muted">{r.results[e].skipped}</td>
              <td className={`right num${r.results[e].failed ? ' danger' : ' muted'}`}>
                {r.results[e].failed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.warnings.length > 0 && (
        <details className="import-warnings" open={r.warnings.length <= 6}>
          <summary>
            <AlertTriangle size={13} /> {t('imports.warnings', { count: r.warnings.length })}
          </summary>
          <ul>
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );

  const footer = (() => {
    if (step === 'file') {
      return (
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      );
    }
    if (step === 'choose') {
      return (
        <>
          <Button variant="ghost" onClick={() => setStep('file')} disabled={run.isPending}>
            {t('common.back')}
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            onClick={() => run.mutate(true)}
            disabled={selected.size === 0 || run.isPending}
            loading={run.isPending && run.variables === true}
            data-testid="import-dry-run"
          >
            <FlaskConical size={14} /> {t('imports.dryRun')}
          </Button>
          <Button
            variant="primary"
            onClick={() => run.mutate(false)}
            disabled={selected.size === 0 || !dryReport || run.isPending}
            loading={run.isPending && run.variables === false}
            data-testid="import-run"
          >
            <Import size={14} /> {t('imports.importNow')}
          </Button>
        </>
      );
    }
    return (
      <Button variant="primary" onClick={onClose} data-testid="import-close">
        {t('common.close')}
      </Button>
    );
  })();

  return (
    <Dialog
      open={open}
      onClose={run.isPending ? () => undefined : onClose}
      title={t('imports.title')}
      description={t('imports.subtitle')}
      size="lg"
      footer={footer}
      locked={run.isPending}
    >
      <ol className="import-steps" aria-label={t('imports.title')}>
        {(['file', 'choose', 'done'] as Step[]).map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined}>
            <span className="import-steps__n">{i + 1}</span>
            {t(`imports.step.${s}` as TranslationKey)}
          </li>
        ))}
      </ol>

      {step === 'file' && (
        <div className="import-file">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="import-file"
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div
            className="import-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pickFile(e.dataTransfer.files?.[0]);
            }}
          >
            {analyze.isPending ? (
              <Loader2 size={28} className="palette__spin" />
            ) : (
              <FileJson size={28} className="muted" />
            )}
            <div>
              <strong>{analyze.isPending ? t('imports.analyzing') : t('imports.dropHere')}</strong>
              <div className="faint">{t('imports.supported')}</div>
            </div>
            <Button
              onClick={() => fileInput.current?.click()}
              disabled={analyze.isPending}
              data-testid="import-pick"
            >
              <Upload size={14} /> {t('imports.chooseFile')}
            </Button>
          </div>
          {fileError && (
            <div data-testid="import-file-error">
              <Alert tone="danger">{fileError}</Alert>
            </div>
          )}
          <p className="faint" style={{ marginTop: 12 }}>
            {t('imports.howTo')}
          </p>
        </div>
      )}

      {step === 'choose' && analysis && (
        <div className="import-choose">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge tone="success">
              <CheckCircle2 size={12} /> {t('imports.recognised')}
            </Badge>
            <span className="muted">
              {fileName}
              {analysis.storeName ? ` · ${analysis.storeName}` : ''}
              {analysis.exportedAt
                ? ` · ${t('imports.exportedAt', { when: dateTime(analysis.exportedAt) })}`
                : ''}
            </span>
          </div>
          <div className="import-entities">
            {IMPORT_ENTITIES.map((e) => {
              const p = analysis.entities[e];
              const fresh = p.total - p.alreadyImported;
              return (
                <div
                  key={e}
                  className={`import-entity${p.total === 0 ? ' import-entity--empty' : ''}`}
                  data-testid={`import-entity-${e}`}
                >
                  <Checkbox
                    checked={selected.has(e)}
                    disabled={p.total === 0 || run.isPending}
                    onChange={(ev) => {
                      const next = new Set(selected);
                      if (ev.target.checked) next.add(e);
                      else next.delete(e);
                      setSelected(next);
                      setDryReport(null);
                    }}
                    label={
                      <span className="import-entity__title">
                        <strong>{entityLabel(e)}</strong>
                        <span className="num">{p.total}</span>
                        {p.alreadyImported > 0 && (
                          <Badge tone="warning">
                            {t('imports.alreadyImported', { count: p.alreadyImported })}
                          </Badge>
                        )}
                        {p.total > 0 && fresh === 0 && (
                          <Badge tone="default">{t('imports.nothingNew')}</Badge>
                        )}
                      </span>
                    }
                    description={
                      <span className="import-entity__meta">
                        {p.amountCents !== null && p.total > 0 && (
                          <span>{money(p.amountCents)}</span>
                        )}
                        {p.from && p.to && (
                          <span>
                            {date(p.from)} – {date(p.to)}
                          </span>
                        )}
                        {p.sample.length > 0 && (
                          <span className="faint">{p.sample.join(', ')}</span>
                        )}
                      </span>
                    }
                  />
                </div>
              );
            })}
          </div>
          {analysis.notImported.some((n) => n.count > 0) && (
            <p className="faint" style={{ margin: '8px 0 0' }}>
              {t('imports.notImported')}{' '}
              {analysis.notImported
                .filter((n) => n.count > 0)
                .map((n) => `${n.key} (${n.count})`)
                .join(', ')}
            </p>
          )}
          {analysis.warnings.length > 0 && (
            <details className="import-warnings" open={analysis.warnings.length <= 4}>
              <summary>
                <AlertTriangle size={13} />{' '}
                {t('imports.warnings', { count: analysis.warnings.length })}
              </summary>
              <ul>
                {analysis.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {dryReport ? (
            <Alert tone="info">
              <strong>{t('imports.dryRunResult')}</strong> {t('imports.dryRunHint')}
              {renderReport(dryReport)}
            </Alert>
          ) : (
            <Alert tone="info">{t('imports.dryRunFirst', { count: totalSelected })}</Alert>
          )}
          <p className="faint" style={{ margin: 0 }}>
            {t('imports.backupNote')}
          </p>
        </div>
      )}

      {step === 'done' && report && (
        <div className="import-done">
          <Alert tone="success">
            <strong>{t('imports.done')}</strong>{' '}
            {t('imports.doneHint', { ms: Math.round(report.durationMs / 100) / 10 })}
          </Alert>
          {renderReport(report)}
          {report.imagesQueued > 0 && (
            <div
              className="row"
              style={{ gap: 8, alignItems: 'center' }}
              data-testid="import-images"
            >
              {(status.data?.images.pending ?? report.imagesQueued) > 0 ? (
                <Loader2 size={14} className="palette__spin" />
              ) : (
                <CheckCircle2 size={14} className="success" />
              )}
              <span className="muted">
                {t('imports.images', {
                  done: status.data?.images.done ?? 0,
                  total: report.imagesQueued,
                  failed: status.data?.images.failed ?? 0,
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
