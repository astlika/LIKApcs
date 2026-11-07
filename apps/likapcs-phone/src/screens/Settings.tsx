import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedUser, UserPreferences, UserPreferencesPatch } from '@likapcs/shared';
import { api, errorText } from '../api';
import { applyPrefs, cachedPrefs, PREFS_KEY, usePrefsQuery } from '../prefs';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Loading, Notice, QueryError } from '../components/ui';

/**
 * Settings: how the phone looks. The choices are saved on the account, so the same username
 * gets the same look on every phone; the phone also keeps a copy to show the look before sign-in.
 */
export function Settings({ user, onSignOut }: { user: AuthenticatedUser; onSignOut: () => void }) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const prefs = usePrefsQuery(true);
  const current: UserPreferences = prefs.data ?? cachedPrefs();

  const save = useMutation({
    mutationFn: (patch: UserPreferencesPatch) =>
      api<UserPreferences>('/auth/preferences', { method: 'PUT', body: patch }),
    onSuccess: (saved) => {
      qc.setQueryData(PREFS_KEY, saved);
      applyPrefs(saved);
      notify('Cilësimet u ruajtën.');
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
    return <QueryError message="Cilësimet nuk u ngarkuan." onRetry={() => void prefs.refetch()} />;
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Cilësimet</h1>
          <span className="muted small">Ruhen për llogarinë «{user.username}»</span>
        </div>
      </div>

      <section className="stack-sm">
        <h2>Pamja</h2>
        <div className="card stack">
          <Choices<UserPreferences['theme']>
            label="Tema"
            value={current.theme}
            onChange={(theme) => change({ theme })}
            disabled={!online || save.isPending}
            options={[
              { value: 'dark', label: 'Errët' },
              { value: 'light', label: 'Ndritshëm' },
              { value: 'system', label: 'Sipas telefonit' },
            ]}
          />
          <Choices<UserPreferences['textSize']>
            label="Madhësia e tekstit"
            value={current.textSize}
            onChange={(textSize) => change({ textSize })}
            disabled={!online || save.isPending}
            options={[
              { value: 'normal', label: 'Normale' },
              { value: 'large', label: 'Të mëdha' },
            ]}
          />
          {!online && <Notice tone="warn">Pa lidhje me serverin. Ndryshimet ruhen kur të lidheni.</Notice>}
        </div>
      </section>

      <section className="stack-sm">
        <h2>Llogaria</h2>
        <div className="card">
          <div className="kv">
            <span>Emri</span>
            <strong>{user.fullName || user.username}</strong>
          </div>
          <div className="kv">
            <span>Përdoruesi</span>
            <strong>{user.username}</strong>
          </div>
          <div className="kv">
            <span>Roli</span>
            <strong>{user.roles.length > 0 ? user.roles.join(', ') : '—'}</strong>
          </div>
        </div>
        <Btn variant="danger" block onClick={onSignOut}>
          Dil nga llogaria
        </Btn>
      </section>
    </div>
  );
}
