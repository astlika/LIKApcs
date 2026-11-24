/**
 * 0.36.0 — the registered customer of a session.
 *
 * `SessionCustomerDialog`: put a registered customer (or a typed name, or nobody) on one session
 * or on every selected one — while they run. A session used to get its customer only when it
 * started; afterwards only the text "name on this PC" could change, so a debt had no name to go to.
 *
 * `CustomerBillDialog`: what a customer has on the PCs right now and has not paid — time and
 * products, PC by PC — with what they owe from before and everything they bought (the statement).
 * One click from the customer's name on a PC.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound, UserRoundX, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { CustomerOpenBills, CustomerSummary, SessionSummary } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { formatHms } from '../../lib/session-time';
import { useToast } from '../../state/toast';
import { CustomerPicker } from '../customers/CustomerPicker';
import { StatementPanel } from '../customers/CustomerAccount';
import { Alert, Button, Dialog, Kbd, Loading } from '../ui/primitives';
import { PayBillItems } from './PaySessionsDialog';

export interface SessionCustomerTarget {
  sessionId: string;
  code: string;
  customerId: string | null;
  customerName: string | null;
}

export function SessionCustomerDialog({
  targets,
  onClose,
  onDone,
}: {
  targets: SessionCustomerTarget[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const only = targets.length === 1 ? targets[0]! : null;
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [name, setName] = useState(only && !only.customerId ? (only.customerName ?? '') : '');
  const attached = useQuery({
    queryKey: ['customers', only?.customerId],
    queryFn: () => api<CustomerSummary>(`/customers/${only!.customerId}`),
    enabled: !!only?.customerId,
    staleTime: 15_000,
  });
  const shown = customer ?? (name ? null : (attached.data ?? null));
  const hasAny = targets.some((x) => x.customerId || x.customerName);

  const save = useMutation({
    mutationFn: async (body: { customerId: string | null; customerName?: string | null }) => {
      const failed: string[] = [];
      for (const target of targets) {
        try {
          await api<SessionSummary>(`/sessions/${target.sessionId}/customer`, {
            method: 'PATCH',
            body,
          });
        } catch (err) {
          failed.push(`${target.code}: ${err instanceof ApiError ? err.message : 'failed'}`);
        }
      }
      return failed;
    },
    onSuccess: (failed, body) => {
      for (const key of [['sessions'], ['stations'], ['orders'], ['customers']])
        void queryClient.invalidateQueries({ queryKey: key });
      if (failed.length) toast.error(failed.join(' · '));
      else if (body.customerId || body.customerName)
        toast.success(
          t('sessionCustomer.saved', {
            name: customer?.name ?? body.customerName ?? '',
            n: targets.length,
          }),
        );
      else toast.success(t('sessionCustomer.cleared', { n: targets.length }));
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const typed = name.trim();
  const ready = !save.isPending && (!!customer || typed.length > 0);
  const submit = () => {
    if (!ready) return;
    save.mutate(customer ? { customerId: customer.id } : { customerId: null, customerName: typed });
  };
  useEnterSubmits(submit);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        only
          ? t('sessionCustomer.title', { code: only.code })
          : t('sessionCustomer.titleMany', { n: targets.length })
      }
      description={t('sessionCustomer.body')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          {hasAny && (
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() => save.mutate({ customerId: null, customerName: null })}
              data-testid="session-customer-clear"
            >
              <UserRoundX size={14} /> {t('sessionCustomer.clear')}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={save.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="session-customer-save"
          >
            <UserRound size={14} /> {t('common.save')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="session-customer">
        <CustomerPicker
          value={shown}
          onChange={(c) => {
            setCustomer(c);
            if (c) setName('');
          }}
          text={name}
          onTextChange={setName}
          allowFreeText
          allowCreate
          autoFocus
          placeholder={t('sessionCustomer.placeholder')}
        />
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          {t('sessionCustomer.hint')}
        </p>
      </div>
    </Dialog>
  );
}

export function CustomerBillDialog({
  customerId,
  onClose,
  onPay,
}: {
  customerId: string;
  onClose: () => void;
  /** "Pay": the caller opens the payment window for these sessions. */
  onPay?: (sessionIds: string[]) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const customer = useQuery({
    queryKey: ['customers', customerId],
    queryFn: () => api<CustomerSummary>(`/customers/${customerId}`),
    staleTime: 5_000,
  });
  const open = useQuery({
    queryKey: ['sessions', 'open-bills', customerId],
    queryFn: () => api<CustomerOpenBills>('/sessions/open-bills', { query: { customerId } }),
    refetchInterval: 15_000,
  });
  const c = customer.data;
  const bills = open.data?.bills ?? [];
  const nowCents = open.data?.totalCents ?? 0;
  const debtCents = c?.balanceDueCents ?? 0;
  const payable = bills.filter((b) => b.session.dueCents + b.session.openOrdersCents > 0);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={c?.name ?? t('customerBill.title')}
      description={c?.phone ?? t('customerBill.body')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.close')} <Kbd>Esc</Kbd>
          </Button>
          {onPay && payable.length > 0 && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => onPay(payable.map((b) => b.session.id))}
              data-testid="customer-bill-pay"
            >
              <Wallet size={14} />{' '}
              {t('sessions.collectAmount', {
                amount: fmt.money(
                  payable.reduce(
                    (acc, b) => acc + b.session.dueCents + b.session.openOrdersCents,
                    0,
                  ),
                ),
              })}
            </Button>
          )}
        </>
      }
    >
      <div className="stack" data-testid="customer-bill">
        {(customer.isLoading || open.isLoading) && <Loading />}
        {customer.isError && <Alert tone="danger">{t('common.errorGeneric')}</Alert>}
        {c && (
          <div className="customer-bill__totals">
            <div data-testid="customer-bill-now">
              <span className="muted">{t('customerBill.now')}</span>
              <strong className="num">{fmt.money(nowCents)}</strong>
            </div>
            <div data-testid="customer-bill-debt" data-warn={debtCents > 0 || undefined}>
              <span className="muted">{t('customerBill.debt')}</span>
              <strong className="num">{fmt.money(debtCents)}</strong>
            </div>
            <div data-testid="customer-bill-all">
              <span className="muted">{t('customerBill.all')}</span>
              <strong className="num">{fmt.money(nowCents + debtCents)}</strong>
            </div>
          </div>
        )}
        {open.data && bills.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {t('customerBill.nothingNow')}
          </p>
        )}
        {bills.length > 0 && (
          <ul className="pay-bills" data-testid="customer-bill-pcs">
            {bills.map(({ session, items }) => (
              <li key={session.id} className="pay-bill">
                <div className="pay-bill__head">
                  <strong className="pay-bill__code">{session.stationCode}</strong>
                  <span className="pay-bill__who">
                    {session.status === 'active' || session.status === 'paused'
                      ? t('customerBill.running', { time: formatHms(session.billableSeconds) })
                      : t('customerBill.ended')}
                  </span>
                  <strong className="pay-bill__amount num">
                    {fmt.money(session.dueCents + session.openOrdersCents)}
                  </strong>
                </div>
                {(session.dueCents > 0 || items.length === 0) && (
                  <div className="pay-bill__lines">
                    {session.dueCents > 0 && (
                      <span>
                        {t('pay.time')} <b className="num">{fmt.money(session.dueCents)}</b>
                      </span>
                    )}
                    {session.dueCents === 0 && items.length === 0 && (
                      <span className="faint">{t('customerBill.paidSoFar')}</span>
                    )}
                  </div>
                )}
                {/* 0.40.0: the products one per line, each with the time it was put on the bill. */}
                <PayBillItems items={items} />
              </li>
            ))}
          </ul>
        )}
        {c && (
          <>
            <h3 className="customer-bill__heading">{t('customerBill.bought')}</h3>
            <StatementPanel customer={c} />
          </>
        )}
      </div>
    </Dialog>
  );
}
