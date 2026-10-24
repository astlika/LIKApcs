import {
  applyStationLook,
  checkLayoutSettings,
  clientDisplayFromSettings,
  compactLook,
  layoutPresetBodySchema,
  type LayoutPresetSummary,
  wallpaperPath,
  type ClientDisplayConfig,
  type ServerToClientMessage,
  type SettingsMap,
  type StationLook,
  type StationSummary,
} from '@likapcs/shared';
import fs from 'node:fs';
import type { WallpaperKind } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { ProductImageStore } from './product-images.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

/**
 * 0.20.0: looks. Each PC's customer screen = the house `client.*` settings, plus the PC's own
 * overrides (`stations.look`), plus its lock-screen wallpaper (`stations.wallpaper_file`).
 * Presets are named sets of house layout settings that the Admin applies with `PATCH /settings`.
 */

interface LookRow {
  id: string;
  look: StationLook | null;
  wallpaper_file: string | null;
  desktop_wallpaper_file: string | null;
}

interface PresetRow {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export class LooksService {
  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly settings: SettingsService,
    private readonly stations: StationsService,
    /** Wallpapers are stored like product pictures (random names, sniffed formats). */
    readonly wallpapers: ProductImageStore,
  ) {}

  /** What one PC shows: house settings with its overrides and wallpaper applied. */
  async displayFor(stationId: string, all: SettingsMap): Promise<ClientDisplayConfig> {
    const r = await this.pool.query<LookRow>(
      'SELECT id, look, wallpaper_file, desktop_wallpaper_file FROM stations WHERE id = $1',
      [stationId],
    );
    return this.displayOf(all, r.rows[0]);
  }

  private displayOf(all: SettingsMap, row: LookRow | undefined): ClientDisplayConfig {
    return applyStationLook(
      clientDisplayFromSettings(all),
      row?.look ?? {},
      row?.wallpaper_file ? wallpaperPath(row.wallpaper_file) : null,
      row?.desktop_wallpaper_file ? wallpaperPath(row.desktop_wallpaper_file) : null,
    );
  }

  private displayMessage(all: SettingsMap, row: LookRow | undefined): ServerToClientMessage {
    return {
      type: 'server.display',
      display: this.displayOf(all, row),
      businessName: all['business.name'],
      welcomeMessage: all['stations.client_welcome_message'],
      language: all['locale.default_language'],
    };
  }

  /** Sends every connected PC its own display (house settings or ads changed). */
  async pushAll(all: SettingsMap): Promise<void> {
    const devices = this.hub.listDevices();
    if (devices.length === 0) return;
    const r = await this.pool.query<LookRow>(
      'SELECT id, look, wallpaper_file, desktop_wallpaper_file FROM stations WHERE id = ANY($1::uuid[])',
      [devices.map((d) => d.stationId)],
    );
    const byStation = new Map(r.rows.map((row) => [row.id, row]));
    for (const device of devices) {
      this.hub.sendToDevice(
        device.deviceId,
        this.displayMessage(all, byStation.get(device.stationId)),
      );
    }
  }

  /** After one PC's look or wallpaper changed: that PC gets its display, the Admin the station. */
  private async announce(stationId: string): Promise<StationSummary> {
    const station = await this.stations.getById(stationId);
    const devices = this.hub.listDevices().filter((d) => d.stationId === stationId);
    if (devices.length > 0) {
      const all = await this.settings.getAll();
      const r = await this.pool.query<LookRow>(
        'SELECT id, look, wallpaper_file, desktop_wallpaper_file FROM stations WHERE id = $1',
        [stationId],
      );
      const message = this.displayMessage(all, r.rows[0]);
      for (const device of devices) this.hub.sendToDevice(device.deviceId, message);
    }
    this.hub.broadcastToAdmins('station.changed', station);
    return station;
  }

  async setLook(stationId: string, look: StationLook, actor: AuditActor): Promise<StationSummary> {
    const clean = compactLook(look);
    const r = await this.pool.query(
      'UPDATE stations SET look = $2::jsonb WHERE id = $1 RETURNING id',
      [stationId, JSON.stringify(clean)],
    );
    if (!r.rowCount) throw notFound('Station');
    await recordAudit(this.pool, actor, {
      action: 'station.look.updated',
      entityType: 'station',
      entityId: stationId,
      details: { look: clean },
    });
    return this.announce(stationId);
  }

  /** Column of each wallpaper kind: a fixed map, never built from input. */
  private static readonly WALLPAPER_COLUMN: Record<
    WallpaperKind,
    'wallpaper_file' | 'desktop_wallpaper_file'
  > = { lock: 'wallpaper_file', desktop: 'desktop_wallpaper_file' };

  /** Stores an already-saved wallpaper file for the PC and removes the one it replaces. */
  async setWallpaper(
    stationId: string,
    fileName: string,
    actor: AuditActor,
    kind: WallpaperKind = 'lock',
  ): Promise<StationSummary> {
    const column = LooksService.WALLPAPER_COLUMN[kind];
    const before = await this.pool.query<{ file: string | null }>(
      `SELECT ${column} AS file FROM stations WHERE id = $1`,
      [stationId],
    );
    if (!before.rowCount) throw notFound('Station');
    await this.pool.query(`UPDATE stations SET ${column} = $2 WHERE id = $1`, [
      stationId,
      fileName,
    ]);
    await this.wallpapers.remove(before.rows[0]!.file);
    await recordAudit(this.pool, actor, {
      action: kind === 'lock' ? 'station.wallpaper.set' : 'station.desktop_wallpaper.set',
      entityType: 'station',
      entityId: stationId,
      details: { file: fileName },
    });
    return this.announce(stationId);
  }

  async clearWallpaper(
    stationId: string,
    actor: AuditActor,
    kind: WallpaperKind = 'lock',
  ): Promise<StationSummary> {
    const column = LooksService.WALLPAPER_COLUMN[kind];
    const before = await this.pool.query<{ file: string | null }>(
      `SELECT ${column} AS file FROM stations WHERE id = $1`,
      [stationId],
    );
    if (!before.rowCount) throw notFound('Station');
    await this.pool.query(`UPDATE stations SET ${column} = NULL WHERE id = $1`, [stationId]);
    await this.wallpapers.remove(before.rows[0]!.file);
    await recordAudit(this.pool, actor, {
      action: kind === 'lock' ? 'station.wallpaper.cleared' : 'station.desktop_wallpaper.cleared',
      entityType: 'station',
      entityId: stationId,
    });
    return this.announce(stationId);
  }

  /**
   * 0.23.0: the stations a bulk wallpaper goes to: `all` (every PC not archived) or the listed ids,
   * which must all exist.
   */
  async stationIdsFor(target: 'all' | string[]): Promise<string[]> {
    if (target === 'all') {
      const r = await this.pool.query<{ id: string }>(
        'SELECT id FROM stations WHERE archived_at IS NULL ORDER BY number',
      );
      return r.rows.map((row) => row.id);
    }
    const unique = [...new Set(target)];
    const r = await this.pool.query<{ id: string }>(
      'SELECT id FROM stations WHERE id = ANY($1::uuid[])',
      [unique],
    );
    if (r.rowCount !== unique.length) throw notFound('Station');
    return unique;
  }

  /**
   * Sets one picture on several PCs. Each PC keeps its own stored copy, because replacing a
   * wallpaper removes the file it replaces.
   */
  async setWallpaperForStations(
    stationIds: string[],
    sourcePath: string,
    kind: WallpaperKind,
    actor: AuditActor,
  ): Promise<void> {
    for (const stationId of stationIds) {
      const fileName = await this.wallpapers.saveStream(fs.createReadStream(sourcePath));
      await this.setWallpaper(stationId, fileName, actor, kind);
    }
  }

  // ─── Layout presets ───────────────────────────────────────────────────────

  private presetSummary(row: PresetRow): LayoutPresetSummary {
    return {
      id: row.id,
      name: row.name,
      settings: row.settings,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listPresets(): Promise<LayoutPresetSummary[]> {
    const r = await this.pool.query<PresetRow>(
      'SELECT id, name, settings, created_at, updated_at FROM client_layout_presets ORDER BY lower(name)',
    );
    return r.rows.map((row) => this.presetSummary(row));
  }

  private checkPreset(input: unknown): { name: string; settings: Record<string, unknown> } {
    const body = layoutPresetBodySchema.safeParse(input);
    if (!body.success) {
      throw badRequest('Give the preset a name (1–60 characters)', { field: 'name' });
    }
    const check = checkLayoutSettings(body.data.settings);
    if (!check.ok) throw badRequest(check.message, { field: check.key });
    return { name: body.data.name, settings: check.settings };
  }

  async createPreset(input: unknown, actor: AuditActor): Promise<LayoutPresetSummary> {
    const preset = this.checkPreset(input);
    try {
      const r = await this.pool.query<PresetRow>(
        `INSERT INTO client_layout_presets (name, settings, created_by)
         VALUES ($1, $2::jsonb, $3) RETURNING id, name, settings, created_at, updated_at`,
        [preset.name, JSON.stringify(preset.settings), actor.userId],
      );
      await recordAudit(this.pool, actor, {
        action: 'client.layout_preset.created',
        entityType: 'layout_preset',
        entityId: r.rows[0]!.id,
        details: { name: preset.name },
      });
      return this.presetSummary(r.rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('A preset with this name already exists', { field: 'name' });
      }
      throw err;
    }
  }

  async updatePreset(id: string, input: unknown, actor: AuditActor): Promise<LayoutPresetSummary> {
    const preset = this.checkPreset(input);
    try {
      const r = await this.pool.query<PresetRow>(
        `UPDATE client_layout_presets SET name = $2, settings = $3::jsonb WHERE id = $1
         RETURNING id, name, settings, created_at, updated_at`,
        [id, preset.name, JSON.stringify(preset.settings)],
      );
      if (!r.rowCount) throw notFound('Preset');
      await recordAudit(this.pool, actor, {
        action: 'client.layout_preset.updated',
        entityType: 'layout_preset',
        entityId: id,
        details: { name: preset.name },
      });
      return this.presetSummary(r.rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('A preset with this name already exists', { field: 'name' });
      }
      throw err;
    }
  }

  async deletePreset(id: string, actor: AuditActor): Promise<void> {
    const r = await this.pool.query<{ name: string }>(
      'DELETE FROM client_layout_presets WHERE id = $1 RETURNING name',
      [id],
    );
    if (!r.rowCount) throw notFound('Preset');
    await recordAudit(this.pool, actor, {
      action: 'client.layout_preset.deleted',
      entityType: 'layout_preset',
      entityId: id,
      details: { name: r.rows[0]!.name },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
