import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedUser, UserPreferences, UserPreferencesPatch } from '@likapcs/shared';
import { api, errorText } from '../api';
import { applyPrefs, cachedPrefs, PREFS_KEY, usePrefsQuery } from '../prefs';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Loading, Notice, QueryError } from '../components/ui';
import { useT } from '../i18n';
import { isQuiet, setQuietHours } from '../quiet';
import { PinSettings } from '../pinLock';

/**
 * Settings: how the phone looks. The choices are saved on the account, so the same username
 * gets the same look on every phone; the phone also keeps a copy to show the look before sign-in.
 */
export function Settings({ user, onSignOut }: { user: AuthenticatedUser; onSignOut: () => void }) {
  const t = useT();
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const prefs = usePrefsQuery(true);
  const [, setQuietTick] = useState(0);
  const current: UserPreferences = prefs.data ?? cachedPrefs();

  const save = useMutation({
    mutationFn: (patch: UserPreferencesPatch) =>
      api<UserPreferences>('/auth/preferences', { method: 'PUT', body: patch }),
    onSuccess: (saved) => {
      qc.setQueryData(PREFS_KEY, saved);
      applyPrefs(saved);
      notify(t('Cilësimet u ruajtën.'));
    },
    onError: (err) => {
      if (prefs.data) applyPrefs(prefs.data); // put back the saved look
      notify(errorText(err), 'err');
    },
  });

  const change = (patch: UserPreferencesPatch) => {
    applyPrefs({ ...current, ...patch }); // the look changes at once
    save.mutate(patch);
  };

  if (prefs.isLoading && !prefs.data) return <Loading />;
  if (prefs.error && !prefs.data) {
    return <QueryError message={t('Cilësimet nuk u ngarkuan.')} onRetry={() => void prefs.refetch()} />;
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t('Cilësimet')}</h1>
          <span className="muted small">{t('Ruhen për llogarinë «{user}»', { user: user.username })}</span>
        </div>
      </div>

      <section className="stack-sm">
        <h2>{t('Pamja')}</h2>
        <div className="card stack">
          <Choices<UserPreferences['theme']>
            label={t('Tema')}
            value={current.theme}
            onChange={(theme) => change({ theme })}
            disabled={!online || save.isPending}
            options={[
              { value: 'dark', label: t('Errët') },
              { value: 'light', label: t('Ndritshëm') },
              { value: 'system', label: t('Sipas telefonit') },
            ]}
          />
          <Choices<UserPreferences['textSize']>
            label={t('Madhësia e tekstit')}
            value={current.textSize}
            onChange={(textSize) => change({ textSize })}
            disabled={!online || save.isPending}
            options={[
              { value: 'normal', label: t('Normale') },
              { value: 'large', label: t('Të mëdha') },
            ]}
          />
          <Choices<UserPreferences['language']>
            label={t('Gjuha')}
            value={current.language}
            onChange={(language) => change({ language })}
            disabled={!online || save.isPending}
            options={[
              { value: 'sq', label: t('Shqip') },
              { value: 'en', label: t('English') },
            ]}
          />
          {!online && <Notice tone="warn">{t('Pa lidhje me serverin. Ndryshimet ruhen kur të lidheni.')}</Notice>}
        </div>
      </section>

      <section className="stack-sm">
        <h2>{t('Njoftimet')}</h2>
        <div className="card stack">
          <Choices<'on' | 'quiet'>
            label={t('Tingujt e njoftimeve')}
            value={isQuiet() ? 'quiet' : 'on'}
            onChange={(v) => {
              setQuietHours(v === 'quiet' ? 1 : 0);
              setQuietTick((n) => n + 1);
              notify(v === 'quiet' ? t('Tingujt fiken për 1 orë në këtë telefon.') : t('Tingujt u ndezën.'));
            }}
            options={[
              { value: 'on', label: t('Aktive') },
              { value: 'quiet', label: t('Hesht 1 orë') },
            ]}
          />
          <span className="muted small">{t('Njoftimet e sistemit shfaqen gjithmonë; tingulli varet nga kanali i telefonit.')}</span>
        </div>
      </section>

      <section className="stack-sm">
        <h2>{t('Siguria')}</h2>
        <PinSettings />
      </section>

      <section className="stack-sm">
        <h2>{t('Llogaria')}</h2>
        <div className="card">
          <div className="kv">
            <span>{t('Emri')}</span>
            <strong>{user.fullName || user.username}</strong>
          </div>
          <div className="kv">
            <span>{t('Përdoruesi')}</span>
            <strong>{user.username}</strong>
          </div>
          <div className="kv">
            <span>{t('Roli')}</span>
            <strong>{user.roles.length > 0 ? user.roles.join(', ') : '—'}</strong>
          </div>
        </div>
        <Btn variant="danger" block onClick={onSignOut}>
          {t('Dil nga llogaria')}
        </Btn>
      </section>
    </div>
  );
}
