import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CircleHelp,
  Cpu,
  DownloadCloud,
  KeyRound,
  Link2,
  Lock,
  LockOpen,
  MessageSquare,
  Monitor,
  Plus,
  Power,
  RotateCcw,
  ShieldOff,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  PERMISSIONS,
  isNewerVersion,
  type ClientUpdatePushResponse,
  type StationCommandRequest,
  type StationCommandResponse,
  type StationDeviceSummary,
  type StationStatus,
  type StationSummary,
  type SystemInfoResponse,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { SessionPanel, useNow } from '../components/sessions/SessionPanel';
import { StationMap, type SelectModifiers } from '../components/stations/StationMap';
import {
  intersects,
  mapOrder,
  normalizeRect,
  rangeIds,
  toggleId,
  unionIds,
} from '../lib/map-selection';
import { ConnectPcDialog, FirewallCard } from '../components/stations/ConnectPcDialog';
import { useStationActions } from '../components/stations/useStationActions';
import { formatHms, projectSession } from '../lib/session-time';
import { storage } from '../lib/storage';
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
  Kbd,
  Loading,
  Select,
  Switch,
  Textarea,
} from '../components/ui/primitives';

const STATUS_TONE: Record<
  StationStatus,
  'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'purple'
> = {
  available: 'success',
  occupied: 'accent',
  paused: 'warning',
  locked: 'purple',
  maintenance: 'warning',
  offline: 'default',
  error: 'danger',
  updating: 'info',
  disabled: 'default',
};

interface ConnectionLogEntry {
  id: number;
  deviceId: string;
  occurredAt: string;
  event: string;
  details: Record<string, unknown>;
}

interface StationForm {
  number: string;
  name: string;
  zone: string;
  notes: string;
  isEnabled: boolean;
}

const emptyForm = (nextNumber: number): StationForm => ({
  number: String(nextNumber),
  name: `PC ${String(nextNumber).padStart(2, '0')}`,
  zone: '',
  notes: '',
  isEnabled: true,
});

export function StationsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canManage = can(PERMISSIONS.STATIONS_MANAGE);
  const canDevices = can(PERMISSIONS.DEVICES_MANAGE);

  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => api<StationSummary[]>('/stations'),
    refetchInterval: 20_000,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const pending = useQuery({
    queryKey: ['devices', 'pending'],
    queryFn: () => api<StationDeviceSummary[]>('/devices', { query: { status: 'pending' } }),
    enabled: canDevices,
    // Staff watch this list while installing a client PC: poll quickly while the dialog is open.
    refetchInterval: connectOpen ? 3_000 : 15_000,
  });
  const systemInfo = useQuery({
    queryKey: ['system-info'],
    queryFn: () => api<SystemInfoResponse>('/system/info'),
    staleTime: 60_000,
  });
  const outdatedOnline = useMemo(() => {
    const server = systemInfo.data?.serverVersion;
    if (!server) return 0;
    return (stations.data ?? []).filter(
      (s) => s.device?.online && s.device.appVersion && isNewerVersion(server, s.device.appVersion),
    ).length;
  }, [stations.data, systemInfo.data]);
  const pushUpdates = useMutation({
    mutationFn: () => api<ClientUpdatePushResponse>('/devices/update-outdated', { method: 'POST' }),
    onSuccess: (r) =>
      toast.success(t('stations.updateClientsDone', { sent: r.sent, n: r.outdated })),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  // Selection: an ordered id list (several PCs via marquee / Ctrl+click / Shift+click) plus the
  // anchor — the PC last clicked, which single-PC flows and Shift ranges work from.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
    setAnchorId(id);
  }, []);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    additive: boolean;
    base: string[];
    moved: boolean;
    raf: number;
  } | null>(null);
  const [zone, setZone] = useState<string>('');
  const [iconSize, setIconSize] = useState<number>(() => Number(storage.get('mapIconSize') ?? 96));
  const [groupByZone, setGroupByZone] = useState<boolean>(
    () => storage.get('mapGroupZones') !== '0',
  );

  // Deep link from the command palette (?focus=<stationId>).
  useEffect(() => {
    const focus = params.get('focus');
    if (focus) {
      setSelectedId(focus);
      setDetailId(focus);
      params.delete('focus');
      setParams(params, { replace: true });
    }
  }, [params, setParams, setSelectedId]);

  const list = useMemo(() => stations.data ?? [], [stations.data]);
  const zones = useMemo(
    () => [...new Set(list.map((s) => s.zone?.trim()).filter((z): z is string => !!z))].sort(),
    [list],
  );
  const visible = useMemo(
    () => (zone ? list.filter((s) => (s.zone?.trim() ?? '') === zone) : list),
    [list, zone],
  );
  const counts = useMemo(() => {
    const enabled = list.filter((s) => s.isEnabled);
    return {
      online: enabled.filter((s) => s.device?.online).length,
      available: enabled.filter((s) => s.status === 'available').length,
      occupied: enabled.filter((s) => s.activeSession && s.activeSession.status === 'active')
        .length,
      paused: enabled.filter((s) => s.activeSession?.status === 'paused').length,
      maintenance: enabled.filter((s) => s.status === 'maintenance').length,
      offline: enabled.filter((s) => s.status === 'offline').length,
    };
  }, [list]);
  const nextNumber = useMemo(
    () => (list.length ? Math.max(...list.map((s) => s.number)) + 1 : 1),
    [list],
  );
  const detail = list.find((s) => s.id === detailId) ?? null;
  // Selection pruned to stations that still exist and are visible in the current zone filter.
  const selectedStations = useMemo(() => {
    const byId = new Map(visible.map((s) => [s.id, s]));
    return selectedIds.map((id) => byId.get(id)).filter((s): s is StationSummary => !!s);
  }, [selectedIds, visible]);
  const selectedSet = useMemo(() => new Set(selectedStations.map((s) => s.id)), [selectedStations]);
  const selected = selectedStations.find((s) => s.id === anchorId) ?? selectedStations[0] ?? null;
  const selectedId = selected?.id ?? null;
  const displayOrder = useMemo(() => mapOrder(visible, groupByZone).flat(), [visible, groupByZone]);

  /** Click on a tile with modifier keys: plain = only this, Ctrl = toggle, Shift = range. */
  const selectTile = useCallback(
    (id: string, mods: SelectModifiers) => {
      setMenu(null);
      if (mods.keep && selectedSet.has(id)) {
        setAnchorId(id);
        return;
      }
      if (mods.range && anchorId) {
        const range = rangeIds(displayOrder, anchorId, id);
        if (range) {
          setSelectedIds(mods.toggle ? unionIds(selectedIds, range) : range);
          return; // the anchor stays where it was so the range can be re-stretched
        }
      }
      if (mods.toggle) {
        const next = toggleId(selectedIds, id);
        setSelectedIds(next.ids);
        setAnchorId(next.anchor);
        return;
      }
      setSelectedId(id);
    },
    [anchorId, displayOrder, selectedIds, selectedSet, setSelectedId],
  );

  // Rubber-band selection: drag on the canvas background; tiles touching the box are selected
  // (Ctrl adds them to the current selection). A plain click on the background deselects.
  const hitTest = useCallback((x1: number, y1: number, x2: number, y2: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const box = normalizeRect(x1, y1, x2, y2);
    const hits: string[] = [];
    for (const el of canvas.querySelectorAll<HTMLElement>('.pc-tile[data-id]')) {
      if (intersects(box, el.getBoundingClientRect())) hits.push(el.dataset.id!);
    }
    return hits;
  }, []);
  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as HTMLElement).closest('.pc-tile')) return;
    // The start point is kept relative to the canvas so the box stays put if the page scrolls.
    const rc = e.currentTarget.getBoundingClientRect();
    drag.current = {
      startX: e.clientX - rc.left,
      startY: e.clientY - rc.top,
      additive: e.ctrlKey || e.metaKey,
      base: selectedIds,
      moved: false,
      raf: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setMenu(null);
  };
  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const { clientX, clientY } = e;
    const rc0 = canvas.getBoundingClientRect();
    if (!d.moved && Math.hypot(clientX - rc0.left - d.startX, clientY - rc0.top - d.startY) < 4)
      return;
    d.moved = true;
    e.preventDefault();
    if (d.raf) return; // one hit test per frame
    d.raf = window.requestAnimationFrame(() => {
      d.raf = 0;
      const rc = canvas.getBoundingClientRect();
      const x = clientX - rc.left;
      const y = clientY - rc.top;
      setMarquee({
        left: Math.min(d.startX, x),
        top: Math.min(d.startY, y),
        width: Math.abs(x - d.startX),
        height: Math.abs(y - d.startY),
      });
      const hits = hitTest(d.startX + rc.left, d.startY + rc.top, clientX, clientY);
      const next = d.additive ? unionIds(d.base, hits) : hits;
      setSelectedIds(next);
      setAnchorId(hits[hits.length - 1] ?? d.base[d.base.length - 1] ?? null);
    });
  };
  const onCanvasPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf) window.cancelAnimationFrame(d.raf);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    setMarquee(null);
    if (!d.moved && !d.additive) setSelectedId(null);
  };

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
    void queryClient.invalidateQueries({ queryKey: ['devices'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }, [queryClient]);

  const { actions, primary, run, busy, dialogs, multi } = useStationActions(
    selected,
    invalidate,
    (id) => setDetailId(id),
    selectedStations,
  );

  // Double-click / Enter on a tile: run the primary action for *that* station after the
  // selection has been applied (run() and primary are derived from the selected station).
  const pendingPrimary = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || pendingPrimary.current !== selected.id) return;
    pendingPrimary.current = null;
    if (primary) run(primary);
  }, [selected, primary, run]);

  // Keyboard: arrows move the selection on the map, Enter = primary action, Esc = deselect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest('input, textarea, select, [role="dialog"]') || target.isContentEditable)
      )
        return;
      if (!visible.length) return;
      // A focused tile handles Enter itself (see StationTile) — avoid running the action twice.
      if (e.key === 'Enter' && target?.closest('.pc-tile')) return;
      const order = displayOrder;
      const idx = order.findIndex((s) => s.id === selectedId);
      const move = (delta: number) => {
        e.preventDefault();
        const next = idx < 0 ? 0 : Math.min(order.length - 1, Math.max(0, idx + delta));
        const id = order[next]!.id;
        // Shift+arrow grows the selection, a plain arrow moves it.
        if (e.shiftKey) setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        else setSelectedIds([id]);
        setAnchorId(id);
        setMenu(null);
        // Focus follows the selection so Enter / context-menu keys act on the highlighted PC.
        document.querySelector<HTMLElement>(`.pc-tile[data-id="${CSS.escape(id)}"]`)?.focus();
      };
      if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowDown') move(perRow());
      else if (e.key === 'ArrowUp') move(-perRow());
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(order.map((s) => s.id));
        setAnchorId(selectedId ?? order[0]!.id);
        setMenu(null);
      } else if (e.key === 'Escape') {
        setMenu(null);
        setSelectedId(null);
      } else if (e.key === 'Enter' && selected && primary) {
        e.preventDefault();
        run(primary);
      }
    };
    const perRow = () => {
      const grid = document.querySelector('.pc-map__grid');
      const tile = grid?.querySelector<HTMLElement>('.pc-tile');
      if (!grid || !tile) return 1;
      return Math.max(1, Math.floor(grid.clientWidth / (tile.offsetWidth + 10)));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, displayOrder, selectedId, selected, primary, run, setSelectedId]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const changeSize = (n: number) => {
    setIconSize(n);
    storage.set('mapIconSize', String(n));
  };
  const toggleGroup = (v: boolean) => {
    setGroupByZone(v);
    storage.set('mapGroupZones', v ? '1' : '0');
  };

  return (
    <div className="map-page">
      <div className="map-toolbar">
        <div className="map-legend" aria-label={t('stations.subtitle', counts)}>
          <span className="map-legend__item" data-status="available">
            <i /> {counts.available} {t('map.free')}
          </span>
          <span className="map-legend__item" data-status="occupied">
            <i /> {counts.occupied} {t('map.inUse')}
          </span>
          <span className="map-legend__item" data-status="paused">
            <i /> {counts.paused} {t('map.paused')}
          </span>
          {counts.maintenance > 0 && (
            <span className="map-legend__item" data-status="maintenance">
              <i /> {counts.maintenance} {t('stations.status.maintenance')}
            </span>
          )}
          <span className="map-legend__item" data-status="offline">
            <i /> {counts.offline} {t('map.offline')}
          </span>
        </div>
        <div className="map-toolbar__spacer" />
        {zones.length > 0 && (
          <Select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            aria-label={t('stations.zone')}
          >
            <option value="">{t('map.allZones')}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        )}
        {zones.length > 0 && (
          <Switch checked={groupByZone} onChange={toggleGroup} label={t('map.groupZones')} />
        )}
        <label className="map-zoom" title={t('map.iconSize')}>
          <Monitor size={13} />
          <input
            type="range"
            min={64}
            max={150}
            step={2}
            value={iconSize}
            onChange={(e) => changeSize(Number(e.target.value))}
            aria-label={t('map.iconSize')}
          />
          <Monitor size={18} />
        </label>
        {canDevices && (pending.data?.length ?? 0) > 0 && (
          <Button variant="primary" onClick={() => setPendingOpen(true)}>
            <Cpu size={16} /> {t('stations.pendingTitle')}{' '}
            <Badge tone="warning">{pending.data!.length}</Badge>
          </Button>
        )}
        {canDevices && (
          <Button onClick={() => setConnectOpen(true)}>
            <Link2 size={16} /> {t('stations.connectPc')}
          </Button>
        )}
        {canDevices && outdatedOnline > 0 && (
          <Button onClick={() => pushUpdates.mutate()} loading={pushUpdates.isPending}>
            <DownloadCloud size={16} /> {t('stations.updateClients', { n: outdatedOnline })}
          </Button>
        )}
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> {t('stations.addStation')}
          </Button>
        )}
      </div>

      {canDevices && <FirewallCard bannerOnly />}

      <div className="map-actions" role="toolbar" aria-label={t('common.actions')}>
        <div className="map-actions__target" data-multi={multi || undefined}>
          {multi && selected ? (
            <>
              <span className="map-actions__code">
                {t('map.nSelected', { n: selectedStations.length })}
                <button
                  type="button"
                  className="map-actions__clear"
                  onClick={() => setSelectedId(null)}
                  title={t('map.clearSelection')}
                  aria-label={t('map.clearSelection')}
                >
                  <X size={14} />
                </button>
              </span>
              <span
                className="map-actions__chips"
                title={selectedStations.map((s) => s.code).join(', ')}
              >
                {selectedStations.slice(0, 10).map((s) => (
                  <span key={s.id} className="map-chip" data-status={s.status}>
                    {s.code}
                  </span>
                ))}
                {selectedStations.length > 10 && (
                  <span className="map-chip">+{selectedStations.length - 10}</span>
                )}
              </span>
              <span className="map-actions__name">{t('map.multiHint')}</span>
            </>
          ) : selected ? (
            <>
              <span className="map-actions__code">{selected.code}</span>
              <span className="map-actions__name">
                {[selected.name !== selected.code ? selected.name : null, selected.zone]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <SelectedSummary station={selected} fetchedAt={stations.dataUpdatedAt} />
            </>
          ) : (
            <span className="muted">{t('map.selectShort')}</span>
          )}
        </div>
        <MapHelp />
        <div className="map-actions__buttons">
          {actions
            .filter((a) => a.bar)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className="map-action"
                data-action={a.id}
                data-tone={a.tone}
                disabled={!selected || !a.enabled || busy}
                title={a.enabled ? a.label : (a.hint ?? a.label)}
                onClick={() => run(a.id)}
              >
                <a.icon size={20} />
                <span>{a.label}</span>
                {a.shortcut && selected && primary === a.id && <Kbd>{a.shortcut}</Kbd>}
              </button>
            ))}
        </div>
      </div>

      {stations.isLoading && <Loading />}
      {stations.isError && (
        <Alert tone="danger">
          {t('common.errorGeneric')}{' '}
          <Button size="sm" onClick={() => void stations.refetch()}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      )}
      {stations.isSuccess && list.length === 0 && (
        <Card>
          <EmptyState
            icon={<Monitor size={24} />}
            title={t('stations.empty')}
            hint={t('stations.emptyHint')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} /> {t('stations.addStation')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {visible.length > 0 && (
        <div
          className="map-canvas"
          ref={canvasRef}
          data-dragging={marquee ? '' : undefined}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        >
          <StationMap
            stations={visible}
            fetchedAt={stations.dataUpdatedAt}
            selectedIds={selectedSet}
            size={iconSize}
            groupByZone={groupByZone}
            onSelect={selectTile}
            onPrimary={(id) => {
              // run() must see the newly selected station, so the primary action is
              // executed by the effect below once the selection has re-rendered.
              pendingPrimary.current = id;
              if (!selectedSet.has(id) || selectedStations.length <= 1) setSelectedId(id);
              else setAnchorId(id);
              setMenu(null);
            }}
            onMenu={(id, x, y) => {
              // selectTile() already handled the selection (keeps a group the tile is in).
              if (!selectedSet.has(id)) setSelectedId(id);
              setMenu({ x, y });
            }}
          />
          {marquee && (
            <div
              className="map-marquee"
              aria-hidden
              style={{
                left: marquee.left,
                top: marquee.top,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          )}
        </div>
      )}

      {menu && selected && (
        <div
          className="ctx-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 240),
            top: Math.min(menu.y, window.innerHeight - 380),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-menu__title">
            {multi
              ? `${t('map.nSelected', { n: selectedStations.length })} · ${selectedStations
                  .slice(0, 6)
                  .map((s) => s.code)
                  .join(', ')}${selectedStations.length > 6 ? '…' : ''}`
              : selected.name === selected.code
                ? selected.code
                : `${selected.code} · ${selected.name}`}
          </div>
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="ctx-menu__item"
              data-action={a.id}
              data-tone={a.tone}
              disabled={!a.enabled || busy}
              onClick={() => {
                setMenu(null);
                run(a.id);
              }}
            >
              <a.icon size={15} /> {a.label}
            </button>
          ))}
        </div>
      )}

      {dialogs}

      <StationFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        initial={emptyForm(nextNumber)}
        title={t('stations.newStation')}
        onSubmit={async (values) => {
          const created = await api<StationSummary>('/stations', { method: 'POST', body: values });
          toast.success(t('stations.created', { code: created.code }));
          invalidate();
        }}
      />

      {connectOpen && canDevices && (
        <ConnectPcDialog
          onClose={() => setConnectOpen(false)}
          pendingCount={pending.data?.length ?? 0}
          pendingPanel={
            <PendingDevicesPanel
              devices={pending.data ?? []}
              stations={list}
              onChanged={invalidate}
            />
          }
        />
      )}

      {pendingOpen && canDevices && (
        <Dialog
          open
          onClose={() => setPendingOpen(false)}
          title={t('stations.pendingTitle')}
          size="lg"
        >
          {(pending.data?.length ?? 0) === 0 ? (
            <p className="muted">{t('common.none')}</p>
          ) : (
            <PendingDevicesPanel
              devices={pending.data ?? []}
              stations={list}
              onChanged={invalidate}
            />
          )}
        </Dialog>
      )}

      {detail && (
        <StationDetailDialog
          station={detail}
          onClose={() => setDetailId(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

/** Live one-line summary of the selected PC shown in the action bar. */
/**
 * Small "?" button with a popover listing the mouse/keyboard shortcuts of the map, so the
 * instructions no longer take up space in the action bar.
 */
function MapHelp() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const rows: { keys: string[]; text: string }[] = [
    { keys: ['2×', 'Enter'], text: t('map.help.primary') },
    { keys: [t('map.help.rightClick')], text: t('map.help.menu') },
    { keys: ['Ctrl', 'Shift'], text: t('map.help.multi') },
    { keys: ['Ctrl', 'A'], text: t('map.help.all') },
    { keys: ['↑↓←→'], text: t('map.help.move') },
    { keys: ['Esc'], text: t('map.help.clear') },
    { keys: ['F9'], text: t('map.help.pos') },
  ];
  return (
    <div className="map-help" ref={ref}>
      <button
        type="button"
        className="map-help__btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('map.help.title')}
        aria-label={t('map.help.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <CircleHelp size={16} />
      </button>
      {open && (
        <div className="map-help__pop" role="dialog" aria-label={t('map.help.title')}>
          <div className="map-help__title">{t('map.help.title')}</div>
          <ul className="map-help__list">
            {rows.map((r) => (
              <li key={r.text}>
                <span className="map-help__keys">
                  {r.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SelectedSummary({ station, fetchedAt }: { station: StationSummary; fetchedAt: number }) {
  const { t, td } = useI18n();
  const fmt = useFormat();
  const now = useNow();
  const live = station.activeSession;
  if (!live) {
    return (
      <span className="map-actions__status">
        <Badge tone={STATUS_TONE[station.isEnabled ? station.status : 'disabled']} dot>
          {td(`stations.status.${station.isEnabled ? station.status : 'disabled'}`, station.status)}
        </Badge>
        {station.device && (
          <span className="faint">
            {station.device.online ? (
              <Wifi size={13} className="text-success" />
            ) : (
              <WifiOff size={13} />
            )}{' '}
            {station.device.hostname ?? station.device.machineId.slice(0, 10)}
          </span>
        )}
      </span>
    );
  }
  const { elapsed, remaining } = projectSession(
    {
      status: live.status,
      billableSeconds: live.elapsedSeconds,
      endsAt: live.endsAt,
      pausedAt: live.pausedAt,
    },
    fetchedAt,
    now,
  );
  return (
    <span className="map-actions__status">
      <Badge tone={live.status === 'paused' ? 'warning' : 'accent'} dot>
        {live.billingMode === 'prepaid' ? t('sessions.prepaidShort') : t('sessions.postpaidShort')}
        {live.status === 'paused' ? ` · ${t('sessions.status.paused')}` : ''}
      </Badge>
      <span className="num">
        {remaining !== null
          ? `${t('sessions.remaining')} ${formatHms(remaining)}`
          : `${t('sessions.elapsed')} ${formatHms(elapsed)}`}
      </span>
      <span className="num">{fmt.money(live.currentPriceCents)}</span>
      {live.customerName && <span className="muted">{live.customerName}</span>}
    </span>
  );
}

// ─── Pending devices ───────────────────────────────────────────────────────────
function PendingDevicesPanel({
  devices,
  stations,
  onChanged,
}: {
  devices: StationDeviceSummary[];
  stations: StationSummary[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const fmt = useFormat();
  const [selection, setSelection] = useState<Record<string, string>>({});
  const freeStations = stations.filter((s) => !s.device || s.device.status !== 'approved');

  const approve = useMutation({
    mutationFn: ({ deviceId, stationId }: { deviceId: string; stationId: string }) =>
      api<StationDeviceSummary>(`/devices/${deviceId}/approve`, {
        method: 'POST',
        body: { stationId },
      }),
    onSuccess: (_d, vars) => {
      const station = stations.find((s) => s.id === vars.stationId);
      toast.success(t('stations.approvedToast', { code: station?.code ?? '' }));
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const reject = useMutation({
    mutationFn: (deviceId: string) => api<void>(`/devices/${deviceId}/reject`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('stations.rejected'));
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Card
      title={
        <span className="row">
          <Cpu size={16} /> {t('stations.pendingTitle')}{' '}
          <Badge tone="warning">{devices.length}</Badge>
        </span>
      }
      flush
    >
      <div style={{ padding: '0 18px 6px' }} className="muted">
        {t('stations.pendingHint')}
      </div>
      {freeStations.length === 0 && (
        <div style={{ padding: '0 18px 12px' }}>
          <Alert tone="warning">{t('stations.noFreeStations')}</Alert>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>{t('stations.hostname')}</th>
            <th>{t('stations.machineId')}</th>
            <th>{t('stations.clientVersion')}</th>
            <th>{t('stations.ipAddress')}</th>
            <th>{t('stations.registered')}</th>
            <th>{t('stations.assignTo')}</th>
            <th className="right">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <td>
                <strong>{device.hostname ?? '—'}</strong>
                {device.osInfo && (
                  <div
                    className="faint"
                    title={device.osInfo}
                    style={{
                      fontSize: 12,
                      maxWidth: 220,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {device.osInfo}
                  </div>
                )}
              </td>
              <td className="mono" title={device.machineId}>
                {device.machineId.slice(0, 16)}…
              </td>
              <td>{device.appVersion ?? '—'}</td>
              <td className="mono">{device.lastIp ?? '—'}</td>
              <td>{fmt.dateTime(device.registeredAt)}</td>
              <td>
                <Select
                  value={selection[device.id] ?? ''}
                  onChange={(e) => setSelection((s) => ({ ...s, [device.id]: e.target.value }))}
                  style={{ minWidth: 180 }}
                >
                  <option value="">{t('stations.chooseStation')}</option>
                  {freeStations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {s.name}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="right">
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!selection[device.id]}
                    loading={approve.isPending && approve.variables?.deviceId === device.id}
                    onClick={() =>
                      approve.mutate({ deviceId: device.id, stationId: selection[device.id] ?? '' })
                    }
                  >
                    <Check size={14} /> {t('stations.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={reject.isPending && reject.variables === device.id}
                    onClick={() => reject.mutate(device.id)}
                  >
                    <X size={14} /> {t('stations.reject')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ─── Create / edit form ────────────────────────────────────────────────────────
function StationFormDialog({
  open,
  onClose,
  initial,
  title,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  initial: StationForm;
  title: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<StationForm>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(initial);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        number: Number(form.number),
        name: form.name.trim(),
        zone: form.zone.trim() || null,
        notes: form.notes.trim() || null,
        isEnabled: form.isEnabled,
      });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const generic =
    error instanceof ApiError && !fieldError(error, 'number') && !fieldError(error, 'name')
      ? error.message
      : null;

  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <form className="stack" onSubmit={submit}>
        {generic && <Alert tone="danger">{generic}</Alert>}
        <div className="form-grid">
          <Field
            label={t('stations.number')}
            hint={t('stations.numberHint')}
            error={fieldError(error, 'number')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={999}
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
                aria-invalid={invalid}
                required
                autoFocus
              />
            )}
          </Field>
          <Field label={t('stations.stationName')} error={fieldError(error, 'name')}>
            {(id, invalid) => (
              <Input
                id={id}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                aria-invalid={invalid}
                required
                maxLength={60}
              />
            )}
          </Field>
          <Field label={t('stations.zone')} optional className="span-2">
            {(id) => (
              <Input
                id={id}
                value={form.zone}
                onChange={(e) => setForm({ ...form, zone: e.target.value })}
                placeholder={t('stations.zonePlaceholder')}
                maxLength={60}
              />
            )}
          </Field>
          <Field label={t('common.notes')} optional className="span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                maxLength={500}
              />
            )}
          </Field>
        </div>
        <Switch
          checked={form.isEnabled}
          onChange={(v) => setForm({ ...form, isEnabled: v })}
          label={
            <span>
              {t('stations.enabled')}
              <div className="faint" style={{ fontSize: 12 }}>
                {t('stations.enabledHint')}
              </div>
            </span>
          }
        />
        <div className="form-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Detail dialog ─────────────────────────────────────────────────────────────
function StationDetailDialog({
  station,
  onClose,
  onChanged,
}: {
  station: StationSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, td } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const fmt = useFormat();
  const canManage = can(PERMISSIONS.STATIONS_MANAGE);
  const canDevices = can(PERMISSIONS.DEVICES_MANAGE);
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'reissue' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const status = station.isEnabled ? station.status : 'disabled';
  const device = station.device;

  const logs = useQuery({
    queryKey: ['stations', station.id, 'connection-logs'],
    queryFn: () => api<ConnectionLogEntry[]>(`/stations/${station.id}/connection-logs`),
  });

  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      onChanged();
      void logs.refetch();
      setConfirm(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="lg"
        title={`${station.code} · ${station.name}`}
        description={station.zone ?? undefined}
        footer={
          <>
            {canManage && (
              <Button
                variant="danger"
                onClick={() => setConfirm('delete')}
                disabled={Boolean(device && device.status === 'approved')}
                title={t('stations.deleteConfirmBody')}
              >
                <Trash2 size={14} /> {t('common.delete')}
              </Button>
            )}
            <div style={{ flex: 1 }} />
            {canManage && (
              <Button onClick={() => setEditOpen(true)}>{t('stations.editStation')}</Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        <div className="grid grid--2">
          <Card title={t('common.status')}>
            <div className="stack">
              <div className="row row--between">
                <span className="muted">{t('common.status')}</span>
                <Badge tone={STATUS_TONE[status]}>{td(`stations.status.${status}`, status)}</Badge>
              </div>
              <div className="row row--between">
                <span className="muted">{t('stations.enabled')}</span>
                <span>{station.isEnabled ? t('common.yes') : t('common.no')}</span>
              </div>
              <div className="row row--between">
                <span className="muted">{t('common.created')}</span>
                <span>{fmt.dateTime(station.createdAt)}</span>
              </div>
              {station.notes && (
                <div>
                  <div className="muted">{t('common.notes')}</div>
                  <div>{station.notes}</div>
                </div>
              )}
            </div>
          </Card>
          <Card title={t('sessions.title')}>
            <SessionPanel station={station} onChanged={onChanged} />
          </Card>
          <Card title={t('stations.device')}>
            {device ? (
              <div className="stack">
                <div className="row row--between">
                  <span className="muted">{t('stations.hostname')}</span>
                  <strong>{device.hostname ?? '—'}</strong>
                </div>
                <div className="row row--between">
                  <span className="muted">{t('common.status')}</span>
                  <Badge tone={device.online ? 'success' : 'default'} dot={device.online}>
                    {device.online ? t('stations.online') : t('stations.offline')}
                  </Badge>
                </div>
                <div className="row row--between">
                  <span className="muted">{t('stations.clientVersion')}</span>
                  <span>{device.appVersion ?? '—'}</span>
                </div>
                <div className="row row--between">
                  <span className="muted">{t('stations.ipAddress')}</span>
                  <span className="mono">{device.lastIp ?? '—'}</span>
                </div>
                <div className="row row--between">
                  <span className="muted">{t('stations.lastSeen')}</span>
                  <span>
                    {device.lastSeenAt ? fmt.dateTime(device.lastSeenAt) : t('common.never')}
                  </span>
                </div>
                <div className="row row--between">
                  <span className="muted">{t('stations.approved')}</span>
                  <span>{fmt.dateTime(device.approvedAt)}</span>
                </div>
                <div>
                  <div className="muted">{t('stations.machineId')}</div>
                  <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {device.machineId}
                  </div>
                </div>
                {device.osInfo && (
                  <div className="faint" style={{ fontSize: 12 }}>
                    {device.osInfo}
                  </div>
                )}
                {device.status === 'approved' && (
                  <DeviceCommands station={station} online={device.online} onDone={onChanged} />
                )}
                {canDevices && (
                  <div className="row row--wrap">
                    <Button size="sm" onClick={() => setConfirm('reissue')}>
                      <KeyRound size={14} /> {t('stations.reissueToken')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setConfirm('revoke')}>
                      <ShieldOff size={14} /> {t('stations.revokeDevice')}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<Cpu size={22} />}
                title={t('stations.noDevice')}
                hint={t('stations.pendingHint')}
              />
            )}
          </Card>
        </div>

        <Card title={t('stations.connectionLog')} flush className="mt">
          {logs.isLoading && <Loading />}
          {logs.data && logs.data.length === 0 && (
            <div className="empty">{t('stations.noConnectionLog')}</div>
          )}
          {logs.data && logs.data.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.time')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.details')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.slice(0, 25).map((entry) => (
                  <tr key={entry.id}>
                    <td className="num">{fmt.dateTime(entry.occurredAt)}</td>
                    <td>
                      <Badge
                        tone={
                          entry.event === 'connected'
                            ? 'success'
                            : entry.event === 'error' || entry.event === 'rejected'
                              ? 'danger'
                              : 'default'
                        }
                      >
                        {td(`stations.events.${entry.event}`, entry.event)}
                      </Badge>
                    </td>
                    <td className="mono faint" style={{ fontSize: 12 }}>
                      {Object.keys(entry.details).length ? JSON.stringify(entry.details) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Dialog>

      <StationFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('stations.editStation')}
        initial={{
          number: String(station.number),
          name: station.name,
          zone: station.zone ?? '',
          notes: station.notes ?? '',
          isEnabled: station.isEnabled,
        }}
        onSubmit={async (values) => {
          await api<StationSummary>(`/stations/${station.id}`, { method: 'PATCH', body: values });
          toast.success(t('stations.updated', { code: station.code }));
          onChanged();
        }}
      />

      <ConfirmDialog
        open={confirm === 'revoke'}
        onClose={() => setConfirm(null)}
        title={t('stations.revokeDevice')}
        body={t('stations.revokeConfirm')}
        danger
        loading={busy}
        confirmLabel={t('stations.revokeDevice')}
        onConfirm={() =>
          void run(
            () => api<void>(`/devices/${device?.id}/revoke`, { method: 'POST' }),
            t('stations.revoked'),
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'reissue'}
        onClose={() => setConfirm(null)}
        title={t('stations.reissueToken')}
        body={t('stations.reissueHint')}
        loading={busy}
        confirmLabel={t('stations.reissueToken')}
        onConfirm={() =>
          void run(
            () => api<void>(`/devices/${device?.id}/reissue-token`, { method: 'POST' }),
            t('stations.reissued'),
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title={t('stations.deleteConfirmTitle', { code: station.code })}
        body={t('stations.deleteConfirmBody')}
        danger
        loading={busy}
        confirmLabel={t('common.delete')}
        onConfirm={() =>
          void run(async () => {
            await api<void>(`/stations/${station.id}`, { method: 'DELETE' });
            onClose();
          }, t('stations.deleted'))
        }
      />
    </>
  );
}

const COMMAND_LABEL = {
  lock: 'stations.commands.lock',
  unlock: 'stations.commands.unlock',
  'message.show': 'stations.commands.messageShow',
  'power.restart': 'stations.commands.powerRestart',
  'power.shutdown': 'stations.commands.powerShutdown',
  'update.apply': 'stations.commands.updateApply',
} as const;

/** Lock / unlock / message / power / update — each one is a server command acknowledged by the PC. */
function DeviceCommands({
  station,
  online,
  onDone,
}: {
  station: StationSummary;
  online: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const [messageOpen, setMessageOpen] = useState(false);
  const [text, setText] = useState('');
  const [confirmPower, setConfirmPower] = useState<'power.restart' | 'power.shutdown' | null>(null);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const canPower = can(PERMISSIONS.STATIONS_POWER);
  const canDevices = can(PERMISSIONS.DEVICES_MANAGE);

  const send = useMutation({
    mutationFn: (body: StationCommandRequest) =>
      api<StationCommandResponse>(`/stations/${station.id}/command`, { method: 'POST', body }),
    onSuccess: (r) => {
      if (r.ok) toast.success(t('stations.commandOk', { command: t(COMMAND_LABEL[r.command]) }));
      else toast.error(t('stations.commandFailed', { error: r.error ?? '' }));
      setMessageOpen(false);
      setConfirmPower(null);
      setText('');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  if (!canControl) return null;
  const disabled = !online || send.isPending;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {online ? t('stations.commandsHint') : t('stations.commandsOffline')}
      </div>
      <div className="row row--wrap">
        <Button size="sm" disabled={disabled} onClick={() => send.mutate({ command: 'lock' })}>
          <Lock size={14} /> {t('stations.commands.lock')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => send.mutate({ command: 'unlock' })}>
          <LockOpen size={14} /> {t('stations.commands.unlock')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => setMessageOpen(true)}>
          <MessageSquare size={14} /> {t(COMMAND_LABEL['message.show'])}
        </Button>
        {canPower && (
          <>
            <Button size="sm" disabled={disabled} onClick={() => setConfirmPower('power.restart')}>
              <RotateCcw size={14} /> {t(COMMAND_LABEL['power.restart'])}
            </Button>
            <Button size="sm" disabled={disabled} onClick={() => setConfirmPower('power.shutdown')}>
              <Power size={14} /> {t(COMMAND_LABEL['power.shutdown'])}
            </Button>
          </>
        )}
        {canDevices && (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => send.mutate({ command: 'update.apply' })}
          >
            <DownloadCloud size={14} /> {t(COMMAND_LABEL['update.apply'])}
          </Button>
        )}
      </div>
      <Dialog
        open={messageOpen}
        onClose={() => setMessageOpen(false)}
        size="sm"
        title={t(COMMAND_LABEL['message.show'])}
        footer={
          <>
            <Button onClick={() => setMessageOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={send.isPending}
              disabled={!text.trim()}
              onClick={() =>
                send.mutate({ command: 'message.show', text: text.trim(), durationSeconds: 20 })
              }
            >
              {t('stations.sendMessage')}
            </Button>
          </>
        }
      >
        <Field label={t('stations.messageText')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              maxLength={300}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('stations.messagePlaceholder')}
            />
          )}
        </Field>
      </Dialog>
      {confirmPower && (
        <ConfirmDialog
          open
          danger
          title={t(COMMAND_LABEL[confirmPower])}
          body={t('stations.powerConfirm', { code: station.code })}
          confirmLabel={t(COMMAND_LABEL[confirmPower])}
          loading={send.isPending}
          onClose={() => setConfirmPower(null)}
          onConfirm={() => send.mutate({ command: confirmPower })}
        />
      )}
    </div>
  );
}
