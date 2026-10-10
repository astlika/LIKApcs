/**
 * Updates dashboard: which version runs where, what the newest published release is, and the
 * history of update attempts.
 *
 *  - The newest release is read from the signed update manifests the release workflow publishes
 *    (`latest.json` for the Admin/main-PC installer, `latest-client.json` for the Client). They are
 *    cached in `application_versions`; the dashboard works offline with the last known values.
 *  - Clients report `update_status` events while self-updating; those become `update_history`
 *    rows. The Admin app reports its own version changes through `POST /system/updates/events`,
 *    and the server records its own version change at start-up.
 *  - Actually installing updates stays where the signatures are verified: the Tauri updater in the
 *    Admin/Client apps. The server only tells outdated clients to update (`update.apply`).
 */
import {
  compareSemVer,
  parseSemVer,
  type ApplicationVersionSummary,
  type ClientUpdateRow,
  type ClientVersionState,
  type UpdateCheckState,
  type UpdateComponent,
  type UpdateEventRequest,
  type UpdateHistoryEntry,
  type UpdateStatus,
  type UpdatesOverview,
} from '@likapcs/shared';
import { withTransaction, type DbPool } from '../db/pool.js';
import { SERVER_VERSION } from '../version.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';

export interface UpdatesServiceOptions {
  schemaVersion: () => number;
  startedAt: () => Date;
  onlineDeviceIds: () => Set<string>;
  /** Base URL of the release feed (no trailing slash). Overridden in tests. */
  feedBaseUrl?: string;
  fetchTimeoutMs?: number;
  log?: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
}

export const DEFAULT_FEED_BASE_URL = 'https://github.com/astlika/LIKApcs/releases/latest/download';

interface ManifestFile {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, { url?: string; signature?: string }>;
}

interface VersionRow {
  component: UpdateComponent;
  version: string;
  channel: 'stable' | 'beta';
  released_at: Date | null;
  release_notes: string | null;
  download_url: string | null;
  signature: string | null;
  is_latest: boolean;
}

/** Client-side `update_status` values → update_history statuses. `none`/`unavailable` end a run. */
const CLIENT_STATUS_MAP: Record<string, UpdateStatus | 'none'> = {
  checking: 'pending',
  downloading: 'downloading',
  downloaded: 'downloaded',
  installing: 'installing',
  installed: 'succeeded',
  failed: 'failed',
  none: 'none',
  unavailable: 'none',
};

export class UpdatesService {
  private check: UpdateCheckState;

  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly options: UpdatesServiceOptions,
  ) {
    this.check = {
      checkedAt: null,
      ok: null,
      error: null,
      feedUrl: options.feedBaseUrl ?? DEFAULT_FEED_BASE_URL,
    };
  }

  // ─── Remote feed ─────────────────────────────────────────────────────────────

  /**
   * Fetches both manifests; never throws — the dashboard shows the error instead. Each manifest
   * is handled on its own, so a missing client manifest does not hide a new main-PC release.
   */
  async checkRemote(actor: AuditActor | null): Promise<UpdateCheckState> {
    const base = this.check.feedUrl;
    const channel = await this.settings.get('updates.channel');
    const checkedAt = new Date().toISOString();
    const errors: string[] = [];
    const found: Partial<Record<UpdateComponent, string>> = {};
    const targets: [UpdateComponent[], string][] = [
      [['admin', 'server'], `${base}/latest.json`], // the server ships inside the Admin installer
      [['client'], `${base}/latest-client.json`],
    ];
    const results = await Promise.allSettled(targets.map(([, url]) => this.fetchManifest(url)));
    for (const [i, result] of results.entries()) {
      const [components] = targets[i]!;
      if (result.status === 'rejected') {
        errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        continue;
      }
      try {
        for (const component of components) {
          await this.upsertVersion(component, result.value, channel);
          found[component] = result.value.version;
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    this.check = {
      ...this.check,
      checkedAt,
      ok: errors.length === 0,
      error: errors.length ? errors.join('; ') : null,
    };
    if (errors.length) this.options.log?.warn({ errors, found }, 'update check incomplete');
    else this.options.log?.info(found, 'update check');
    if (actor) {
      await recordAudit(this.pool, actor, {
        action: 'updates.check',
        entityType: null,
        entityId: null,
        details: { ok: this.check.ok, error: this.check.error, found },
      });
    }
    return this.check;
  }

  private async fetchManifest(url: string): Promise<ManifestFile> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.options.fetchTimeoutMs ?? 10_000),
      headers: { accept: 'application/json', 'user-agent': `LIKApcs-Server/${SERVER_VERSION}` },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    const data = (await response.json()) as ManifestFile;
    if (!data || typeof data.version !== 'string' || !parseSemVer(data.version)) {
      throw new Error(`${url} is not an update manifest`);
    }
    return data;
  }

  private async upsertVersion(
    component: UpdateComponent,
    manifest: ManifestFile,
    channel: 'stable' | 'beta',
  ): Promise<void> {
    const platform = manifest.platforms?.['windows-x86_64'];
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO application_versions
           (component, version, channel, schema_version, released_at, release_notes, download_url, signature, is_latest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (component, version) DO UPDATE
           SET channel = EXCLUDED.channel, released_at = EXCLUDED.released_at,
               release_notes = EXCLUDED.release_notes, download_url = EXCLUDED.download_url,
               signature = EXCLUDED.signature, is_latest = true`,
        [
          component,
          manifest.version,
          channel,
          component === 'server' ? this.options.schemaVersion() : null,
          manifest.pub_date ? new Date(manifest.pub_date) : null,
          manifest.notes ?? null,
          platform?.url ?? null,
          platform?.signature ?? null,
        ],
      );
      await client.query(
        `UPDATE application_versions SET is_latest = false WHERE component = $1 AND version <> $2`,
        [component, manifest.version],
      );
    });
  }

  // ─── Overview ────────────────────────────────────────────────────────────────

  async overview(): Promise<UpdatesOverview> {
    const [latestRows, deviceRows, historyRows, settings] = await Promise.all([
      this.pool.query<VersionRow>(
        `SELECT component, version, channel, released_at, release_notes, download_url, signature, is_latest
           FROM application_versions WHERE is_latest ORDER BY component`,
      ),
      this.pool.query<{
        id: string;
        station_id: string | null;
        station_code: string | null;
        station_name: string | null;
        hostname: string | null;
        app_version: string | null;
        last_seen_at: Date | null;
        last_status: UpdateStatus | null;
        last_to_version: string | null;
        last_started_at: Date | null;
        last_finished_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT d.id, d.station_id, s.code AS station_code, s.name AS station_name, d.hostname,
                d.app_version, d.last_seen_at,
                h.status AS last_status, h.to_version AS last_to_version, h.started_at AS last_started_at,
                h.finished_at AS last_finished_at, h.error_message AS last_error
           FROM station_devices d
           LEFT JOIN stations s ON s.id = d.station_id
           LEFT JOIN LATERAL (
             SELECT status, to_version, started_at, finished_at, error_message
               FROM update_history WHERE device_id = d.id ORDER BY started_at DESC LIMIT 1
           ) h ON true
          WHERE d.status = 'approved'
          ORDER BY s.number NULLS LAST, d.registered_at`,
      ),
      this.pool.query<{
        id: string;
        component: UpdateComponent;
        device_id: string | null;
        station_code: string | null;
        from_version: string | null;
        to_version: string;
        status: UpdateStatus;
        initiated_by_name: string | null;
        trigger: string | null;
        started_at: Date;
        finished_at: Date | null;
        error_message: string | null;
      }>(
        `SELECT h.id, h.component, h.device_id, s.code AS station_code, h.from_version, h.to_version,
                h.status, u.full_name AS initiated_by_name, h.started_at, h.finished_at, h.error_message,
                COALESCE(h.details->'first'->>'trigger', h.details->'last'->>'trigger') AS trigger
           FROM update_history h
           LEFT JOIN station_devices d ON d.id = h.device_id
           LEFT JOIN stations s ON s.id = d.station_id
           LEFT JOIN users u ON u.id = h.initiated_by
          ORDER BY h.started_at DESC LIMIT 50`,
      ),
      this.settings.getAll(),
    ]);
    const latest = (component: UpdateComponent): ApplicationVersionSummary | null => {
      const r = latestRows.rows.find((x) => x.component === component);
      return r ? toVersionSummary(r) : null;
    };
    const latestClient = latest('client');
    const latestAdmin = latest('admin');
    // Clients follow the server: the main PC (server + Admin) is updated first, then clients are
    // pushed to the server's version. A client may never run a newer minor than its server.
    const target = SERVER_VERSION;
    const serverUpdateAvailable =
      !!latestAdmin && compareSemVer(latestAdmin.version, SERVER_VERSION) > 0;
    const online = this.options.onlineDeviceIds();
    const clients: ClientUpdateRow[] = deviceRows.rows.map((d) => ({
      deviceId: d.id,
      stationId: d.station_id,
      stationCode: d.station_code,
      stationName: d.station_name,
      hostname: d.hostname,
      appVersion: d.app_version,
      online: online.has(d.id),
      lastSeenAt: d.last_seen_at?.toISOString() ?? null,
      state: versionState(d.app_version, target),
      lastUpdate: d.last_status
        ? {
            status: d.last_status,
            toVersion: d.last_to_version ?? target,
            startedAt: d.last_started_at!.toISOString(),
            finishedAt: d.last_finished_at?.toISOString() ?? null,
            errorMessage: d.last_error,
          }
        : null,
    }));
    const updating = clients.filter(
      (c) =>
        c.lastUpdate &&
        ['pending', 'downloading', 'downloaded', 'installing'].includes(c.lastUpdate.status) &&
        Date.now() - new Date(c.lastUpdate.startedAt).getTime() < 30 * 60_000,
    ).length;
    return {
      server: {
        version: SERVER_VERSION,
        schemaVersion: this.options.schemaVersion(),
        startedAt: this.options.startedAt().toISOString(),
      },
      targetVersion: target,
      latest: { admin: latestAdmin, client: latestClient, serverUpdateAvailable },
      check: this.check,
      policy: {
        channel: settings['updates.channel'],
        checkOnStartup: settings['updates.check_on_startup'],
        autoDownload: settings['updates.auto_download'],
        clientPolicy: settings['updates.client_policy'],
        maintenanceWindow: settings['updates.maintenance_window'],
      },
      clients,
      counts: {
        clients: clients.length,
        online: clients.filter((c) => c.online).length,
        outdated: clients.filter((c) => c.state === 'outdated').length,
        updating,
      },
      history: historyRows.rows.map((h): UpdateHistoryEntry => ({
        id: h.id,
        component: h.component,
        deviceId: h.device_id,
        stationCode: h.station_code,
        fromVersion: h.from_version,
        toVersion: h.to_version,
        status: h.status,
        initiatedByName: h.initiated_by_name,
        trigger: h.trigger,
        startedAt: h.started_at.toISOString(),
        finishedAt: h.finished_at?.toISOString() ?? null,
        errorMessage: h.error_message,
      })),
    };
  }

  // ─── History writers ─────────────────────────────────────────────────────────

  /** A client PC reported progress of its self-update (`client.event update_status`). */
  async recordClientStatus(
    deviceId: string,
    fromVersion: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const raw = typeof payload.status === 'string' ? payload.status : 'failed';
    const mapped = CLIENT_STATUS_MAP[raw] ?? 'failed';
    const version = typeof payload.version === 'string' ? payload.version : null;
    const error = typeof payload.error === 'string' ? payload.error.slice(0, 500) : null;
    const { rows: open } = await this.pool.query<{ id: string }>(
      `SELECT id FROM update_history
        WHERE device_id = $1 AND component = 'client'
          AND status IN ('pending', 'downloading', 'downloaded', 'installing')
          AND started_at > now() - interval '30 minutes'
        ORDER BY started_at DESC LIMIT 1`,
      [deviceId],
    );
    if (mapped === 'none') {
      // Nothing to install: close a pending run (if any) without recording a failure.
      if (open[0]) {
        await this.pool.query(
          `UPDATE update_history SET status = 'succeeded', finished_at = now(),
                  details = details || jsonb_build_object('result', $2::text)
            WHERE id = $1`,
          [open[0].id, raw],
        );
      }
      return;
    }
    const finished = mapped === 'succeeded' || mapped === 'failed' || mapped === 'rolled_back';
    if (open[0]) {
      await this.pool.query(
        `UPDATE update_history
            SET status = $2, to_version = COALESCE($3, to_version), error_message = $4,
                finished_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
                details = details || $6::jsonb
          WHERE id = $1`,
        [open[0].id, mapped, version, error, finished, JSON.stringify({ last: payload })],
      );
      return;
    }
    const latest = await this.pool.query<{ version: string }>(
      `SELECT version FROM application_versions WHERE component = 'client' AND is_latest LIMIT 1`,
    );
    await this.pool.query(
      `INSERT INTO update_history
         (component, device_id, from_version, to_version, status, finished_at, error_message, details)
       VALUES ('client', $1, $2, $3, $4, CASE WHEN $5::boolean THEN now() ELSE NULL END, $6, $7::jsonb)`,
      [
        deviceId,
        fromVersion,
        version ?? latest.rows[0]?.version ?? SERVER_VERSION,
        mapped,
        finished,
        error,
        JSON.stringify({ first: payload }),
      ],
    );
  }

  /** Admin app (or tooling) reports a version change of a non-client component. */
  async recordEvent(input: UpdateEventRequest, actor: AuditActor): Promise<UpdateHistoryEntry> {
    const finished = ['succeeded', 'failed', 'rolled_back'].includes(input.status);
    const { rows } = await this.pool.query<{
      id: string;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `INSERT INTO update_history
         (component, from_version, to_version, status, initiated_by, finished_at, error_message, details)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() ELSE NULL END, $7, '{}'::jsonb)
       RETURNING id, started_at, finished_at`,
      [
        input.component,
        input.fromVersion ?? null,
        input.toVersion,
        input.status,
        actor.userId ?? null,
        finished,
        input.error ?? null,
      ],
    );
    return {
      id: rows[0]!.id,
      component: input.component,
      deviceId: null,
      stationCode: null,
      fromVersion: input.fromVersion ?? null,
      toVersion: input.toVersion,
      status: input.status,
      initiatedByName: actor.label ?? null,
      trigger: null,
      startedAt: rows[0]!.started_at.toISOString(),
      finishedAt: rows[0]!.finished_at?.toISOString() ?? null,
      errorMessage: input.error ?? null,
    };
  }

  /** At start-up: note when the server binary changed version since the last run. */
  async recordServerStart(): Promise<boolean> {
    const { rows } = await this.pool.query<{ to_version: string }>(
      `SELECT to_version FROM update_history WHERE component = 'server'
        ORDER BY started_at DESC LIMIT 1`,
    );
    const last = rows[0]?.to_version ?? null;
    if (last === SERVER_VERSION) return false;
    await this.pool.query(
      `INSERT INTO update_history (component, from_version, to_version, status, finished_at, details)
       VALUES ('server', $1, $2, 'succeeded', now(), jsonb_build_object('schemaVersion', $3::int))`,
      [last, SERVER_VERSION, this.options.schemaVersion()],
    );
    return true;
  }
}

function toVersionSummary(r: VersionRow): ApplicationVersionSummary {
  return {
    component: r.component,
    version: r.version,
    channel: r.channel,
    releasedAt: r.released_at?.toISOString() ?? null,
    releaseNotes: r.release_notes,
    downloadUrl: r.download_url,
    signed: !!r.signature,
    isLatest: r.is_latest,
  };
}

export function versionState(appVersion: string | null, target: string): ClientVersionState {
  if (!appVersion || !parseSemVer(appVersion)) return 'unknown';
  const cmp = compareSemVer(appVersion, target);
  return cmp === 0 ? 'current' : cmp < 0 ? 'outdated' : 'newer';
}
