import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Pencil, Plus, Search, UserMinus, UserPlus, X } from 'lucide-react';
import {
  ALL_PERMISSION_CODES,
  PERMISSIONS,
  ROLE_RANK,
  ROLES,
  type Paginated,
  type RoleCode,
  type RoleSummary,
  type UserSummary,
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
  Pagination,
  Switch,
  Tabs,
} from '../components/ui/primitives';

const PAGE_SIZE = 25;
type RoleKey = `employees.roleNames.${RoleCode}`;
type RoleDescKey = `employees.roleDescriptions.${RoleCode}`;

/** Permission code prefix → translated category (keeps the matrix readable without a server round-trip). */
const CATEGORY_OF: Record<string, string> = {
  dashboard: 'dashboard',
  reports: 'reports',
  stations: 'stations',
  devices: 'stations',
  pricing: 'stations',
  pos: 'pos',
  invoices: 'pos',
  products: 'inventory',
  inventory: 'inventory',
  purchases: 'purchasing',
  suppliers: 'purchasing',
  customers: 'customers',
  users: 'staff',
  cash: 'cash',
  expenses: 'finance',
  settings: 'system',
  audit: 'system',
  backups: 'system',
  updates: 'system',
};

function bestRank(roles: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const r of roles) {
    const rank = ROLE_RANK[r as RoleCode];
    if (rank !== undefined && rank < best) best = rank;
  }
  return best;
}

export function EmployeesPage() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.USERS_MANAGE);
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserSummary | null>(null);
  const [toggling, setToggling] = useState<UserSummary | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(id);
  }, [search]);

  const users = useQuery({
    queryKey: ['users', { page, search: debounced, includeInactive }],
    queryFn: () =>
      api<Paginated<UserSummary>>('/users', {
        query: {
          page,
          pageSize: PAGE_SIZE,
          search: debounced || undefined,
          includeInactive: includeInactive || undefined,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleSummary[]>('/roles'),
    staleTime: 5 * 60_000,
  });

  const myRank = bestRank(user?.roles ?? []);
  const iAmOwner = user?.roles.includes(ROLES.OWNER) ?? false;
  const canManageTarget = (target: UserSummary) => {
    if (!canManage) return false;
    const targetRank = bestRank(target.roles);
    return targetRank > myRank || (targetRank === myRank && iAmOwner);
  };
  /** Roles the current user is allowed to grant. */
  const assignableRoles = useMemo(
    () => (roles.data ?? []).filter((r) => r.rank > myRank || (r.rank === myRank && iAmOwner)),
    [roles.data, myRank, iAmOwner],
  );

  const invalidateUsers = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const toggleActive = useMutation({
    mutationFn: (target: UserSummary) =>
      api<UserSummary>(`/users/${target.id}`, {
        method: 'PATCH',
        body: { isActive: !target.isActive },
      }),
    onSuccess: () => {
      toast.success(t('employees.updated'));
      invalidateUsers();
      setToggling(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t('employees.title')}</h1>
          <p className="page-header__sub">{t('employees.subtitle')}</p>
        </div>
        <div className="page-header__actions">
          {canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t('employees.addEmployee')}
            </Button>
          )}
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'users', label: t('employees.tabUsers') },
          { id: 'roles', label: t('employees.tabRoles') },
        ]}
      />

      {tab === 'users' && (
        <Card flush>
          <div className="toolbar">
            <div className="input-group" style={{ maxWidth: 320 }}>
              <Search size={16} />
              <Input
                placeholder={t('common.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={t('common.search')}
              />
            </div>
            <Switch
              checked={includeInactive}
              onChange={(v) => {
                setIncludeInactive(v);
                setPage(1);
              }}
              label={t('employees.showInactive')}
            />
          </div>
          {users.isLoading && <Loading />}
          {users.isError && (
            <div style={{ padding: 16 }}>
              <Alert tone="danger">{t('common.errorGeneric')}</Alert>
            </div>
          )}
          {users.data && users.data.items.length === 0 && (
            <EmptyState icon={<UserPlus size={22} />} title={t('common.noResults')} />
          )}
          {users.data && users.data.items.length > 0 && (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('employees.fullName')}</th>
                    <th>{t('employees.username')}</th>
                    <th>{t('employees.roles')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('employees.lastLogin')}</th>
                    {canManage && <th className="right">{t('common.actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((u) => {
                    const manageable = canManageTarget(u);
                    const isMe = u.id === user?.id;
                    return (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.fullName}</strong>{' '}
                          {isMe && <span className="faint">({t('employees.you')})</span>}
                          {(u.email || u.phone) && (
                            <div className="faint" style={{ fontSize: 12 }}>
                              {[u.email, u.phone].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="mono">{u.username}</td>
                        <td>
                          <div className="row row--wrap" style={{ gap: 4 }}>
                            {u.roles.map((r) => (
                              <Badge
                                key={r}
                                tone={
                                  r === 'owner' ? 'purple' : r === 'admin' ? 'accent' : 'default'
                                }
                              >
                                {t(`employees.roleNames.${r}` as RoleKey)}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td>
                          <Badge tone={u.isActive ? 'success' : 'danger'} dot={u.isActive}>
                            {u.isActive ? t('common.active') : t('common.inactive')}
                          </Badge>
                          {u.mustChangePassword && (
                            <div className="faint" style={{ fontSize: 11 }}>
                              {t('employees.mustChange')}
                            </div>
                          )}
                        </td>
                        <td>{u.lastLoginAt ? fmt.dateTime(u.lastLoginAt) : t('common.never')}</td>
                        {canManage && (
                          <td className="right">
                            {manageable && (
                              <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon
                                  onClick={() => setEditing(u)}
                                  aria-label={t('common.edit')}
                                  title={t('common.edit')}
                                >
                                  <Pencil size={15} />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon
                                  onClick={() => setResetting(u)}
                                  aria-label={t('employees.resetPassword')}
                                  title={t('employees.resetPassword')}
                                >
                                  <KeyRound size={15} />
                                </Button>
                                {!isMe && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    icon
                                    onClick={() =>
                                      u.isActive ? setToggling(u) : toggleActive.mutate(u)
                                    }
                                    aria-label={
                                      u.isActive
                                        ? t('employees.deactivate')
                                        : t('employees.activate')
                                    }
                                    title={
                                      u.isActive
                                        ? t('employees.deactivate')
                                        : t('employees.activate')
                                    }
                                  >
                                    {u.isActive ? <UserMinus size={15} /> : <UserPlus size={15} />}
                                  </Button>
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination
                page={users.data.page}
                pageSize={users.data.pageSize}
                total={users.data.total}
                onPage={setPage}
              />
            </>
          )}
        </Card>
      )}

      {tab === 'roles' && <RolesMatrix roles={roles.data} loading={roles.isLoading} />}

      <UserDialog
        open={creating}
        onClose={() => setCreating(false)}
        roles={assignableRoles}
        onSaved={() => {
          invalidateUsers();
          setCreating(false);
        }}
      />
      {editing && (
        <UserDialog
          open
          user={editing}
          roles={assignableRoles}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateUsers();
            setEditing(null);
          }}
        />
      )}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
      <ConfirmDialog
        open={Boolean(toggling)}
        onClose={() => setToggling(null)}
        title={t('employees.deactivate')}
        body={t('employees.deactivateConfirm', { name: toggling?.fullName ?? '' })}
        danger
        loading={toggleActive.isPending}
        confirmLabel={t('employees.deactivate')}
        onConfirm={() => toggling && toggleActive.mutate(toggling)}
      />
    </>
  );
}

// ─── Create / edit dialog ──────────────────────────────────────────────────────
function UserDialog({
  open,
  onClose,
  onSaved,
  roles,
  user,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  roles: RoleSummary[];
  user?: UserSummary;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState({
    fullName: '',
    username: '',
    password: '',
    email: '',
    phone: '',
    roles: [] as string[],
    mustChangePassword: true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        fullName: user?.fullName ?? '',
        username: user?.username ?? '',
        password: '',
        email: user?.email ?? '',
        phone: user?.phone ?? '',
        roles: user?.roles ?? [],
        mustChangePassword: true,
      });
      setError(null);
    }
  }, [open, user]);

  const toggleRole = (code: string) =>
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(code) ? f.roles.filter((r) => r !== code) : [...f.roles, code],
    }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api<UserSummary>(`/users/${user.id}`, {
          method: 'PATCH',
          body: {
            fullName: form.fullName.trim(),
            email: form.email.trim() || null,
            phone: form.phone.trim() || null,
            roles: form.roles,
          },
        });
        toast.success(t('employees.updated'));
      } else {
        await api<UserSummary>('/users', {
          method: 'POST',
          body: {
            fullName: form.fullName.trim(),
            username: form.username.trim(),
            password: form.password,
            email: form.email.trim() || null,
            phone: form.phone.trim() || null,
            roles: form.roles,
            mustChangePassword: form.mustChangePassword,
          },
        });
        toast.success(t('employees.created', { name: form.fullName.trim() }));
      }
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const knownFields = ['fullName', 'username', 'password', 'email', 'phone', 'roles'];
  const generic =
    error instanceof ApiError && !knownFields.some((f) => fieldError(error, f))
      ? error.message
      : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={user ? t('employees.editEmployee') : t('employees.addEmployee')}
    >
      <form className="stack" onSubmit={submit}>
        {generic && <Alert tone="danger">{generic}</Alert>}
        <div className="form-grid">
          <Field label={t('employees.fullName')} error={fieldError(error, 'fullName')}>
            {(id, invalid) => (
              <Input
                id={id}
                autoFocus
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                aria-invalid={invalid}
                required
                maxLength={120}
              />
            )}
          </Field>
          <Field
            label={t('employees.username')}
            hint={user ? undefined : t('employees.usernameHint')}
            error={fieldError(error, 'username')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                aria-invalid={invalid}
                required
                disabled={Boolean(user)}
                autoComplete="off"
              />
            )}
          </Field>
          {!user && (
            <Field
              label={t('employees.password')}
              hint={t('auth.passwordRules')}
              error={fieldError(error, 'password')}
              className="span-2"
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  aria-invalid={invalid}
                  required
                  minLength={4}
                  autoComplete="new-password"
                />
              )}
            </Field>
          )}
          <Field label={t('employees.email')} optional error={fieldError(error, 'email')}>
            {(id, invalid) => (
              <Input
                id={id}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field label={t('employees.phone')} optional error={fieldError(error, 'phone')}>
            {(id) => (
              <Input
                id={id}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="field">
          <div className="field__label">{t('employees.roles')}</div>
          <div className="stack" style={{ gap: 6 }}>
            {roles.map((role) => (
              <label key={role.code} className="checkbox">
                <input
                  type="checkbox"
                  checked={form.roles.includes(role.code)}
                  onChange={() => toggleRole(role.code)}
                />
                <span>
                  <strong>{t(`employees.roleNames.${role.code}` as RoleKey)}</strong>
                  <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>
                    {t(`employees.roleDescriptions.${role.code}` as RoleDescKey)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {fieldError(error, 'roles') && (
            <div className="field__error">{fieldError(error, 'roles')}</div>
          )}
        </div>
        {!user && (
          <Switch
            checked={form.mustChangePassword}
            onChange={(v) => setForm({ ...form, mustChangePassword: v })}
            label={t('employees.mustChange')}
          />
        )}
        <div className="form-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={form.roles.length === 0}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Reset password ────────────────────────────────────────────────────────────
function ResetPasswordDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<void>(`/users/${user.id}/reset-password`, {
        method: 'POST',
        body: { newPassword: password, mustChangePassword: mustChange },
      });
      toast.success(t('employees.resetDone'));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const generic =
    error instanceof ApiError && !fieldError(error, 'newPassword') ? error.message : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('employees.resetPasswordFor', { name: user.fullName })}
      size="sm"
    >
      <form className="stack" onSubmit={submit}>
        {generic && <Alert tone="danger">{generic}</Alert>}
        <Field
          label={t('auth.newPassword')}
          hint={t('auth.passwordRules')}
          error={fieldError(error, 'newPassword')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={invalid}
              required
              minLength={4}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Switch checked={mustChange} onChange={setMustChange} label={t('employees.mustChange')} />
        <div className="form-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('employees.resetPassword')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Roles matrix ──────────────────────────────────────────────────────────────
function RolesMatrix({ roles, loading }: { roles: RoleSummary[] | undefined; loading: boolean }) {
  const { t, td } = useI18n();
  const { user, can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const myRank = bestRank(user?.roles ?? []);
  const iAmOwner = user?.roles.includes(ROLES.OWNER) ?? false;
  const canManage = can(PERMISSIONS.USERS_MANAGE);
  /** Roles whose permission set the current user may edit (owner is always locked). */
  const editable = (r: RoleSummary) =>
    canManage && r.code !== ROLES.OWNER && (r.rank > myRank || (r.rank === myRank && iAmOwner));

  // One in-flight save per role; the matrix shows the optimistic state meanwhile.
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const save = useMutation({
    mutationFn: ({ role, permissions }: { role: RoleSummary; permissions: string[] }) =>
      api<RoleSummary>(`/roles/${role.id}/permissions`, { method: 'PUT', body: { permissions } }),
    onSuccess: (updated) => {
      queryClient.setQueryData<RoleSummary[]>(['roles'], (list) =>
        list?.map((r) => (r.id === updated.id ? updated : r)),
      );
      toast.success(
        t('employees.permissionsSaved', {
          role: t(`employees.roleNames.${updated.code}` as RoleKey),
        }),
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
    onSettled: (_data, _err, vars) =>
      setPending((p) => {
        const next = { ...p };
        delete next[vars.role.id];
        return next;
      }),
  });
  const toggle = (role: RoleSummary, code: string) => {
    if (pending[role.id]) return;
    const current = role.permissions;
    const next = current.includes(code)
      ? current.filter((c) => c !== code)
      : [...current, code].sort();
    setPending((p) => ({ ...p, [role.id]: next }));
    save.mutate({ role, permissions: next });
  };

  if (loading || !roles) return <Loading />;
  const grouped = new Map<string, string[]>();
  for (const code of ALL_PERMISSION_CODES) {
    const prefix = code.split('.')[0] ?? code;
    const category = CATEGORY_OF[prefix] ?? 'system';
    grouped.set(category, [...(grouped.get(category) ?? []), code]);
  }
  const anyEditable = roles.some(editable);
  return (
    <Card flush>
      <div className="perm-matrix__intro">
        <Alert tone="info">
          {anyEditable ? t('employees.permissionsHint') : t('employees.permissionsReadOnly')}
        </Alert>
      </div>
      <div className="perm-matrix-wrap">
        <table className="table perm-matrix">
          <thead>
            <tr>
              <th>{t('employees.permission')}</th>
              {roles.map((r) => (
                <th key={r.code} style={{ textAlign: 'center' }}>
                  <div>{t(`employees.roleNames.${r.code}` as RoleKey)}</div>
                  <div className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                    {t(`employees.roleDescriptions.${r.code}` as RoleDescKey)}
                  </div>
                  {r.code === ROLES.OWNER && (
                    <div className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                      {t('employees.ownerLocked')}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...grouped.entries()].map(([category, codes]) => (
              <CategoryRows
                key={category}
                label={td(`employees.permissionCategories.${category}`, category)}
                nameOf={(code) => td(`employees.permissionNames.${code.replace('.', '_')}`, code)}
                codes={codes}
                roles={roles.map((r) =>
                  pending[r.id] ? { ...r, permissions: pending[r.id]! } : r,
                )}
                editable={editable}
                busy={(r) => Boolean(pending[r.id])}
                onToggle={toggle}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CategoryRows({
  label,
  codes,
  roles,
  nameOf,
  editable,
  busy,
  onToggle,
}: {
  label: string;
  codes: string[];
  roles: RoleSummary[];
  nameOf: (code: string) => string;
  editable: (role: RoleSummary) => boolean;
  busy: (role: RoleSummary) => boolean;
  onToggle: (role: RoleSummary, code: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <tr>
        <td
          colSpan={roles.length + 1}
          style={{
            background: 'var(--bg-elevated)',
            fontWeight: 600,
            fontSize: 12,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {label}
        </td>
      </tr>
      {codes.map((code) => (
        <tr key={code}>
          <td>
            <div style={{ fontSize: 13 }}>{nameOf(code)}</div>
            <div className="mono faint" style={{ fontSize: 11 }}>
              {code}
            </div>
          </td>
          {roles.map((r) => {
            const has = r.permissions.includes(code);
            if (!editable(r)) {
              return (
                <td key={r.code} style={{ textAlign: 'center' }}>
                  {has ? <Check size={16} className="check" /> : <X size={14} className="cross" />}
                </td>
              );
            }
            return (
              <td key={r.code} style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  className="perm-check"
                  checked={has}
                  disabled={busy(r)}
                  onChange={() => onToggle(r, code)}
                  aria-label={`${nameOf(code)} · ${t(`employees.roleNames.${r.code}` as RoleKey)}`}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
