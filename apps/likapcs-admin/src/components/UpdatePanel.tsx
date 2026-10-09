import { CheckCircle2, Download, ExternalLink, RefreshCw, Rocket } from 'lucide-react';
import { useI18n } from '../i18n';
import { useFormat } from '../lib/format';
import { GITHUB_RELEASES_URL } from '../lib/updater';
import { useUpdates } from '../state/updates';
import { Alert, Button, Card } from './ui/primitives';

const ADMIN_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

/** Settings › About › Software updates. */
export function UpdatePanel() {
  const { t } = useI18n();
  const fmt = useFormat();
  const u = useUpdates();

  return (
    <Card title={t('settings.updates.title')}>
      <div className="stack">
        <div className="row row--between">
          <span className="muted">{t('settings.updates.current')}</span>
          <strong className="num">v{ADMIN_VERSION}</strong>
        </div>

        {!u.supported && (
          <>
            <Alert tone="info">{t('settings.updates.browserOnly')}</Alert>
            <div>
              <a className="btn" href={GITHUB_RELEASES_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={15} /> {t('settings.updates.openReleases')}
              </a>
            </div>
          </>
        )}

        {u.supported && (
          <>
            {u.status === 'up-to-date' && (
              <Alert tone="info" icon={<CheckCircle2 size={18} />}>
                {t('settings.updates.upToDate')}
                {u.lastCheckedAt && <span className="faint"> · {fmt.time(u.lastCheckedAt)}</span>}
              </Alert>
            )}
            {u.status === 'error' && (
              <Alert tone="danger">{t('settings.updates.failed', { error: u.error ?? '' })}</Alert>
            )}

            {u.update &&
              (u.status === 'available' ||
                u.status === 'downloading' ||
                u.status === 'installing' ||
                u.status === 'installed' ||
                u.status === 'error') && (
                <div className="update-box">
                  <div className="row row--between row--wrap">
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>
                        <Rocket size={16} />{' '}
                        {t('settings.updates.available', { version: u.update.version })}
                      </div>
                      {u.update.date && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {t('settings.updates.releasedOn', { date: fmt.date(u.update.date) })}
                        </div>
                      )}
                    </div>
                    {u.status === 'available' || u.status === 'error' ? (
                      <Button variant="primary" onClick={() => void u.install()}>
                        <Download size={15} /> {t('settings.updates.install')}
                      </Button>
                    ) : null}
                  </div>
                  {u.update.notes && (
                    <div style={{ marginTop: 10 }}>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                        {t('settings.updates.notes')}
                      </div>
                      <pre className="json" style={{ whiteSpace: 'pre-wrap' }}>
                        {u.update.notes}
                      </pre>
                    </div>
                  )}
                  {u.status === 'downloading' && (
                    <div style={{ marginTop: 12 }}>
                      <div className="progress">
                        <div className="progress__bar" style={{ width: `${u.progress ?? 15}%` }} />
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {t('settings.updates.downloading', { percent: u.progress ?? 0 })}
                      </div>
                    </div>
                  )}
                  {u.status === 'installing' && (
                    <div className="muted" style={{ marginTop: 10 }}>
                      {t('settings.updates.installing')}
                    </div>
                  )}
                  {u.status === 'installed' && (
                    <div className="row" style={{ marginTop: 10 }}>
                      <span className="text-success">{t('settings.updates.installed')}</span>
                      <Button size="sm" onClick={() => void u.relaunch()}>
                        {t('settings.updates.restart')}
                      </Button>
                    </div>
                  )}
                </div>
              )}

            <div className="row row--between row--wrap">
              <span className="faint" style={{ fontSize: 12 }}>
                {t('settings.updates.source')}
              </span>
              <Button
                onClick={() => void u.check()}
                loading={u.status === 'checking'}
                disabled={u.status === 'downloading' || u.status === 'installing'}
              >
                <RefreshCw size={15} />{' '}
                {u.status === 'checking'
                  ? t('settings.updates.checking')
                  : t('settings.updates.check')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
