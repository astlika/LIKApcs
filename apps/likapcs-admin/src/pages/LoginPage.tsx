import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Globe, Lock, Radar, Server, User } from 'lucide-react';
import type { HealthResponse, SetupStatusResponse } from '@likapcs/shared';
import { api, ApiError, getServerUrl, setServerUrl } from '../lib/api';
import { storage } from '../lib/storage';
import { isDesktopApp } from '../lib/updater';
import { discoverServers, embeddedServerInfo, type DiscoveredServer } from '../lib/desktop';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useAppSettings } from '../state/app-settings';
import { Alert, Button, Field, Input, Segmented } from '../components/ui/primitives';

export function LoginPage() {
  const { t, language, setLanguage } = useI18n();
  const auth = useAuth();
  const settings = useAppSettings();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrlState] = useState(getServerUrl());
  const [serverTest, setServerTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredServer[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const autoDiscovered = useRef(false);
  const desktop = isDesktopApp();

  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatusResponse>('/system/setup-status', { auth: false }),
    retry: false,
  });

  useEffect(() => {
    if (setup.data && !storageHasLanguage()) setLanguage(setup.data.defaultLanguage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.data]);
  useEffect(() => {
    if (setup.isError) setShowServer(true);
  }, [setup.isError]);
  // Secondary Admin PC with no saved address: the default (this PC) is unreachable, so look for
  // the main PC on the network once and adopt it automatically when exactly one server answers.
  useEffect(() => {
    if (!setup.isError || !desktop || autoDiscovered.current || storage.get('serverUrl') !== null)
      return;
    autoDiscovered.current = true;
    void (async () => {
      const local = await embeddedServerInfo().catch(() => null);
      if (local?.available) return; // main PC: the server is started by the app itself
      await runDiscovery();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.isError, desktop]);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    auth.clearExpiredNotice();
    try {
      await auth.login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isNetwork) setError(t('common.networkError'));
        else if (err.code === 'account_locked') setError(t('auth.locked'));
        else if (err.status === 401) setError(t('auth.invalid'));
        else setError(err.message);
      } else setError(t('common.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const testServer = async (url = serverUrl) => {
    setServerUrl(url);
    setServerTest(null);
    try {
      const health = await api<HealthResponse>('/system/health', { auth: false });
      setServerTest({ ok: true, message: t('auth.connectionOk', { version: health.version }) });
      void setup.refetch();
    } catch (err) {
      setServerTest({
        ok: false,
        message: t('auth.connectionFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const chooseServer = (url: string) => {
    setServerUrlState(url);
    setDiscovered(null);
    void testServer(url);
  };

  async function runDiscovery() {
    setDiscovering(true);
    setServerTest(null);
    try {
      const found = await discoverServers(2500);
      if (found.length === 1 && found[0]?.urls[0]) {
        chooseServer(found[0].urls[0]);
      } else {
        setDiscovered(found);
        setShowServer(true);
        if (found.length === 0) setServerTest({ ok: false, message: t('auth.noServersFound') });
      }
    } catch (err) {
      setServerTest({
        ok: false,
        message: t('auth.connectionFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth__card" onSubmit={submit}>
        <div className="auth__brand">
          <div className="brand-mark">LK</div>
          <div>
            <div className="auth__title">{t('auth.welcomeBack')}</div>
            <div className="muted">
              {t('auth.signInTo', {
                business: setup.data?.businessName ?? settings['business.name'],
              })}
            </div>
          </div>
        </div>
        {auth.expiredNotice && <Alert tone="warning">{t('auth.sessionExpired')}</Alert>}
        {setup.isError && (
          <Alert tone="danger" icon={<Server size={16} />}>
            {t('common.networkError')}
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('auth.username')}>
          {(id) => (
            <div className="input-group">
              <User size={16} />
              <Input
                id={id}
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          )}
        </Field>
        <Field label={t('auth.password')}>
          {(id) => (
            <div className="input-group">
              <Lock size={16} />
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t('auth.signIn')}
        </Button>
        {showServer && (
          <div className="stack" style={{ paddingTop: 4 }}>
            <Field label={t('auth.serverAddress')} hint={t('auth.serverAddressHint')}>
              {(id) => (
                <Input
                  id={id}
                  placeholder={t('auth.serverAddressPlaceholder')}
                  value={serverUrl}
                  onChange={(e) => setServerUrlState(e.target.value)}
                />
              )}
            </Field>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Button size="sm" onClick={() => void testServer()}>
                <Globe size={14} /> {t('auth.testConnection')}
              </Button>
              {desktop && (
                <Button size="sm" onClick={() => void runDiscovery()} loading={discovering}>
                  <Radar size={14} /> {t('auth.findServer')}
                </Button>
              )}
              {serverTest && (
                <span
                  className={serverTest.ok ? 'text-success' : 'text-danger'}
                  style={{ fontSize: 12.5 }}
                >
                  {serverTest.message}
                </span>
              )}
            </div>
            {discovered && discovered.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {t('auth.serversFound', { n: discovered.length })}
                </span>
                {discovered.map((srv) => (
                  <button
                    key={srv.installationId}
                    type="button"
                    className="btn btn--ghost"
                    style={{ justifyContent: 'space-between' }}
                    onClick={() => srv.urls[0] && chooseServer(srv.urls[0])}
                  >
                    <span>{srv.name}</span>
                    <span className="muted num">
                      {srv.urls[0]} · v{srv.version}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="auth__footer">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowServer((v) => !v)}
          >
            <Server size={14} /> {t('auth.serverAddress')}
          </button>
          <Segmented
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'en', label: 'EN' },
              { value: 'sq', label: 'SQ' },
            ]}
          />
        </div>
      </form>
    </div>
  );
}

function storageHasLanguage(): boolean {
  try {
    return window.localStorage.getItem('likapcs.language') !== null;
  } catch {
    return false;
  }
}
