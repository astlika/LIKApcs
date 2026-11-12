import { useState, type FormEvent } from 'react';
import type { LoginResponse } from '@likapcs/shared';
import { api, ApiError, setToken } from '../api';
import { getServerUrl, isNative, normalizeServerUrl, setServerUrl } from '../native';
import { translate, useT } from '../i18n';

/**
 * Phone sign-in: username + e-mail + password, all three (0.28.0). Nothing is remembered besides
 * the token on this phone.
 */
export function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(() => getServerUrl() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (isNative()) {
      const url = normalizeServerUrl(server);
      if (!url) {
        setError(translate('Adresa e serverit nuk është e saktë. Shembull: http://100.x.y.z:4700'));
        return;
      }
      setServerUrl(url);
    }
    setBusy(true);
    try {
      const res = await api<LoginResponse>('/auth/phone-login', {
        method: 'POST',
        body: { username: username.trim(), email: email.trim(), password, rememberMe: true },
      });
      setToken(res.token);
      setPassword('');
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setError(translate('Llogaria është e kyçur përkohësisht. Provoni më vonë.'));
      } else if (err instanceof ApiError && err.status === 429) {
        setError(translate('Shumë përpjekje. Prisni një minutë.'));
      } else {
        setError(err instanceof ApiError ? err.message : translate('Hyrja dështoi.'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login__card" onSubmit={submit}>
        <div className="login__brand">
          <div className="brand-mark">LK</div>
          <div>
            <h1>LIKApcs</h1>
            <p className="muted">Hyrja nga telefoni</p>
          </div>
        </div>
        {notice && <p className="alert">{notice}</p>}
        {isNative() && (
          <label className="field">
            <span>{t('Serveri LIKApcs')}</span>
            <input
              autoCapitalize="none"
              inputMode="url"
              placeholder="http://100.x.y.z:4700"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              required
            />
          </label>
        )}
        <label className="field">
          <span>{t('Përdoruesi')}</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>{t('E-mail')}</span>
          <input
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>{t('Fjalëkalimi')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="alert alert--danger">{error}</p>}
        <button className="primary big" type="submit" disabled={busy}>
          {busy ? t('Duke hyrë…') : t('Hyr')}
        </button>
      </form>
    </div>
  );
}
