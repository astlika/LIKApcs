import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActiveSessionSummary, PaymentMethod, SessionQuoteResponse, StationSummary } from '@likapcs/shared';
import { api, duration, errorText, money, newRequestId } from '../api';
import { BILLING_LABEL, METHOD_LABEL, STATION_LABEL, STATION_TONE } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Loading, Notice, QueryError, Sheet, cx } from '../components/ui';

const START_MINUTES = [30, 60, 90, 120, 180];
const EXTEND_MINUTES = [15, 30, 60, 120];
const PAY_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'other'];
const methodOptions = PAY_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }));

/** PC list: live status, who is on it, and the running time. Tap a PC to act on it. */
export function Pcs({ canControl }: { canControl: boolean }) {
  const { data, error, isLoading, refetch } = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error || !data) return <QueryError message="Nuk u ngarkuan PC-të." onRetry={() => void refetch()} />;

  const shown = data.filter((s) => s.isEnabled);
  const busy = shown.filter((s) => s.activeSession).length;
  const selected = shown.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>PC-të</h1>
        <span className="muted">
          {busy} nga {shown.length} në përdorim
        </span>
      </div>

      {shown.length === 0 && <p className="empty">Nuk ka PC aktive.</p>}

      <ul className="list">
        {shown.map((s) => {
          const session = s.activeSession;
          const tone = STATION_TONE[s.status] ?? 'off';
          return (
            <li key={s.id}>
              <button
                type="button"
                className={cx('pc-row', `pc-row--${tone}`)}
                onClick={() => setSelectedId(s.id)}
                aria-label={`${s.name}, ${STATION_LABEL[s.status] ?? s.status}`}
              >
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

      {selected && (
        <PcSheet station={selected} canControl={canControl} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function useRequestId() {
  const [id] = useState(newRequestId);
  return id;
}

function PcSheet({ station, canControl, onClose }: { station: StationSummary; canControl: boolean; onClose: () => void }) {
  const session = station.activeSession;
  return (
    <Sheet title={station.name} onClose={onClose}>
      <p className="muted">
        {station.code}
        {station.zone ? ` · ${station.zone}` : ''} · {STATION_LABEL[station.status] ?? station.status}
      </p>
      {!canControl && <Notice tone="warn">Nuk keni leje për të kontrolluar PC-të nga telefoni.</Notice>}
      {canControl && session && <RunningPc stationId={station.id} stationName={station.name} session={session} onDone={onClose} />}
      {canControl && !session && station.status === 'available' && <StartPc stationId={station.id} stationName={station.name} onDone={onClose} />}
      {canControl && !session && station.status !== 'available' && (
        <Notice tone="warn">
          Kjo PC nuk mund të nisët tani ({STATION_LABEL[station.status] ?? station.status}).
        </Notice>
      )}
    </Sheet>
  );
}

/** Start a PC: prepaid minutes (paid now) or open time (paid when it ends). */
function StartPc({ stationId, stationName, onDone }: { stationId: string; stationName: string; onDone: () => void }) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const requestId = useRequestId();
  const [mode, setMode] = useState<'prepaid' | 'postpaid'>('prepaid');
  const [minutes, setMinutes] = useState(60);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [customerName, setCustomerName] = useState('');

  const quote = useQuery({
    queryKey: ['phone', 'quote', stationId, minutes],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId, billingMode: 'prepaid', minutes },
      }),
    enabled: mode === 'prepaid',
  });

  const start = useMutation({
    mutationFn: () =>
      api('/sessions', {
        method: 'POST',
        body: {
          stationId,
          billingMode: mode,
          ...(mode === 'prepaid' ? { minutes, paymentMethod: method } : { payments: [] }),
          customerName: customerName.trim() || undefined,
          clientRequestId: requestId,
        },
      }),
    onSuccess: () => {
      notify(`${stationName} u nis.`);
      void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
      onDone();
    },
  });

  const price = mode === 'prepaid' ? quote.data?.priceCents : undefined;
  const canSubmit = online && !start.isPending && (mode === 'postpaid' || (price !== undefined && price >= 0));

  return (
    <div className="stack">
      <Choices
        label="Mënyra e pagesës së kohës"
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
            <span>Paguhet tani</span>
            <strong>{quote.isFetching ? '…' : money(price)}</strong>
          </div>
          <Choices label="Pagesa" value={method} onChange={setMethod} options={methodOptions} />
        </>
      ) : (
        <Notice tone="info">Koha llogaritet gjatë përdorimit. Pagesa bëhet kur të ndalet PC-ja.</Notice>
      )}

      <label className="field">
        <span className="field__label">Emri i klientit (opsionale)</span>
        <input
          value={customerName}
          maxLength={80}
          autoComplete="off"
          placeholder="p.sh. Arben"
          onChange={(e) => setCustomerName(e.target.value)}
        />
      </label>

      {!online && <Notice tone="danger">Pa lidhje me serverin. PC-ja nuk mund të nisët tani.</Notice>}
      {start.isError && <Notice tone="danger">{errorText(start.error)}</Notice>}

      <Btn block onClick={() => start.mutate()} disabled={!canSubmit}>
        {start.isPending ? 'Duke nisur…' : mode === 'prepaid' ? `Nis PC-në · ${money(price)}` : 'Nis PC-në'}
      </Btn>
    </div>
  );
}

/** A PC that is running or paused: pause/resume, add time, stop and collect. */
function RunningPc({
  stationId,
  stationName,
  session,
  onDone,
}: {
  stationId: string;
  stationName: string;
  session: ActiveSessionSummary;
  onDone: () => void;
}) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const [panel, setPanel] = useState<'extend' | 'stop' | null>(null);
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
        <div className="grid-2">
          <div>
            <span className="muted small">Koha</span>
            <strong className="block">{duration(session.elapsedSeconds)}</strong>
          </div>
          <div>
            <span className="muted small">{prepaid ? 'Mbeten' : 'Për t’u paguar'}</span>
            <strong className="block">
              {prepaid ? (session.remainingSeconds !== null ? duration(session.remainingSeconds) : '—') : money(session.currentPriceCents)}
            </strong>
          </div>
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
              <Btn variant="ghost" onClick={() => setPanel('extend')} disabled={!online}>
                Shto kohë
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

      {panel === 'extend' && (
        <ExtendPanel stationId={stationId} sessionId={session.id} onBack={() => setPanel(null)} onDone={() => { notify(`${stationName}: koha u shtua.`); refresh(); onDone(); }} />
      )}
      {panel === 'stop' && (
        <StopPanel
          sessionId={session.id}
          prepaid={prepaid}
          amountCents={session.currentPriceCents}
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

function ExtendPanel({
  stationId,
  sessionId,
  onBack,
  onDone,
}: {
  stationId: string;
  sessionId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const online = useOnline();
  const requestId = useRequestId();
  const [minutes, setMinutes] = useState(30);
  const [method, setMethod] = useState<PaymentMethod>('cash');

  const quote = useQuery({
    queryKey: ['phone', 'quote', stationId, minutes, 'extend'],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId, billingMode: 'prepaid', minutes },
      }),
  });

  const extend = useMutation({
    mutationFn: () =>
      api(`/sessions/${sessionId}/extend`, {
        method: 'POST',
        body: { minutes, paymentMethod: method, clientRequestId: requestId },
      }),
    onSuccess: onDone,
  });

  const price = quote.data?.priceCents;
  return (
    <div className="stack">
      <Choices
        label="Shto"
        value={minutes}
        onChange={setMinutes}
        options={EXTEND_MINUTES.map((m) => ({ value: m, label: `${m} min` }))}
      />
      <div className="total-row">
        <span>Paguhet tani</span>
        <strong>{quote.isFetching ? '…' : money(price)}</strong>
      </div>
      <Choices label="Pagesa" value={method} onChange={setMethod} options={methodOptions} />
      {extend.isError && <Notice tone="danger">{errorText(extend.error)}</Notice>}
      <div className="grid-2">
        <Btn variant="ghost" onClick={onBack}>
          Kthehu
        </Btn>
        <Btn onClick={() => extend.mutate()} disabled={!online || extend.isPending || price === undefined}>
          {extend.isPending ? 'Duke ruajtur…' : `Shto · ${money(price)}`}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Stop the PC. Prepaid time was paid at the start, so nothing is taken. Open time is billed to
 * the minute: the server computes the exact amount, so only the payment method is sent.
 */
function StopPanel({
  sessionId,
  prepaid,
  amountCents,
  onBack,
  onDone,
}: {
  sessionId: string;
  prepaid: boolean;
  amountCents: number;
  onBack: () => void;
  onDone: () => void;
}) {
  const online = useOnline();
  const [method, setMethod] = useState<PaymentMethod>('cash');

  const stop = useMutation({
    mutationFn: () =>
      api(`/sessions/${sessionId}/end`, {
        method: 'POST',
        body: prepaid ? { payments: [] } : { paymentMethod: method },
      }),
    onSuccess: onDone,
  });

  return (
    <div className="stack">
      {prepaid ? (
        <Notice tone="warn">
          Koha e paguar nuk kthehet. PC-ja ndalet tani.
        </Notice>
      ) : (
        <>
          <div className="total-row">
            <span>Shuma deri tani</span>
            <strong>{money(amountCents)}</strong>
          </div>
          <Notice tone="info">Shuma përfundimtare llogaritet në server sipas kohës së saktë.</Notice>
          <Choices label="Arkëtohet me" value={method} onChange={setMethod} options={methodOptions} />
        </>
      )}
      {stop.isError && <Notice tone="danger">{errorText(stop.error)}</Notice>}
      <div className="grid-2">
        <Btn variant="ghost" onClick={onBack}>
          Kthehu
        </Btn>
        <Btn variant="danger" onClick={() => stop.mutate()} disabled={!online || stop.isPending}>
          {stop.isPending ? 'Duke ndaluar…' : prepaid ? 'Ndalo' : 'Ndalo dhe arkëto'}
        </Btn>
      </div>
    </div>
  );
}
