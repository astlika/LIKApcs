import { useState, type FormEvent } from 'react';
import type { LoginResponse } from '@likapcs/shared';
import { api, ApiError, setToken } from '../api';

/**
 * Phone sign-in: username + e-mail + password, all three (0.28.0). Nothing is remembered besides
 * the token on this phone.
 */
export function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
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
        setError('Llogaria është e kyçur përkohësisht. Provoni më vonë.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Shumë përpjekje. Prisni një minutë.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Hyrja dështoi.');
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
        <label className="field">
          <span>Përdoruesi</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>E-mail</span>
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
          <span>Fjalëkalimi</span>
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
          {busy ? 'Duke hyrë…' : 'Hyr'}
        </button>
      </form>
    </div>
  );
}
