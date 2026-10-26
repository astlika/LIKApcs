/**
 * CS2 match server (0.24.0): pick the PC that runs the server, install/start/stop it there, join
 * the chosen PCs with one click, and send the match commands (freezetime, restart, warmup end).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gamepad2, Play, Plug, RotateCw, Square } from 'lucide-react';
import {
  PERMISSIONS,
  type Cs2Preset,
  type Cs2StatusResponse,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
} from '../components/ui/primitives';

const doneKey = {
  install: 'cs2.done.install',
  start: 'cs2.done.start',
  stop: 'cs2.done.stop',
} as const;

/** A labelled form field whose input does not need the generated id (one field per row). */
function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      {() => children}
    </Field>
  );
}

interface Cs2ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export function Cs2Page() {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.STATIONS_MANAGE);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);

  // Refresh every 5 s so the latest result from the server PC (start, stop, install…) shows up.
  const status = useQuery({
    queryKey: ['cs2'],
    queryFn: () => api<Cs2StatusResponse>('/cs2'),
    refetchInterval: 5000,
  });
  const stations = useQuery({
    queryKey: ['stations', false],
    queryFn: () => api<StationSummary[]>('/stations'),
  });

  const [draft, setDraft] = useState({
    serverStationId: '',
    serverAddress: '',
    port: '27015',
    map: 'de_dust2',
    maxPlayers: '10',
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<string>('');

  // Copy the saved config into the form once it arrives (and again after each save).
  useEffect(() => {
    const c = status.data?.config;
    if (!c) return;
    setDraft({
      serverStationId: c.serverStationId ?? '',
      serverAddress: c.serverAddress,
      port: String(c.port),
      map: c.map,
      maxPlayers: String(c.maxPlayers),
    });
  }, [status.data]);

  const pcs = useMemo(
    () => (stations.data ?? []).filter((s) => s.isEnabled && s.device !== null),
    [stations.data],
  );
  const onlinePcs = pcs.filter((s) => s.status !== 'offline');

  const handleError = (err: unknown) => {
    const message = err instanceof ApiError ? err.message : t('common.errorGeneric');
    setLastResult(message);
    toast.error(message);
  };
  const report = (result: Cs2ActionResult, okText: string) => {
    const text = result.ok
      ? (result.message ?? okText)
      : (result.error ?? t('common.errorGeneric'));
    setLastResult(text);
    if (result.ok) toast.success(text);
    else toast.error(text);
  };

  const save = useMutation({
    mutationFn: () =>
      api<Cs2StatusResponse>('/cs2', {
        method: 'PATCH',
        body: {
          serverStationId: draft.serverStationId || null,
          serverAddress: draft.serverAddress.trim(),
          port: Number(draft.port),
          map: draft.map.trim(),
          maxPlayers: Number(draft.maxPlayers),
        },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['cs2'], data);
      toast.success(t('cs2.saved'));
    },
    onError: handleError,
  });

  const regenerate = useMutation({
    mutationFn: (kind: 'rcon' | 'player') =>
      api<Cs2StatusResponse>(`/cs2/passwords/${kind}`, { method: 'POST' }),
    onSuccess: (data) => {
      queryClient.setQueryData(['cs2'], data);
      toast.success(t('cs2.passwordNew'));
    },
    onError: handleError,
  });

  const serverAction = useMutation({
    mutationFn: (action: 'install' | 'start' | 'stop') =>
      api<Cs2ActionResult>(`/cs2/server/${action}`, { method: 'POST' }),
    onSuccess: (r, action) => report(r, t(doneKey[action])),
    onError: handleError,
  });

  const connect = useMutation({
    mutationFn: () =>
      api<{ results: { stationId: string; ok: boolean; error?: string }[] }>('/cs2/connect', {
        method: 'POST',
        body: { stationIds: picked },
      }),
    onSuccess: (r) => {
      const failed = r.results.filter((x) => !x.ok).length;
      const text =
        failed === 0
          ? t('cs2.connectSent', { count: r.results.length })
          : t('cs2.connectPartial', { failed, total: r.results.length });
      setLastResult(text);
      if (failed === 0) toast.success(text);
      else toast.error(text);
    },
    onError: handleError,
  });

  const match = useMutation({
    mutationFn: (preset: Cs2Preset) =>
      api<{ command: string; output: string }>('/cs2/rcon', {
        method: 'POST',
        body: { preset },
      }),
    onSuccess: (r) => {
      const text = `${r.command}${r.output ? ` → ${r.output}` : ''}`;
      setLastResult(text);
      toast.success(text);
    },
    onError: handleError,
  });

  if (status.isLoading || stations.isLoading) return <Loading />;
  if (!status.data) return <EmptyState title={t('common.errorGeneric')} />;

  const cfg = status.data.config;
  const server = status.data.serverStation;
  const togglePc = (id: string, on: boolean) =>
    setPicked((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  return (
    <div className="page">
      <PageHeader title={t('cs2.title')} subtitle={t('cs2.intro')} />

      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t('cs2.serverPc')}</h3>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          }}
        >
          <Labeled label={t('cs2.serverPc')}>
            <Select
              value={draft.serverStationId}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, serverStationId: e.target.value })}
            >
              <option value="">{t('cs2.chooseServerPc')}</option>
              {pcs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Labeled>
          <Labeled label={t('cs2.serverAddress')} hint={t('cs2.serverAddressHint')}>
            <Input
              value={draft.serverAddress}
              disabled={!canManage}
              placeholder={status.data.resolvedAddress ?? '192.168.1.10'}
              onChange={(e) => setDraft({ ...draft, serverAddress: e.target.value })}
            />
          </Labeled>
          <Labeled label={t('cs2.port')}>
            <Input
              type="number"
              value={draft.port}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, port: e.target.value })}
            />
          </Labeled>
          <Labeled label={t('cs2.map')}>
            <Input
              value={draft.map}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, map: e.target.value })}
            />
          </Labeled>
          <Labeled label={t('cs2.maxPlayers')}>
            <Input
              type="number"
              value={draft.maxPlayers}
              disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, maxPlayers: e.target.value })}
            />
          </Labeled>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {canManage && (
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              {t('cs2.saveSettings')}
            </Button>
          )}
          {canManage && (
            <>
              <Button variant="ghost" onClick={() => regenerate.mutate('rcon')}>
                <RotateCw size={14} /> {t('cs2.regenRcon')}
              </Button>
              <Button variant="ghost" onClick={() => regenerate.mutate('player')}>
                <RotateCw size={14} /> {t('cs2.regenPlayer')}
              </Button>
            </>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {t('cs2.passwords')}: RCON {cfg.rconPasswordSet ? t('cs2.set') : t('cs2.notSet')} ·{' '}
          {t('cs2.playerPassword')} {cfg.playerPasswordSet ? t('cs2.set') : t('cs2.notSet')}
        </p>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>
          {t('cs2.serverStatus')}:{' '}
          {server ? (
            <span>
              {server.name} — {server.online ? t('cs2.online') : t('cs2.offline')}
            </span>
          ) : (
            t('cs2.noServerPc')
          )}
        </h3>
        {server?.lastResult && (
          <p
            style={{
              margin: '0 0 8px',
              color: server.lastResult.ok ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)',
            }}
          >
            {t('cs2.serverLastResult')}: {server.lastResult.message}
            <span className="muted"> ({new Date(server.lastResult.at).toLocaleTimeString()})</span>
          </p>
        )}
        {status.data.resolvedAddress && (
          <p className="muted">
            {t('cs2.addressInUse')}: {status.data.resolvedAddress}:{cfg.port}
          </p>
        )}
        {canControl && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="ghost"
              loading={serverAction.isPending && serverAction.variables === 'install'}
              disabled={!server?.online}
              onClick={() => serverAction.mutate('install')}
            >
              <Gamepad2 size={14} /> {t('cs2.install')}
            </Button>
            <Button
              disabled={!server?.online}
              loading={serverAction.isPending && serverAction.variables === 'start'}
              onClick={() => serverAction.mutate('start')}
            >
              <Play size={14} /> {t('cs2.start')}
            </Button>
            <Button
              variant="ghost"
              disabled={!server?.online}
              loading={serverAction.isPending && serverAction.variables === 'stop'}
              onClick={() => serverAction.mutate('stop')}
            >
              <Square size={14} /> {t('cs2.stop')}
            </Button>
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t('cs2.pcs')}</h3>
        {pcs.length === 0 ? (
          <EmptyState title={t('cs2.noPcs')} />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {pcs.map((s) => (
              <Checkbox
                key={s.id}
                checked={picked.includes(s.id)}
                disabled={!canControl || s.status === 'offline'}
                onChange={(e) => togglePc(s.id, e.target.checked)}
                label={`${s.name} (${s.code})${s.status === 'offline' ? ` — ${t('cs2.offline')}` : ''}`}
              />
            ))}
          </div>
        )}
        {canControl && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setPicked(onlinePcs.map((s) => s.id))}>
              {t('cs2.selectOnline')}
            </Button>
            <Button
              disabled={picked.length === 0 || !server?.online}
              loading={connect.isPending}
              onClick={() => connect.mutate()}
            >
              <Plug size={14} /> {t('cs2.connectSelected')}
            </Button>
          </div>
        )}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('cs2.match')}</h3>
        {canControl && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="ghost"
              loading={match.isPending}
              onClick={() => match.mutate('freezetime')}
            >
              {t('cs2.freezetime')}
            </Button>
            <Button
              variant="ghost"
              loading={match.isPending}
              onClick={() => match.mutate('restart')}
            >
              {t('cs2.restart')}
            </Button>
            <Button loading={match.isPending} onClick={() => match.mutate('warmup_end')}>
              {t('cs2.warmupEnd')}
            </Button>
          </div>
        )}
        {lastResult && (
          <p className="muted" style={{ marginBottom: 0 }}>
            {t('cs2.lastResult')}: {lastResult}
          </p>
        )}
      </section>
    </div>
  );
}
