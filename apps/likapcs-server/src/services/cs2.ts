import type { Pool } from 'pg';
import {
  CS2_DEFAULT_CONFIG,
  CS2_RCON_PRESETS,
  cs2ConfigPatchSchema,
  cs2ConfigSchema,
  cs2ConnectUrl,
  cs2ServerArgs,
  generateCs2Secret,
  type Cs2Config,
  type Cs2ConfigPatch,
  type Cs2Preset,
  type Cs2StatusResponse,
  type Cs2StationCommand,
} from '@likapcs/shared';
import { AppError, badRequest, conflict } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { CommandsService } from './commands.js';
import { rconExec, RconError } from './cs2-rcon.js';
import type { StationsService } from './stations.js';

/** What the admin page may see: passwords are only reported as set or not set. */
function publicView(c: Cs2Config): Cs2StatusResponse['config'] {
  const { rconPassword, playerPassword, ...rest } = c;
  return {
    ...rest,
    rconPasswordSet: rconPassword !== '',
    playerPasswordSet: playerPassword !== '',
  };
}

/**
 * CS2 match server (0.24.0). One PC (the "server PC") runs the Counter-Strike 2 dedicated server;
 * the other PCs join it with one click; staff send match commands over RCON. The config lives in
 * `cs2_config` (one row), never in `settings`, so passwords stay out of the audit log.
 */
export class Cs2Service {
  /** The last outcome each PC reported for a CS2 command (in memory; the audit log keeps history). */
  private readonly results = new Map<
    string,
    { action: string; ok: boolean; message: string; at: string }
  >();

  constructor(
    private readonly pool: Pool,
    private readonly commands: CommandsService,
    private readonly stations: StationsService,
  ) {}

  /** Called when a PC reports the outcome of a CS2 command (`client.event` → `cs2_result`). */
  recordResult(stationId: string, result: { action: string; ok: boolean; message: string }): void {
    this.results.set(stationId, { ...result, at: new Date().toISOString() });
  }

  async config(): Promise<Cs2Config> {
    const r = await this.pool.query<{ config: unknown }>(
      'SELECT config FROM cs2_config WHERE id = 1',
    );
    const parsed = cs2ConfigSchema.safeParse(r.rows[0]?.config ?? {});
    return parsed.success ? parsed.data : { ...CS2_DEFAULT_CONFIG };
  }

  /** Upsert: a factory reset empties `cs2_config` (it is not on the keep list), so the row may be gone. */
  private async save(c: Cs2Config): Promise<void> {
    await this.pool.query(
      `INSERT INTO cs2_config (id, config, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify(c)],
    );
  }

  /** Makes sure the RCON password exists (generated on first use, never typed by staff). */
  private async ensureSecrets(c: Cs2Config): Promise<Cs2Config> {
    if (c.rconPassword) return c;
    const next = { ...c, rconPassword: generateCs2Secret() };
    await this.save(next);
    return next;
  }

  /** The address the panel and the PCs use: the configured one, or the server PC's LAN address. */
  resolveAddress(c: Cs2Config): string | null {
    if (c.serverAddress) return c.serverAddress;
    if (!c.serverStationId) return null;
    return this.commands.deviceAddressOf(c.serverStationId);
  }

  async status(): Promise<Cs2StatusResponse> {
    const c = await this.config();
    const station = c.serverStationId
      ? await this.stations.getById(c.serverStationId).catch(() => null)
      : null;
    return {
      config: publicView(c),
      serverStation: station
        ? {
            id: station.id,
            code: station.code,
            name: station.name,
            online: this.commands.isStationOnline(station.id),
            lastResult: this.results.get(station.id) ?? null,
          }
        : null,
      resolvedAddress: this.resolveAddress(c),
    };
  }

  async update(patchInput: unknown, actor: AuditActor): Promise<Cs2StatusResponse> {
    const parsed = cs2ConfigPatchSchema.safeParse(patchInput);
    if (!parsed.success)
      throw badRequest('Invalid CS2 settings', parsed.error.flatten().fieldErrors);
    const patch: Cs2ConfigPatch = parsed.data;
    const current = await this.config();
    if (patch.serverStationId) await this.stations.getById(patch.serverStationId);
    const merged = cs2ConfigSchema.parse({ ...current, ...patch });
    const withSecrets = await this.ensureSecrets(merged);
    await this.save(withSecrets);
    await recordAudit(this.pool, actor, {
      action: 'cs2.config.update',
      entityType: 'cs2',
      entityId: null,
      details: { changed: Object.keys(patch) },
    });
    return this.status();
  }

  /** Makes a new RCON or player password. Clients receive the new one on their next start/connect. */
  async regeneratePassword(kind: 'rcon' | 'player', actor: AuditActor): Promise<Cs2StatusResponse> {
    const current = await this.config();
    const next =
      kind === 'rcon'
        ? { ...current, rconPassword: generateCs2Secret() }
        : { ...current, playerPassword: generateCs2Secret() };
    await this.save(next);
    await recordAudit(this.pool, actor, {
      action: 'cs2.password.regenerate',
      entityType: 'cs2',
      entityId: null,
      details: { kind },
    });
    return this.status();
  }

  private async serverCommand(
    command: Cs2StationCommand,
    payload: Record<string, unknown>,
    actor: AuditActor,
  ) {
    const c = await this.config();
    if (!c.serverStationId)
      throw conflict('Choose the PC that runs the CS2 server first', { field: 'serverStationId' });
    await this.stations.getById(c.serverStationId);
    if (!this.commands.isStationOnline(c.serverStationId))
      throw conflict('The CS2 server PC is offline');
    return this.commands.sendCs2(c.serverStationId, command, payload, actor);
  }

  /** Installs the CS2 dedicated server on the server PC (SteamCMD, then the firewall rules). */
  install(actor: AuditActor) {
    return this.serverCommand('cs2.install', {}, actor);
  }

  /** Starts the server with the arguments built from the current config. */
  async start(actor: AuditActor) {
    const c = await this.ensureSecrets(await this.config());
    return this.serverCommand('cs2.start', { args: cs2ServerArgs(c) }, actor);
  }

  stop(actor: AuditActor) {
    return this.serverCommand('cs2.stop', {}, actor);
  }

  /** Sends every chosen PC a one-click link that starts CS2 and joins the server. */
  async connect(stationIds: string[], actor: AuditActor) {
    const c = await this.config();
    const address = this.resolveAddress(c);
    if (!address)
      throw conflict('The CS2 server address is not known yet — start the server PC first');
    const url = cs2ConnectUrl(address, c.port, c.playerPassword);
    const results = await Promise.all(
      stationIds.map(async (stationId) => {
        if (!this.commands.isStationOnline(stationId))
          return { stationId, ok: false, error: 'offline' as string | undefined };
        try {
          const r = await this.commands.sendCs2(stationId, 'cs2.connect', { url }, actor);
          return { stationId, ok: r.ok, error: r.error };
        } catch (err) {
          return { stationId, ok: false, error: err instanceof Error ? err.message : 'failed' };
        }
      }),
    );
    return { results };
  }

  /** Runs one match command (freezetime, restart, warmup end) on the CS2 server over RCON. */
  async rcon(preset: Cs2Preset, actor: AuditActor): Promise<{ command: string; output: string }> {
    const c = await this.ensureSecrets(await this.config());
    const address = this.resolveAddress(c);
    if (!address)
      throw conflict('The CS2 server address is not known yet — start the server PC first');
    const command = CS2_RCON_PRESETS[preset];
    try {
      const output = await rconExec({
        host: address,
        port: c.port,
        password: c.rconPassword,
        command,
        timeoutMs: 5000,
      });
      await recordAudit(this.pool, actor, {
        action: 'cs2.rcon',
        entityType: 'cs2',
        entityId: null,
        details: { preset, ok: true },
      });
      return { command, output };
    } catch (err) {
      const reason = err instanceof RconError ? err.code : 'protocol';
      await recordAudit(this.pool, actor, {
        action: 'cs2.rcon',
        entityType: 'cs2',
        entityId: null,
        details: { preset, ok: false, reason },
        severity: 'warning',
      });
      const message =
        reason === 'auth_failed'
          ? 'The CS2 server refused the RCON password'
          : reason === 'timeout'
            ? 'The CS2 server did not answer in time — is it running?'
            : 'The CS2 server is not reachable over RCON';
      throw new AppError(502, `cs2_rcon_${reason}`, message);
    }
  }
}
