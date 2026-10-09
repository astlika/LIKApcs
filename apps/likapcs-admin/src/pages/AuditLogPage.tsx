import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { AuditLogEntry, Paginated } from '@likapcs/shared';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Input,
  Loading,
  Pagination,
  Select,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const { t, td } = useI18n();
  const fmt = useFormat();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(id);
  }, [search]);

  const actions = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () => api<string[]>('/audit-logs/actions'),
    staleTime: 60_000,
  });
  const logs = useQuery({
    queryKey: ['audit', { page, action, debounced, from, to }],
    queryFn: () =>
      api<Paginated<AuditLogEntry>>('/audit-logs', {
        query: {
          page,
          pageSize: PAGE_SIZE,
          action: action || undefined,
          search: debounced || undefined,
          from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
          to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        },
      }),
    placeholderData: (prev) => prev,
  });

  const severityTone = (s: AuditLogEntry['severity']) =>
    s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'default';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t('audit.title')}</h1>
          <p className="page-header__sub">{t('audit.subtitle')}</p>
        </div>
      </div>
      <Card flush>
        <div className="toolbar">
          <div className="input-group" style={{ maxWidth: 300 }}>
            <Search size={16} />
            <Input
              placeholder={t('common.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t('common.search')}
            />
          </div>
          <Select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            style={{ maxWidth: 240 }}
            aria-label={t('audit.action')}
          >
            <option value="">{t('audit.allActions')}</option>
            {(actions.data ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">{t('audit.from')}</span>
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              style={{ width: 160 }}
            />
          </label>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">{t('audit.to')}</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              style={{ width: 160 }}
            />
          </label>
        </div>
        {logs.isLoading && <Loading />}
        {logs.isError && (
          <div style={{ padding: 16 }}>
            <Alert tone="danger">{t('common.errorGeneric')}</Alert>
          </div>
        )}
        {logs.data && logs.data.items.length === 0 && <EmptyState title={t('audit.empty')} />}
        {logs.data && logs.data.items.length > 0 && (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>{t('audit.when')}</th>
                  <th>{t('audit.action')}</th>
                  <th>{t('audit.actor')}</th>
                  <th>{t('audit.entity')}</th>
                  <th>{t('audit.severity')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.items.map((entry) => {
                  const open = expanded === entry.id;
                  const hasDetails = Object.keys(entry.details ?? {}).length > 0;
                  return (
                    <AuditRow
                      key={entry.id}
                      entry={entry}
                      open={open}
                      hasDetails={hasDetails}
                      onToggle={() => setExpanded(open ? null : entry.id)}
                      when={fmt.dateTime(entry.occurredAt)}
                      actor={entry.actorLabel ?? t('audit.system')}
                      severity={td(`audit.severities.${entry.severity}`, entry.severity)}
                      tone={severityTone(entry.severity)}
                    />
                  );
                })}
              </tbody>
            </table>
            <Pagination
              page={logs.data.page}
              pageSize={logs.data.pageSize}
              total={logs.data.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </>
  );
}

function AuditRow({
  entry,
  open,
  hasDetails,
  onToggle,
  when,
  actor,
  severity,
  tone,
}: {
  entry: AuditLogEntry;
  open: boolean;
  hasDetails: boolean;
  onToggle: () => void;
  when: string;
  actor: string;
  severity: string;
  tone: 'default' | 'warning' | 'danger';
}) {
  return (
    <>
      <tr
        onClick={hasDetails ? onToggle : undefined}
        style={{ cursor: hasDetails ? 'pointer' : 'default' }}
      >
        <td className="faint">
          {hasDetails ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
        </td>
        <td className="num">{when}</td>
        <td className="mono">{entry.action}</td>
        <td>
          {actor}
          {entry.ipAddress && (
            <span className="faint mono" style={{ fontSize: 11, marginLeft: 6 }}>
              {entry.ipAddress}
            </span>
          )}
        </td>
        <td>
          {entry.entityType ? (
            <>
              <span>{entry.entityType}</span>
              {entry.entityId && (
                <span className="faint mono" style={{ fontSize: 11, marginLeft: 6 }}>
                  {entry.entityId.slice(0, 8)}
                </span>
              )}
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
        <td>
          <Badge tone={tone}>{severity}</Badge>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--bg-elevated)' }}>
            <pre className="json">{JSON.stringify(entry.details, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
