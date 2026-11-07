import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActiveSessionSummary, CustomerSummary, PaymentMethod, SessionQuoteResponse, StationSummary } from '@likapcs/shared';
import { api, duration, errorText, money, newRequestId, ApiError } from '../api';
import { BILLING_LABEL, METHOD_LABEL, STATION_LABEL, STATION_TONE } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Loading, Notice, QueryError, Sheet, cx } from '../components/ui';
import { CustomerPicker } from '../components/CustomerPicker';

const START_MINUTES = [30, 60, 90, 120, 180];
const PAY_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'other'];
/** How a PC is paid. `credit` opens a debt on the customer (requires a customer). */
type PcMethod = PaymentMethod | 'credit';

interface WakeOutcome {
  name: string;
  ok: boolean;
  message: string;
}

export interface PcPerms {
  canControl: boolean;
  canCredit: boolean;
  canPower: boolean;
}

/**
 * PC list: live status, who is on it and the running time. Tap a PC to act on it, or use
 * "Zgjidh" to pick several PCs and start or power them on together.
 */
export function Pcs(perms: PcPerms) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const { data, error, isLoading, refetch } = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [startIds, setStartIds] = useState<string[] | null>(null);
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeResults, setWakeResults] = useState<WakeOutcome[] | null>(null);

  if (isLoading) return <Loading />;
  if (error || !data) return <QueryError message="Nuk u ngarkuan PC-të." onRetry={() => void refetch()} />;

  const shown = data.filter((s) => s.isEnabled);
  const busy = shown.filter((s) => s.activeSession).length;
  const selected = shown.filter((s) => picked.includes(s.id));
  const startable = selected.filter((s) => s.status === 'available');
  const wakeable = selected.filter((s) => s.status === 'offline');
  const openStation = shown.find((s) => s.id === openId) ?? null;
  const startStations = shown.filter((s) => startIds?.includes(s.id) && s.status === 'available');

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const leaveSelecting = () => {
    setSelecting(false);
    setPicked([]);
  };

  const wakeMany = async (list: StationSummary[]) => {
    setWakeBusy(true);
    const results: WakeOutcome[] = [];
    for (const s of list) {
      try {
        await api(`/stations/${s.id}/wake`, { method: 'POST' });
        results.push({ name: s.name, ok: true, message: 'Sinjali u dërgua. PC-ja po ndizet.' });
      } catch (err) {
        results.push({ name: s.name, ok: false, message: errorText(err) });
      }
    }
    setWakeBusy(false);
    setWakeResults(results);
    void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>PC-të</h1>
          <span className="muted small">
            {busy} nga {shown.length} në përdorim
          </span>
        </div>
        <div className="select-tools">
          {selecting && (
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => setPicked(picked.length === shown.length ? [] : shown.map((s) => s.id))}
            >
              {picked.length === shown.length && shown.length > 0 ? 'Asnjë' : 'Të gjitha'}
            </button>
          )}
          <button
            type="button"
            className={cx('ghost small-btn', selecting && 'ghost--on')}
            aria-pressed={selecting}
            onClick={() => (selecting ? leaveSelecting() : setSelecting(true))}
          >
            {selecting ? 'Mbyll' : 'Zgjidh'}
          </button>
        </div>
      </div>

      {shown.length === 0 && <p className="empty">Nuk ka PC aktive.</p>}

      <ul className="list">
        {shown.map((s) => {
          const session = s.activeSession;
          const tone = STATION_TONE[s.status] ?? 'off';
          const on = picked.includes(s.id);
          return (
            <li key={s.id}>
              <button
                type="button"
                className={cx('pc-row', `pc-row--${tone}`, on && 'pc-row--picked')}
                onClick={() => (selecting ? toggle(s.id) : setOpenId(s.id))}
                aria-pressed={selecting ? on : undefined}
                aria-label={`${s.name}, ${STATION_LABEL[s.status] ?? s.status}`}
              >
                {selecting && <span className={cx('check', on && 'check--on')} aria-hidden="true">{on ? '✓' : ''}</span>}
                <span className="pc-row__main">
                  <strong>{s.name}</strong>
                  <span className="muted small">
                    {session
                      ? `${session.customerName ?? 'Pa emër'} · ${duration(session.elapsedSeconds)}`
                      : s.zone ?? s.code}
                  </span>
                </span>
                <span className="pc-row__side">
                  <span className={cx('badge', `badge--${tone}`)}>{STATION_LABEL[s.status] ?? s.status}</span>
                  {session && <span className="pc-row__money">{money(session.currentPriceCents)}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selecting && picked.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Veprime për PC-të e zgjedhura">
          <span className="bulk-bar__count">{selected.length} të zgjedhura</span>
          <div className="bulk-bar__btns">
            {perms.canPower && wakeable.length > 0 && (
              <Btn variant="ghost" onClick={() => void wakeMany(wakeable)} disabled={!online || wakeBusy}>
                {wakeBusy ? 'Duke ndezur…' : `Ndiz (${wakeable.length})`}
              </Btn>
            )}
            {perms.canControl && startable.length > 0 && (
              <Btn
                onClick={() => {
                  setStartIds(startable.map((s) => s.id));
                }}
                disabled={!online}
              >
                {`Nis (${startable.length})`}
              </Btn>
            )}
          </div>
          {!online && <span className="small text-danger">Pa lidhje me serverin.</span>}
        </div>
      )}

      {openStation && (
        <PcSheet station={openStation} perms={perms} onClose={() => setOpenId(null)} />
      )}

      {startIds && startStations.length > 0 && (
        <Sheet
          title={startStations.length === 1 ? `Nis ${startStations[0]?.name}` : `Nis ${startStations.length} PC`}
          onClose={() => setStartIds(null)}
        >
          <StartPc
            stations={startStations}
            canCredit={perms.canCredit}
            onDone={() => {
              setStartIds(null);
              leaveSelecting();
            }}
          />
        </Sheet>
      )}

      {wakeResults && (
        <Sheet title="Ndezja e PC-ve" onClose={() => setWakeResults(null)}>
          <ul className="list">
            {wakeResults.map((r) => (
              <li key={r.name} className="result-row">
                <span className={cx('result-dot', r.ok ? 'result-dot--ok' : 'result-dot--err')} aria-hidden="true" />
                <span>
                  <strong>{r.name}</strong>
                  <span className="muted small block">{r.message}</span>
                </span>
              </li>
            ))}
          </ul>
          <Btn block onClick={() => setWakeResults(null)}>
            Mbyll
          </Btn>
        </Sheet>
      )}
    </div>
  );
}

function PcSheet({ station, perms, onClose }: { station: StationSummary; perms: PcPerms; onClose: () => void }) {
  const session = station.activeSession;
  return (
    <Sheet title={station.name} onClose={onClose}>
      <p className="muted">
        {station.code}
        {station.zone ? ` · ${station.zone}` : ''} · {STATION_LABEL[station.status] ?? station.status}
      </p>
      {!perms.canControl && <Notice tone="warn">Nuk keni leje për të kontrolluar PC-të nga telefoni.</Notice>}
      {perms.canControl && session && (
        <RunningPc stationId={station.id} stationName={station.name} session={session} canCredit={perms.canCredit} onDone={onClose} />
      )}
      {perms.canControl && !session && station.status === 'available' && (
        <StartPc stations={[station]} canCredit={perms.canCredit} onDone={onClose} />
      )}
      {!session && station.status === 'offline' && perms.canPower && <WakeButton station={station} />}
      {!session && station.status !== 'available' && station.status !== 'offline' && (
        <Notice tone="warn">Kjo PC nuk mund të nisët tani ({STATION_LABEL[station.status] ?? station.status}).</Notice>
      )}
      {!session && station.status === 'offline' && !perms.canPower && (
        <Notice tone="warn">PC-ja është offline. Ndezja kërkon lejen «Fuqia e PC-ve».</Notice>
      )}
    </Sheet>
  );
}

/** Wake-on-LAN: sends the power-on signal to an offline PC that has a network card on record. */
function WakeButton({ station }: { station: StationSummary }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [sent, setSent] = useState<string | null>(null);
  const wake = useMutation({
    mutationFn: () => api(`/stations/${station.id}/wake`, { method: 'POST' }),
    onSuccess: () => {
      setSent('Sinjali u dërgua. Prisni disa sekonda që PC-ja të ndizet.');
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['phone', 'stations'] }), 4000);
    },
  });
  return (
    <div className="stack-sm">
      <Notice tone="info">PC-ja është offline. Mund ta ndizni nga telefoni.</Notice>
      {wake.isError && <Notice tone="danger">{errorText(wake.error)}</Notice>}
      {sent && <Notice tone="ok">{sent}</Notice>}
      <Btn block variant="ghost" onClick={() => wake.mutate()} disabled={!online || wake.isPending}>
        {wake.isPending ? 'Duke ndezur…' : 'Ndiz PC-në'}
      </Btn>
    </div>
  );
}

/**
 * Start one or more PCs with the same settings. Prepaid: the time is paid now. Open time: the
 * bill is settled when the PC stops. Each PC gets its own request key, so a retry never starts
 * a second session on the same PC.
 */
function StartPc({ stations, canCredit, onDone }: { stations: StationSummary[]; canCredit: boolean; onDone: () => void }) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const [pending, setPending] = useState<StationSummary[]>(stations);
  const [mode, setMode] = useState<'prepaid' | 'postpaid'>('prepaid');
  const [minutes, setMinutes] = useState(60);
  const [method, setMethod] = useState<PcMethod>('cash');
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [failed, setFailed] = useState<{ id: string; name: string; message: string }[]>([]);
  const requestIds = useRef(new Map<string, string>());

  // A new request key for new settings: a key must never be reused for a different request.
  useEffect(() => {
    requestIds.current.clear();
  }, [mode, minutes, method, customer?.id, customerName]);

  const quotes = useQueries({
    queries: pending.map((s) => ({
      queryKey: ['phone', 'quote', s.id, minutes, 'start'],
      queryFn: () =>
        api<SessionQuoteResponse>('/sessions/quote', {
          method: 'POST',
          body: { stationId: s.id, billingMode: 'prepaid', minutes },
        }),
      enabled: mode === 'prepaid',
    })),
  });
  const priceOf = (index: number): number => quotes[index]?.data?.priceCents ?? 0;
  const total = mode === 'prepaid' ? quotes.reduce((sum, q) => sum + (q.data?.priceCents ?? 0), 0) : 0;
  const quotesReady = mode === 'postpaid' || quotes.every((q) => q.data !== undefined);
  const isCredit = method === 'credit';

  const run = useMutation({
    mutationFn: async () => {
      const outcomes: { id: string; name: string; message: string | null }[] = [];
      for (const [index, s] of pending.entries()) {
        const price = priceOf(index);
        const pay =
          mode === 'prepaid'
            ? isCredit
              ? { payments: price > 0 ? [{ method: 'credit', amountCents: price }] : [] }
              : { paymentMethod: method as PaymentMethod }
            : { payments: [] };
        let key = requestIds.current.get(s.id);
        if (!key) {
          key = newRequestId();
          requestIds.current.set(s.id, key);
        }
        try {
          await api('/sessions', {
            method: 'POST',
            body: {
              stationId: s.id,
              billingMode: mode,
              ...(mode === 'prepaid' ? { minutes } : {}),
              ...pay,
              ...(customer ? { customerId: customer.id } : customerName.trim() ? { customerName: customerName.trim() } : {}),
              clientRequestId: key,
            },
          });
          outcomes.push({ id: s.id, name: s.name, message: null });
        } catch (err) {
          outcomes.push({ id: s.id, name: s.name, message: errorText(err) });
        }
      }
      return outcomes;
    },
    onSuccess: (outcomes) => {
      void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
      const ok = outcomes.filter((o) => !o.message);
      const bad = outcomes.filter((o) => o.message);
      if (bad.length === 0) {
        notify(ok.length === 1 ? `${ok[0]?.name} u nis.` : `U nisën ${ok.length} PC.`);
        onDone();
        return;
      }
      setPending((p) => p.filter((s) => !ok.some((o) => o.id === s.id)));
      setFailed(bad.map((o) => ({ id: o.id, name: o.name, message: o.message ?? '' })));
      if (ok.length > 0) notify(`U nisën ${ok.length} PC. Disa nuk u nisën.`, 'err');
    },
  });

  const creditBlocked = isCredit && !customer;
  const canSubmit = online && !run.isPending && pending.length > 0 && quotesReady && !creditBlocked;

  const payOptions: { value: PcMethod; label: string }[] = [
    ...PAY_METHODS.map((m) => ({ value: m as PcMethod, label: METHOD_LABEL[m] ?? m })),
    ...(canCredit ? [{ value: 'credit' as PcMethod, label: 'Me borxh' }] : []),
  ];

  return (
    <div className="stack">
      {pending.length > 1 && (
        <p className="muted small">PC-të: {pending.map((s) => s.name).join(', ')}</p>
      )}

      <Choices
        label="Mënyra e kohës"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'prepaid', label: 'Paraprake' },
          { value: 'postpaid', label: 'Pas përdorimit' },
        ]}
      />

      {mode === 'prepaid' ? (
        <>
          <Choices
            label="Kohëzgjatja"
            value={minutes}
            onChange={setMinutes}
            options={START_MINUTES.map((m) => ({ value: m, label: `${m} min` }))}
          />
          <div className="total-row">
            <span>{pending.length > 1 ? `Paguhet tani (${pending.length} PC)` : 'Paguhet tani'}</span>
            <strong>{quotes.some((q) => q.isFetching) ? '…' : money(total)}</strong>
          </div>
          <Choices label="Pagesa" value={method} onChange={setMethod} options={payOptions} />
        </>
      ) : (
        <Notice tone="info">Koha llogaritet gjatë përdorimit. Pagesa bëhet kur të ndalet PC-ja.</Notice>
      )}

      <CustomerPicker selected={customer} onSelect={setCustomer} label="Klienti (opsional)" />
      {!customer && (
        <label className="field">
          <span className="field__label">Emri i klientit (opsional)</span>
          <input
            value={customerName}
            maxLength={80}
            autoComplete="off"
            placeholder="p.sh. Arben"
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </label>
      )}
      {creditBlocked && <Notice tone="warn">Për pagesë me borxh zgjidhni klientin.</Notice>}
      {isCredit && customer && mode === 'prepaid' && (
        <Notice tone="info">
          {money(total)} shtohet te borxhi i {customer.name}.
        </Notice>
      )}

      {!online && <Notice tone="danger">Pa lidhje me serverin. PC-ja nuk mund të nisët tani.</Notice>}
      {failed.map((f) => (
        <Notice key={f.id} tone="danger">
          {f.name}: {f.message}
        </Notice>
      ))}

      <Btn block onClick={() => run.mutate()} disabled={!canSubmit}>
        {run.isPending
          ? 'Duke nisur…'
          : mode === 'prepaid'
            ? `Nis ${pending.length > 1 ? `${pending.length} PC` : 'PC-në'} · ${money(total)}`
            : `Nis ${pending.length > 1 ? `${pending.length} PC` : 'PC-në'}`}
      </Btn>
    </div>
  );
}

/** A PC that is running or paused: pause/resume, add or remove time, stop and collect. */
function RunningPc({
  stationId,
  stationName,
  session,
  canCredit,
  onDone,
}: {
  stationId: string;
  stationName: string;
  session: ActiveSessionSummary;
  canCredit: boolean;
  onDone: () => void;
}) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<'time' | 'stop' | null>(null);
  const paused = session.status === 'paused';
  const prepaid = session.billingMode === 'prepaid';

  const refresh = () => void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });

  const toggle = useMutation({
    mutationFn: () => api(`/sessions/${session.id}/${paused ? 'resume' : 'pause'}`, { method: 'POST' }),
    onSuccess: () => {
      notify(paused ? `${stationName}: vazhdoi.` : `${stationName}: pauzë.`);
      refresh();
    },
  });

  return (
    <div className="stack">
      <div className="card card--flat stack-sm">
        <div className="row row--between">
          <span className="muted">{BILLING_LABEL[session.billingMode] ?? session.billingMode}</span>
          <span className={cx('badge', paused ? 'badge--warn' : 'badge--ok')}>{paused ? 'Në pauzë' : 'Në punë'}</span>
        </div>
        <p className="big-line">{session.customerName ?? 'Pa emër klienti'}</p>
        <div className="clock-grid">
          <div>
            <span className="muted small">Koha e shpenzuar</span>
            <strong>{duration(session.elapsedSeconds)}</strong>
          </div>
          {prepaid ? (
            <div>
              <span className="muted small">Kohë e mbetur</span>
              <strong>{session.remainingSeconds !== null ? duration(session.remainingSeconds) : '—'}</strong>
            </div>
          ) : (
            <div>
              <span className="muted small">Për t’u paguar</span>
              <strong>{money(session.currentPriceCents)}</strong>
            </div>
          )}
        </div>
      </div>

      {toggle.isError && <Notice tone="danger">{errorText(toggle.error)}</Notice>}

      {panel === null && (
        <div className="stack-sm">
          <div className="grid-2">
            <Btn variant="ghost" onClick={() => toggle.mutate()} disabled={!online || toggle.isPending}>
              {paused ? 'Vazhdo' : 'Pauzë'}
            </Btn>
            {prepaid ? (
              <Btn variant="ghost" onClick={() => setPanel('time')} disabled={!online}>
                Shto / hiq kohë
              </Btn>
            ) : (
              <span />
            )}
          </div>
          <Btn variant="danger" block onClick={() => setPanel('stop')} disabled={!online}>
            {prepaid ? 'Ndalo PC-në' : 'Ndalo dhe arkëto'}
          </Btn>
          {!online && <Notice tone="danger">Pa lidhje me serverin. Veprimet me para janë të bllokuara.</Notice>}
        </div>
      )}

      {panel === 'time' && (
        <TimePanel
          stationId={stationId}
          sessionId={session.id}
          remainingSeconds={session.remainingSeconds}
          onBack={() => setPanel(null)}
          onDone={(text) => {
            notify(`${stationName}: ${text}`);
            refresh();
            setPanel(null);
          }}
        />
      )}
      {panel === 'stop' && (
        <StopPanel
          sessionId={session.id}
          prepaid={prepaid}
          amountCents={session.currentPriceCents}
          canCredit={canCredit}
          onBack={() => setPanel(null)}
          onDone={() => {
            notify(prepaid ? `${stationName}: u ndal.` : `${stationName}: u ndal dhe u arkëtua.`);
            refresh();
            onDone();
          }}
        />
      )}
    </div>
  );
}

const ADD_MINUTES = [15, 30, 60, 120];
const REMOVE_MINUTES = [5, 10, 15, 30, 60];

/**
 * Add or remove prepaid minutes. Adding is paid now (like the desk). Removing takes minutes off
 * the running time and gives no money back, so the choices stop at what is left on the clock.
 */
function TimePanel({
  stationId,
  sessionId,
  remainingSeconds,
  onBack,
  onDone,
}: {
  stationId: string;
  sessionId: string;
  remainingSeconds: number | null;
  onBack: () => void;
  onDone: (text: string) => void;
}) {
  const online = useOnline();
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [minutes, setMinutes] = useState(30);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [requestId, setRequestId] = useState(newRequestId);

  // The server keeps at least one second on the clock.
  const maxRemove = remainingSeconds === null ? 0 : Math.max(0, Math.floor((remainingSeconds - 1) / 60));
  const removable = REMOVE_MINUTES.filter((m) => m <= maxRemove);

  // A new key for new settings: a key is never reused for a different request.
  useEffect(() => {
    setRequestId(newRequestId());
  }, [mode, minutes, method]);

  const switchMode = (next: 'add' | 'remove') => {
    setMode(next);
    if (next === 'add') setMinutes(30);
    else setMinutes(removable[removable.length - 1] ?? 5);
  };

  const quote = useQuery({
    queryKey: ['phone', 'quote', stationId, minutes, 'extend'],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId, billingMode: 'prepaid', minutes },
      }),
    enabled: mode === 'add',
  });

  const add = useMutation({
    mutationFn: () =>
      api(`/sessions/${sessionId}/extend`, {
        method: 'POST',
        body: { minutes, paymentMethod: method, clientRequestId: requestId },
      }),
    onSuccess: () => onDone(`koha u shtua (${minutes} min).`),
  });

  const remove = useMutation({
    mutationFn: () =>
      api(`/sessions/${sessionId}/remove-time`, {
        method: 'POST',
        body: { minutes, clientRequestId: requestId },
      }),
    onSuccess: () => onDone(`u hoqën ${minutes} min.`),
  });

  const price = quote.data?.priceCents;
  const busy = add.isPending || remove.isPending;
  const error = add.error ?? remove.error;

  return (
    <div className="time-panel">
      <Choices<'add' | 'remove'>
        label="Veprimi"
        value={mode}
        onChange={switchMode}
        disabled={busy}
        options={[
          { value: 'add', label: 'Shto kohë' },
          { value: 'remove', label: 'Hiq kohë' },
        ]}
      />

      {mode === 'add' ? (
        <>
          <Choices
            label="Shto"
            value={minutes}
            onChange={setMinutes}
            options={ADD_MINUTES.map((m) => ({ value: m, label: `${m} min` }))}
          />
          <div className="total-row">
            <span>Paguhet tani</span>
            <strong>{quote.isFetching ? '…' : money(price)}</strong>
          </div>
          <Choices
            label="Pagesa"
            value={method}
            onChange={setMethod}
            options={PAY_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))}
          />
        </>
      ) : (
        <>
          {removable.length === 0 ? (
            <Notice tone="warn">Koha e mbetur është shumë e shkurtër. Nuk mund të hiqet asnjë minutë.</Notice>
          ) : (
            <Choices
              label="Hiq"
              value={minutes}
              onChange={setMinutes}
              options={REMOVE_MINUTES.map((m) => ({ value: m, label: `${m} min`, disabled: m > maxRemove }))}
            />
          )}
          <p className="time-hint">Minutat e hequra nuk kthehen në para. Koha e mbetur zvogëlohet menjëherë.</p>
        </>
      )}

      {!online && <Notice tone="danger">Pa lidhje me serverin.</Notice>}
      {error && <Notice tone="danger">{errorText(error)}</Notice>}

      <div className="grid-2">
        <Btn variant="ghost" onClick={onBack} disabled={busy}>
          Kthehu
        </Btn>
        {mode === 'add' ? (
          <Btn onClick={() => add.mutate()} disabled={!online || busy || price === undefined}>
            {add.isPending ? 'Duke ruajtur…' : `Shto · ${money(price)}`}
          </Btn>
        ) : (
          <Btn
            variant="danger"
            onClick={() => remove.mutate()}
            disabled={!online || busy || removable.length === 0 || minutes > maxRemove}
          >
            {remove.isPending ? 'Duke hequr…' : `Hiq ${minutes} min`}
          </Btn>
        )}
      </div>
    </div>
  );
}

/**
 * Stop the PC. Prepaid time was paid at the start, so nothing is taken. Open time is billed to
 * the minute by the server. Cash/card are sent as "the exact amount". A debt needs the exact
 * amount, so it is read from the server right before sending and retried once if the price
 * moved on the minute boundary.
 */
function StopPanel({
  sessionId,
  prepaid,
  amountCents,
  canCredit,
  onBack,
  onDone,
}: {
  sessionId: string;
  prepaid: boolean;
  amountCents: number;
  canCredit: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const online = useOnline();
  const qc = useQueryClient();
  const [method, setMethod] = useState<PcMethod>('cash');
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);

  const freshAmount = async (): Promise<number> => {
    const list = await qc.fetchQuery({
      queryKey: ['phone', 'stations'],
      queryFn: () => api<StationSummary[]>('/stations'),
      staleTime: 0,
    });
    return list.find((s) => s.activeSession?.id === sessionId)?.activeSession?.currentPriceCents ?? amountCents;
  };

  const stop = useMutation({
    mutationFn: async () => {
      if (prepaid) return api(`/sessions/${sessionId}/end`, { method: 'POST', body: { payments: [] } });
      if (method !== 'credit') {
        return api(`/sessions/${sessionId}/end`, { method: 'POST', body: { paymentMethod: method } });
      }
      for (let attempt = 0; ; attempt++) {
        const amount = await freshAmount();
        try {
          return await api(`/sessions/${sessionId}/end`, {
            method: 'POST',
            body: {
              customerId: customer?.id,
              payments: amount > 0 ? [{ method: 'credit', amountCents: amount }] : [],
            },
          });
        } catch (err) {
          const priceMoved = err instanceof ApiError && err.status === 400;
          if (!priceMoved || attempt >= 1) throw err;
        }
      }
    },
    onSuccess: onDone,
  });

  const isCredit = method === 'credit';
  const blocked = !online || stop.isPending || (isCredit && !customer);

  return (
    <div className="stack">
      {prepaid ? (
        <Notice tone="warn">Koha e paguar nuk kthehet. PC-ja ndalet tani.</Notice>
      ) : (
        <>
          <div className="total-row">
            <span>Shuma deri tani</span>
            <strong>{money(amountCents)}</strong>
          </div>
          <Notice tone="info">Shuma përfundimtare llogaritet në server sipas kohës së saktë.</Notice>
          <Choices
            label="Arkëtohet me"
            value={method}
            onChange={setMethod}
            options={[
              ...PAY_METHODS.map((m) => ({ value: m as PcMethod, label: METHOD_LABEL[m] ?? m })),
              ...(canCredit ? [{ value: 'credit' as PcMethod, label: 'Me borxh' }] : []),
            ]}
          />
          {isCredit && <CustomerPicker selected={customer} onSelect={setCustomer} label="Klienti (për borxhin)" required />}
          {isCredit && !customer && <Notice tone="warn">Për borxh zgjidhni klientin.</Notice>}
        </>
      )}
      {stop.isError && <Notice tone="danger">{errorText(stop.error)}</Notice>}
      <div className="grid-2">
        <Btn variant="ghost" onClick={onBack}>
          Kthehu
        </Btn>
        <Btn variant="danger" onClick={() => stop.mutate()} disabled={blocked}>
          {stop.isPending ? 'Duke ndaluar…' : prepaid ? 'Ndalo' : 'Ndalo dhe arkëto'}
        </Btn>
      </div>
    </div>
  );
}
