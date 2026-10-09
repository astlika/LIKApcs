import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Shield } from 'lucide-react';
import { useI18n } from '../i18n';
import { Alert, Badge, Button, Card, Switch } from './ui/primitives';
import {
  allowFirewall,
  autostartEnabled,
  embeddedServerInfo,
  embeddedServerRestart,
  setAutostart,
} from '../lib/desktop';

/**
 * Settings → System → "Server on this PC". Rendered only on the main PC (the installer put the
 * server runtime next to the Admin app). Everything here talks to the native shell, not the API,
 * so it also works while the server is down.
 */
export function LocalServerPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['embedded-server'],
    queryFn: embeddedServerInfo,
    refetchInterval: 5000,
  });
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    autostartEnabled()
      .then(setAutostartState)
      .catch(() => setAutostartState(null));
  }, []);

  const restart = useMutation({
    mutationFn: embeddedServerRestart,
    onSuccess: () => {
      setMessage({ tone: 'success', text: t('settings.localServer.restarted') });
      void qc.invalidateQueries({ queryKey: ['embedded-server'] });
      void qc.invalidateQueries({ queryKey: ['system-info'] });
    },
    onError: (err) =>
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : String(err) }),
  });
  const firewall = useMutation({
    mutationFn: allowFirewall,
    onSuccess: () => setMessage({ tone: 'success', text: t('settings.localServer.firewallOk') }),
    onError: (err) =>
      setMessage({
        tone: 'danger',
        text: t('settings.localServer.firewallFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      }),
  });

  const data = info.data;
  if (!data || !data.available) return null;

  const row = (label: string, value: ReactNode) => (
    <div
      className="row row--between"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', gap: 16 }}
    >
      <span className="muted" style={{ flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ wordBreak: 'break-all', textAlign: 'right' }}>{value}</span>
    </div>
  );

  return (
    <Card
      title={t('settings.localServer.title')}
      actions={
        <Badge tone={data.running ? 'success' : 'danger'}>
          {data.running ? t('settings.localServer.running') : t('settings.localServer.stopped')}
        </Badge>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {t('settings.localServer.intro')}
      </p>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <div style={{ marginTop: 12 }}>
        {row(t('settings.localServer.version'), data.version ?? '—')}
        {row(t('settings.localServer.port'), String(data.port))}
        {row(t('settings.localServer.dataDir'), <code>{data.dataDir}</code>)}
        {data.logFile && row(t('settings.localServer.logFile'), <code>{data.logFile}</code>)}
      </div>
      <div className="row" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
        <Button onClick={() => restart.mutate()} loading={restart.isPending}>
          <RefreshCw size={14} /> {t('settings.localServer.restart')}
        </Button>
        <Button onClick={() => firewall.mutate()} loading={firewall.isPending}>
          <Shield size={14} /> {t('settings.localServer.firewall')}
        </Button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {t('settings.localServer.firewallHint')}
      </p>
      {autostart !== null && (
        <div style={{ marginTop: 8 }}>
          <Switch
            checked={autostart}
            onChange={(v) => {
              setAutostartState(v);
              setAutostart(v).catch((err: unknown) => {
                setAutostartState(!v);
                setMessage({
                  tone: 'danger',
                  text: err instanceof Error ? err.message : String(err),
                });
              });
            }}
            label={t('settings.localServer.autostart')}
          />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {t('settings.localServer.autostartHint')}
          </div>
        </div>
      )}
    </Card>
  );
}
