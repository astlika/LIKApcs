/**
 * Pricing: hourly rules (per station / weekday / time window, happy hours) and prepaid packages.
 * Money is edited as decimal text and converted to integer cents with the shared parser.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Package, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import {
  PERMISSIONS,
  formatMoney,
  parseMoneyInput,
  type GamingPackageSummary,
  type PricingRuleSummary,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Select,
  Switch,
} from '../components/ui/primitives';

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

export function PricingPage() {
  const { t, td } = useI18n();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PRICING_MANAGE);
  const queryClient = useQueryClient();
  const toast = useToast();
  const fmt = useFormat();

  const rules = useQuery({
    queryKey: ['pricing', 'rules'],
    queryFn: () => api<PricingRuleSummary[]>('/pricing/rules'),
  });
  const packages = useQuery({
    queryKey: ['pricing', 'packages'],
    queryFn: () => api<GamingPackageSummary[]>('/pricing/packages'),
  });
  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => api<StationSummary[]>('/stations'),
  });
  const stationList = stations.data ?? [];

  const [ruleDialog, setRuleDialog] = useState<{ rule: PricingRuleSummary | null } | null>(null);
  const [packageDialog, setPackageDialog] = useState<{ pkg: GamingPackageSummary | null } | null>(
    null,
  );
  const [remove, setRemove] = useState<{ kind: 'rule' | 'package'; id: string } | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['pricing'] });
  const deletion = useMutation({
    mutationFn: ({ kind, id }: { kind: 'rule' | 'package'; id: string }) =>
      api<void>(`/pricing/${kind === 'rule' ? 'rules' : 'packages'}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('pricing.deleted'));
      setRemove(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const dayLabel = (days: number[]) =>
    days.length === 7
      ? t('pricing.allDays')
      : days.map((d) => td(`pricing.weekdays.${d}`, String(d))).join(' ');
  const windowLabel = (start: string | null, end: string | null) =>
    start && end ? `${start}–${end}` : t('pricing.allDay');
  const stationNames = (ids: string[] | null) =>
    ids === null
      ? t('pricing.allStations')
      : ids.map((id) => stationList.find((s) => s.id === id)?.code ?? '?').join(', ');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t('pricing.title')}</h1>
          <p className="page-header__sub">{t('pricing.subtitle')}</p>
        </div>
      </div>

      <div className="stack" style={{ gap: 20 }}>
        <Card
          title={t('pricing.rules')}
          actions={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setRuleDialog({ rule: null })}>
                <Plus size={14} /> {t('pricing.addRule')}
              </Button>
            ) : undefined
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            {t('pricing.rulesHint')}
          </p>
          {rules.isLoading && <Loading />}
          {rules.isSuccess && rules.data.length === 0 && (
            <Alert tone="warning">{t('pricing.noRules')}</Alert>
          )}
          {rules.isSuccess && rules.data.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pricing.name')}</th>
                  <th>{t('pricing.station')}</th>
                  <th>{t('pricing.days')}</th>
                  <th>{t('pricing.timeWindow')}</th>
                  <th className="right">{t('pricing.rate')}</th>
                  <th className="right">{t('pricing.priority')}</th>
                  <th>{t('common.status')}</th>
                  {canManage && <th className="right">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      {r.isHappyHour && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge tone="purple">{t('pricing.happyHour')}</Badge>
                        </span>
                      )}
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.billingIncrementMinutes} min · min {r.minimumMinutes} min ·{' '}
                        {fmt.money(r.minimumChargeCents)}
                        {(r.validFrom || r.validTo) &&
                          ` · ${r.validFrom ?? '…'} → ${r.validTo ?? '…'}`}
                      </div>
                    </td>
                    <td>{r.stationCode ?? t('pricing.allStations')}</td>
                    <td>{dayLabel(r.daysOfWeek)}</td>
                    <td className="num">{windowLabel(r.startTime, r.endTime)}</td>
                    <td className="right num">
                      {fmt.money(r.rateCentsPerHour)}
                      {t('sessions.perHour')}
                    </td>
                    <td className="right num">{r.priority}</td>
                    <td>
                      <Badge tone={r.isActive ? 'success' : 'default'}>
                        {r.isActive ? t('pricing.active') : t('pricing.inactive')}
                      </Badge>
                    </td>
                    {canManage && (
                      <td className="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRuleDialog({ rule: r })}
                          aria-label={t('pricing.editRule')}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRemove({ kind: 'rule', id: r.id })}
                          aria-label={t('common.delete')}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title={t('pricing.packages')}
          actions={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setPackageDialog({ pkg: null })}>
                <Plus size={14} /> {t('pricing.addPackage')}
              </Button>
            ) : undefined
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            {t('pricing.packagesHint')}
          </p>
          {packages.isLoading && <Loading />}
          {packages.isSuccess && packages.data.length === 0 && (
            <EmptyState icon={<Package size={22} />} title={t('pricing.noPackages')} />
          )}
          {packages.isSuccess && packages.data.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pricing.name')}</th>
                  <th className="right">{t('pricing.duration')}</th>
                  <th className="right">{t('pricing.price')}</th>
                  <th>{t('pricing.stations')}</th>
                  <th>{t('pricing.days')}</th>
                  <th>{t('pricing.timeWindow')}</th>
                  <th>{t('common.status')}</th>
                  {canManage && <th className="right">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {packages.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.isPromotional && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge tone="accent">{t('pricing.promotional')}</Badge>
                        </span>
                      )}
                    </td>
                    <td className="right num">{p.durationMinutes} min</td>
                    <td className="right num">{fmt.money(p.priceCents)}</td>
                    <td>{stationNames(p.stationIds)}</td>
                    <td>{dayLabel(p.daysOfWeek)}</td>
                    <td className="num">{windowLabel(p.startTime, p.endTime)}</td>
                    <td>
                      <Badge tone={p.isActive ? 'success' : 'default'}>
                        {p.isActive ? t('pricing.active') : t('pricing.inactive')}
                      </Badge>
                    </td>
                    {canManage && (
                      <td className="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPackageDialog({ pkg: p })}
                          aria-label={t('pricing.editPackage')}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRemove({ kind: 'package', id: p.id })}
                          aria-label={t('common.delete')}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {ruleDialog && (
        <RuleDialog
          rule={ruleDialog.rule}
          stations={stationList}
          onClose={() => setRuleDialog(null)}
          onSaved={() => {
            setRuleDialog(null);
            toast.success(t('pricing.saved'));
            invalidate();
          }}
        />
      )}
      {packageDialog && (
        <PackageDialog
          pkg={packageDialog.pkg}
          stations={stationList}
          onClose={() => setPackageDialog(null)}
          onSaved={() => {
            setPackageDialog(null);
            toast.success(t('pricing.saved'));
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        onConfirm={() => remove && deletion.mutate(remove)}
        title={
          remove?.kind === 'rule' ? t('pricing.deleteRuleTitle') : t('pricing.deletePackageTitle')
        }
        body={
          remove?.kind === 'rule' ? t('pricing.deleteRuleBody') : t('pricing.deletePackageBody')
        }
        confirmLabel={t('common.delete')}
        danger
        loading={deletion.isPending}
      />
    </>
  );
}

// ─── Shared form bits ──────────────────────────────────────────────────────────
function DayPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  const { td } = useI18n();
  return (
    <div className="chips">
      {ALL_DAYS.map((d) => (
        <button
          key={d}
          type="button"
          className="chip"
          aria-pressed={value.includes(d)}
          onClick={() =>
            onChange(
              value.includes(d)
                ? value.filter((x) => x !== d)
                : [...value, d].sort((a, b) => a - b),
            )
          }
        >
          {td(`pricing.weekdays.${d}`, String(d))}
        </button>
      ))}
    </div>
  );
}

const centsToInput = (cents: number) =>
  formatMoney(cents, { showSymbol: true }).replace(/[^\d.,-]/g, '');
const toInt = (v: string) => (v.trim() === '' ? NaN : Number(v));
const inRange = (v: number, min: number, max: number) =>
  Number.isInteger(v) && v >= min && v <= max;

/**
 * Validation messages shown under the fields. Local checks run when Save is pressed (the button
 * is never silently disabled); server-side issues are merged in by field path, and anything that
 * targets a field we do not show is listed in the alert at the top — a rule must never fail to
 * save without saying why.
 */
type Issues = Partial<Record<string, string>>;
const KNOWN_RULE_FIELDS = [
  'name',
  'stationId',
  'rateCentsPerHour',
  'billingIncrementMinutes',
  'minimumMinutes',
  'minimumChargeCents',
  'roundingMode',
  'roundingIncrementCents',
  'daysOfWeek',
  'startTime',
  'endTime',
  'validFrom',
  'validTo',
  'priority',
];
const KNOWN_PACKAGE_FIELDS = [
  'name',
  'sortOrder',
  'durationMinutes',
  'priceCents',
  'stationIds',
  'daysOfWeek',
  'startTime',
  'endTime',
  'validFrom',
  'validTo',
];

/** Server issues that no visible field claims (so they still get shown). */
function unclaimedIssues(err: unknown, known: string[]): string[] {
  if (!(err instanceof ApiError)) return err ? [String((err as Error)?.message ?? err)] : [];
  if (Array.isArray(err.details)) {
    const issues = err.details as { path: string; message: string }[];
    const unclaimed = issues.filter(
      (i) => !known.some((f) => i.path === f || i.path.endsWith(`.${f}`)),
    );
    return unclaimed.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  }
  if (typeof err.details === 'object' && err.details && (err.details as { field?: string }).field)
    return [];
  return [err.message];
}

/** Scrolls the first invalid field of the dialog into view and focuses it. */
function focusFirstInvalid() {
  window.requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>('.dialog [aria-invalid="true"]');
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  });
}

// ─── Rule dialog ───────────────────────────────────────────────────────────────
interface RuleForm {
  name: string;
  stationId: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  rate: string;
  billingIncrementMinutes: string;
  minimumMinutes: string;
  minimumCharge: string;
  roundingMode: 'up' | 'down' | 'nearest';
  roundingIncrementCents: string;
  isHappyHour: boolean;
  priority: string;
  isActive: boolean;
  validFrom: string;
  validTo: string;
}

function RuleDialog({
  rule,
  stations,
  onClose,
  onSaved,
}: {
  rule: PricingRuleSummary | null;
  stations: StationSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<RuleForm>({
    name: rule?.name ?? '',
    stationId: rule?.stationId ?? '',
    daysOfWeek: rule?.daysOfWeek ?? ALL_DAYS,
    startTime: rule?.startTime ?? '',
    endTime: rule?.endTime ?? '',
    rate: rule ? centsToInput(rule.rateCentsPerHour) : '',
    billingIncrementMinutes: String(rule?.billingIncrementMinutes ?? 1),
    minimumMinutes: String(rule?.minimumMinutes ?? 0),
    minimumCharge: centsToInput(rule?.minimumChargeCents ?? 0),
    roundingMode: rule?.roundingMode ?? 'up',
    roundingIncrementCents: String(rule?.roundingIncrementCents ?? 1),
    isHappyHour: rule?.isHappyHour ?? false,
    priority: String(rule?.priority ?? 0),
    isActive: rule?.isActive ?? true,
    validFrom: rule?.validFrom ?? '',
    validTo: rule?.validTo ?? '',
  });
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const [error, setError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);
  const rateCents = parseMoneyInput(form.rate);
  const minimumCents = form.minimumCharge.trim() ? parseMoneyInput(form.minimumCharge) : 0;

  // Local validation (mirrors the server schema) — shown after the first Save attempt.
  const local: Issues = {};
  if (!form.name.trim()) local.name = t('common.required');
  if (rateCents === null || rateCents < 0) local.rateCentsPerHour = t('pricing.errors.money');
  if (minimumCents === null || minimumCents < 0)
    local.minimumChargeCents = t('pricing.errors.money');
  if (!inRange(toInt(form.billingIncrementMinutes), 1, 120))
    local.billingIncrementMinutes = t('pricing.errors.range', { min: 1, max: 120 });
  if (!inRange(toInt(form.minimumMinutes), 0, 600))
    local.minimumMinutes = t('pricing.errors.range', { min: 0, max: 600 });
  if (!inRange(toInt(form.roundingIncrementCents), 1, 1000))
    local.roundingIncrementCents = t('pricing.errors.range', { min: 1, max: 1000 });
  if (!inRange(toInt(form.priority), -100, 100))
    local.priority = t('pricing.errors.range', { min: -100, max: 100 });
  if (form.daysOfWeek.length === 0) local.daysOfWeek = t('pricing.errors.days');
  if ((form.startTime === '') !== (form.endTime === '')) {
    local[form.startTime === '' ? 'startTime' : 'endTime'] = t('pricing.errors.timeWindow');
  }
  if (form.validFrom && form.validTo && form.validTo < form.validFrom)
    local.validTo = t('pricing.errors.validRange');
  const issue = (field: string) =>
    (attempted ? local[field] : undefined) ?? fieldError(error, field);
  const hasLocalIssues = Object.keys(local).length > 0;
  const unclaimed = unclaimedIssues(error, KNOWN_RULE_FIELDS);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        stationId: form.stationId || null,
        daysOfWeek: form.daysOfWeek,
        startTime: form.startTime || null,
        endTime: form.endTime || null,
        rateCentsPerHour: rateCents,
        billingIncrementMinutes: toInt(form.billingIncrementMinutes),
        minimumMinutes: toInt(form.minimumMinutes),
        minimumChargeCents: minimumCents,
        roundingMode: form.roundingMode,
        roundingIncrementCents: toInt(form.roundingIncrementCents),
        isHappyHour: form.isHappyHour,
        priority: toInt(form.priority),
        isActive: form.isActive,
        validFrom: form.validFrom || null,
        validTo: form.validTo || null,
      };
      return rule
        ? api<PricingRuleSummary>(`/pricing/rules/${rule.id}`, { method: 'PATCH', body })
        : api<PricingRuleSummary>('/pricing/rules', { method: 'POST', body });
    },
    onSuccess: onSaved,
    onError: (err) => {
      setError(err);
      focusFirstInvalid();
    },
  });
  const submit = () => {
    setAttempted(true);
    setError(null);
    if (hasLocalIssues) {
      focusFirstInvalid();
      return;
    }
    save.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={rule ? t('pricing.editRule') : t('pricing.addRule')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {attempted && hasLocalIssues && <Alert tone="danger">{t('pricing.errors.fixFields')}</Alert>}
      {unclaimed.length > 0 && (
        <Alert tone="danger">
          {unclaimed.length === 1 ? (
            unclaimed[0]
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unclaimed.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <form
        className="grid grid--2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('pricing.name')} error={issue('name')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              autoFocus
              value={form.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.station')} error={issue('stationId')}>
          {(id, inv) => (
            <Select
              id={id}
              aria-invalid={inv}
              value={form.stationId}
              onChange={(e) => set('stationId', e.target.value)}
            >
              <option value="">{t('pricing.allStations')}</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('pricing.rate')}
          hint={t('pricing.rateHint')}
          error={issue('rateCentsPerHour')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv || (form.rate !== '' && rateCents === null)}
              inputMode="decimal"
              placeholder="1.50"
              value={form.rate}
              onChange={(e) => set('rate', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('pricing.increment')}
          hint={t('pricing.incrementHint')}
          error={issue('billingIncrementMinutes')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={1}
              max={120}
              value={form.billingIncrementMinutes}
              onChange={(e) => set('billingIncrementMinutes', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.minimumMinutes')} error={issue('minimumMinutes')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={0}
              max={600}
              value={form.minimumMinutes}
              onChange={(e) => set('minimumMinutes', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.minimumCharge')} error={issue('minimumChargeCents')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              inputMode="decimal"
              value={form.minimumCharge}
              onChange={(e) => set('minimumCharge', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.rounding')} error={issue('roundingMode')}>
          {(id) => (
            <Select
              id={id}
              value={form.roundingMode}
              onChange={(e) => set('roundingMode', e.target.value as RuleForm['roundingMode'])}
            >
              {(['up', 'down', 'nearest'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`pricing.roundingModes.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('pricing.roundingIncrement')} error={issue('roundingIncrementCents')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={1}
              max={1000}
              value={form.roundingIncrementCents}
              onChange={(e) => set('roundingIncrementCents', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.days')} className="span-2" error={issue('daysOfWeek')}>
          {() => <DayPicker value={form.daysOfWeek} onChange={(d) => set('daysOfWeek', d)} />}
        </Field>
        <Field
          label={`${t('pricing.timeWindow')} · ${t('pricing.from')}`}
          hint={t('pricing.timeWindowHint')}
          optional
          error={issue('startTime')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="time"
              value={form.startTime}
              onChange={(e) => set('startTime', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={`${t('pricing.timeWindow')} · ${t('pricing.to')}`}
          optional
          error={issue('endTime')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="time"
              value={form.endTime}
              onChange={(e) => set('endTime', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.validFrom')} optional error={issue('validFrom')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="date"
              value={form.validFrom}
              onChange={(e) => set('validFrom', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.validTo')} optional error={issue('validTo')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="date"
              value={form.validTo}
              onChange={(e) => set('validTo', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('pricing.priority')}
          hint={t('pricing.priorityHint')}
          error={issue('priority')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={-100}
              max={100}
              value={form.priority}
              onChange={(e) => set('priority', e.target.value)}
            />
          )}
        </Field>
        <div className="stack" style={{ justifyContent: 'flex-end' }}>
          <Switch
            checked={form.isHappyHour}
            onChange={(v) => set('isHappyHour', v)}
            label={
              <>
                <Clock size={14} /> {t('pricing.happyHour')}
              </>
            }
          />
          <Switch
            checked={form.isActive}
            onChange={(v) => set('isActive', v)}
            label={t('pricing.active')}
          />
        </div>
        {/* Enter in any field submits (the footer button lives outside the form). */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

// ─── Package dialog ────────────────────────────────────────────────────────────
interface PackageForm {
  name: string;
  durationMinutes: string;
  price: string;
  stationIds: string[] | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  isPromotional: boolean;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  sortOrder: string;
}

function PackageDialog({
  pkg,
  stations,
  onClose,
  onSaved,
}: {
  pkg: GamingPackageSummary | null;
  stations: StationSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<PackageForm>({
    name: pkg?.name ?? '',
    durationMinutes: String(pkg?.durationMinutes ?? 60),
    price: pkg ? centsToInput(pkg.priceCents) : '',
    stationIds: pkg?.stationIds ?? null,
    daysOfWeek: pkg?.daysOfWeek ?? ALL_DAYS,
    startTime: pkg?.startTime ?? '',
    endTime: pkg?.endTime ?? '',
    isPromotional: pkg?.isPromotional ?? false,
    validFrom: pkg?.validFrom ?? '',
    validTo: pkg?.validTo ?? '',
    isActive: pkg?.isActive ?? true,
    sortOrder: String(pkg?.sortOrder ?? 0),
  });
  const set = <K extends keyof PackageForm>(key: K, value: PackageForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const [error, setError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);
  const priceCents = parseMoneyInput(form.price);

  const local: Issues = {};
  if (!form.name.trim()) local.name = t('common.required');
  if (priceCents === null || priceCents < 0) local.priceCents = t('pricing.errors.money');
  if (!inRange(toInt(form.durationMinutes), 1, 1440))
    local.durationMinutes = t('pricing.errors.range', { min: 1, max: 1440 });
  if (!inRange(toInt(form.sortOrder), 0, 1000))
    local.sortOrder = t('pricing.errors.range', { min: 0, max: 1000 });
  if (form.daysOfWeek.length === 0) local.daysOfWeek = t('pricing.errors.days');
  if ((form.startTime === '') !== (form.endTime === '')) {
    local[form.startTime === '' ? 'startTime' : 'endTime'] = t('pricing.errors.timeWindow');
  }
  if (form.validFrom && form.validTo && form.validTo < form.validFrom)
    local.validTo = t('pricing.errors.validRange');
  const issue = (field: string) =>
    (attempted ? local[field] : undefined) ?? fieldError(error, field);
  const hasLocalIssues = Object.keys(local).length > 0;
  const unclaimed = unclaimedIssues(error, KNOWN_PACKAGE_FIELDS);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        durationMinutes: toInt(form.durationMinutes),
        priceCents,
        stationIds: form.stationIds && form.stationIds.length > 0 ? form.stationIds : null,
        daysOfWeek: form.daysOfWeek,
        startTime: form.startTime || null,
        endTime: form.endTime || null,
        isPromotional: form.isPromotional,
        validFrom: form.validFrom || null,
        validTo: form.validTo || null,
        isActive: form.isActive,
        sortOrder: toInt(form.sortOrder),
      };
      return pkg
        ? api<GamingPackageSummary>(`/pricing/packages/${pkg.id}`, { method: 'PATCH', body })
        : api<GamingPackageSummary>('/pricing/packages', { method: 'POST', body });
    },
    onSuccess: onSaved,
    onError: (err) => {
      setError(err);
      focusFirstInvalid();
    },
  });
  const submit = () => {
    setAttempted(true);
    setError(null);
    if (hasLocalIssues) {
      focusFirstInvalid();
      return;
    }
    save.mutate();
  };
  const toggleStation = (id: string) => {
    const current = form.stationIds ?? [];
    set('stationIds', current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={pkg ? t('pricing.editPackage') : t('pricing.addPackage')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {attempted && hasLocalIssues && <Alert tone="danger">{t('pricing.errors.fixFields')}</Alert>}
      {unclaimed.length > 0 && (
        <Alert tone="danger">
          {unclaimed.length === 1 ? (
            unclaimed[0]
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unclaimed.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <form
        className="grid grid--2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('pricing.name')} error={issue('name')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              autoFocus
              value={form.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.sortOrder')} error={issue('sortOrder')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={0}
              max={1000}
              value={form.sortOrder}
              onChange={(e) => set('sortOrder', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.duration')} error={issue('durationMinutes')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="number"
              min={1}
              max={1440}
              value={form.durationMinutes}
              onChange={(e) => set('durationMinutes', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.price')} hint={t('pricing.rateHint')} error={issue('priceCents')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv || (form.price !== '' && priceCents === null)}
              inputMode="decimal"
              placeholder="5.00"
              value={form.price}
              onChange={(e) => set('price', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('pricing.stations')}
          hint={t('pricing.stationsHint')}
          className="span-2"
          error={issue('stationIds')}
        >
          {() => (
            <div className="chips">
              {stations.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="chip"
                  aria-pressed={form.stationIds?.includes(s.id) ?? false}
                  onClick={() => toggleStation(s.id)}
                >
                  {s.code}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={t('pricing.days')} className="span-2" error={issue('daysOfWeek')}>
          {() => <DayPicker value={form.daysOfWeek} onChange={(d) => set('daysOfWeek', d)} />}
        </Field>
        <Field
          label={`${t('pricing.timeWindow')} · ${t('pricing.from')}`}
          hint={t('pricing.timeWindowHint')}
          optional
          error={issue('startTime')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="time"
              value={form.startTime}
              onChange={(e) => set('startTime', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={`${t('pricing.timeWindow')} · ${t('pricing.to')}`}
          optional
          error={issue('endTime')}
        >
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="time"
              value={form.endTime}
              onChange={(e) => set('endTime', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.validFrom')} optional error={issue('validFrom')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="date"
              value={form.validFrom}
              onChange={(e) => set('validFrom', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('pricing.validTo')} optional error={issue('validTo')}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              type="date"
              value={form.validTo}
              onChange={(e) => set('validTo', e.target.value)}
            />
          )}
        </Field>
        <div className="stack span-2">
          <Switch
            checked={form.isPromotional}
            onChange={(v) => set('isPromotional', v)}
            label={
              <>
                <Tag size={14} /> {t('pricing.promotional')}
              </>
            }
          />
          <Switch
            checked={form.isActive}
            onChange={(v) => set('isActive', v)}
            label={t('pricing.active')}
          />
        </div>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
