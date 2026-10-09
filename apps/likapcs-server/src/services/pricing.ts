/**
 * Pricing rules and prepaid packages (Phase 3). Rules decide the hourly terms for a station at a
 * given instant (business time zone); packages are fixed-price blocks of minutes.
 */
import {
  localClock,
  selectPricingRule,
  termsOf,
  type GamingPackageInput,
  type GamingPackageSummary,
  type PricingRuleInput,
  type PricingRuleLike,
  type PricingRuleSummary,
  type PricingTerms,
  type UpdateGamingPackageInput,
  type UpdatePricingRuleInput,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { badRequest, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';

interface RuleRow {
  id: string;
  name: string;
  station_id: string | null;
  station_code: string | null;
  days_of_week: number[];
  start_time: string | null;
  end_time: string | null;
  rate_cents_per_hour: string | number;
  billing_increment_minutes: number;
  minimum_charge_cents: string | number;
  minimum_minutes: number;
  rounding_mode: 'up' | 'down' | 'nearest';
  rounding_increment_cents: string | number;
  is_happy_hour: boolean;
  priority: number;
  is_active: boolean;
  valid_from: string | null;
  valid_to: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PackageRow {
  id: string;
  name: string;
  duration_minutes: number;
  price_cents: string | number;
  station_ids: string[] | null;
  days_of_week: number[];
  start_time: string | null;
  end_time: string | null;
  is_promotional: boolean;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

const RULE_SELECT = `
  SELECT r.id, r.name, r.station_id, s.code AS station_code, r.days_of_week,
         to_char(r.start_time, 'HH24:MI') AS start_time, to_char(r.end_time, 'HH24:MI') AS end_time,
         r.rate_cents_per_hour, r.billing_increment_minutes, r.minimum_charge_cents, r.minimum_minutes,
         r.rounding_mode, r.rounding_increment_cents, r.is_happy_hour, r.priority, r.is_active,
         to_char(r.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(r.valid_to, 'YYYY-MM-DD') AS valid_to,
         r.created_at, r.updated_at
    FROM pricing_rules r
    LEFT JOIN stations s ON s.id = r.station_id`;

const PACKAGE_SELECT = `
  SELECT p.id, p.name, p.duration_minutes, p.price_cents, p.station_ids, p.days_of_week,
         to_char(p.start_time, 'HH24:MI') AS start_time, to_char(p.end_time, 'HH24:MI') AS end_time,
         p.is_promotional, to_char(p.valid_from, 'YYYY-MM-DD') AS valid_from,
         to_char(p.valid_to, 'YYYY-MM-DD') AS valid_to, p.is_active, p.sort_order, p.created_at, p.updated_at
    FROM gaming_packages p`;

function mapRule(row: RuleRow): PricingRuleSummary {
  return {
    id: row.id,
    name: row.name,
    stationId: row.station_id,
    stationCode: row.station_code,
    daysOfWeek: row.days_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    rateCentsPerHour: Number(row.rate_cents_per_hour),
    billingIncrementMinutes: row.billing_increment_minutes,
    minimumChargeCents: Number(row.minimum_charge_cents),
    minimumMinutes: row.minimum_minutes,
    roundingMode: row.rounding_mode,
    roundingIncrementCents: Number(row.rounding_increment_cents),
    isHappyHour: row.is_happy_hour,
    priority: row.priority,
    isActive: row.is_active,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapPackage(row: PackageRow): GamingPackageSummary {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceCents: Number(row.price_cents),
    stationIds: row.station_ids,
    daysOfWeek: row.days_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    isPromotional: row.is_promotional,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ResolvedTerms {
  rule: PricingRuleSummary | null;
  terms: PricingTerms;
}

export class PricingService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
  ) {}

  // ─── Rules ───────────────────────────────────────────────────────────────────

  async listRules(db: Queryable = this.pool): Promise<PricingRuleSummary[]> {
    const result = await db.query<RuleRow>(
      `${RULE_SELECT} ORDER BY r.station_id NULLS FIRST, r.priority DESC, r.created_at`,
    );
    return result.rows.map(mapRule);
  }

  async getRule(id: string, db: Queryable = this.pool): Promise<PricingRuleSummary> {
    const result = await db.query<RuleRow>(`${RULE_SELECT} WHERE r.id = $1`, [id]);
    if (!result.rows[0]) throw notFound('Pricing rule');
    return mapRule(result.rows[0]);
  }

  async createRule(input: PricingRuleInput, actor: AuditActor): Promise<PricingRuleSummary> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO pricing_rules (name, station_id, days_of_week, start_time, end_time, rate_cents_per_hour,
         billing_increment_minutes, minimum_charge_cents, minimum_minutes, rounding_mode,
         rounding_increment_cents, is_happy_hour, priority, is_active, valid_from, valid_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [
        input.name,
        input.stationId,
        input.daysOfWeek,
        input.startTime,
        input.endTime,
        input.rateCentsPerHour,
        input.billingIncrementMinutes,
        input.minimumChargeCents,
        input.minimumMinutes,
        input.roundingMode,
        input.roundingIncrementCents,
        input.isHappyHour,
        input.priority,
        input.isActive,
        input.validFrom,
        input.validTo,
        actor.userId ?? null,
      ],
    );
    const rule = await this.getRule(inserted.rows[0]!.id);
    await recordAudit(this.pool, actor, {
      action: 'pricing.rule.create',
      entityType: 'pricing_rule',
      entityId: rule.id,
      details: { name: rule.name, rateCentsPerHour: rule.rateCentsPerHour },
    });
    return rule;
  }

  async updateRule(
    id: string,
    patch: UpdatePricingRuleInput,
    actor: AuditActor,
  ): Promise<PricingRuleSummary> {
    const current = await this.getRule(id);
    const next = { ...current, ...patch };
    if ((next.startTime === null) !== (next.endTime === null)) {
      throw badRequest('startTime and endTime must be given together');
    }
    await this.pool.query(
      `UPDATE pricing_rules SET name=$2, station_id=$3, days_of_week=$4, start_time=$5, end_time=$6,
         rate_cents_per_hour=$7, billing_increment_minutes=$8, minimum_charge_cents=$9, minimum_minutes=$10,
         rounding_mode=$11, rounding_increment_cents=$12, is_happy_hour=$13, priority=$14, is_active=$15,
         valid_from=$16, valid_to=$17
       WHERE id = $1`,
      [
        id,
        next.name,
        next.stationId,
        next.daysOfWeek,
        next.startTime,
        next.endTime,
        next.rateCentsPerHour,
        next.billingIncrementMinutes,
        next.minimumChargeCents,
        next.minimumMinutes,
        next.roundingMode,
        next.roundingIncrementCents,
        next.isHappyHour,
        next.priority,
        next.isActive,
        next.validFrom,
        next.validTo,
      ],
    );
    await recordAudit(this.pool, actor, {
      action: 'pricing.rule.update',
      entityType: 'pricing_rule',
      entityId: id,
      details: { changes: patch },
    });
    return this.getRule(id);
  }

  async deleteRule(id: string, actor: AuditActor): Promise<void> {
    const rule = await this.getRule(id);
    const used = await this.pool.query(
      'SELECT 1 FROM gaming_sessions WHERE pricing_rule_id = $1 LIMIT 1',
      [id],
    );
    if (used.rowCount) {
      // Keep history intact: rules referenced by sessions are deactivated, not removed.
      await this.pool.query('UPDATE pricing_rules SET is_active = false WHERE id = $1', [id]);
    } else {
      await this.pool.query('DELETE FROM pricing_rules WHERE id = $1', [id]);
    }
    await recordAudit(this.pool, actor, {
      action: 'pricing.rule.delete',
      entityType: 'pricing_rule',
      entityId: id,
      details: { name: rule.name, deactivatedOnly: Boolean(used.rowCount) },
    });
  }

  /** Terms in force for a station at `at`. Falls back to a zero rate when no rule matches. */
  async resolveTerms(
    stationId: string,
    at: Date = new Date(),
    db: Queryable = this.pool,
  ): Promise<ResolvedTerms> {
    const rules = await this.listRules(db);
    const timeZone = await this.settings.get('locale.timezone');
    const clock = localClock(at, safeTimeZone(timeZone));
    const candidates: (PricingRuleLike & { summary: PricingRuleSummary })[] = rules.map((r) => ({
      ...r,
      summary: r,
    }));
    const rule = selectPricingRule(candidates, stationId, clock);
    if (!rule) {
      return {
        rule: null,
        terms: {
          rateCentsPerHour: 0,
          billingIncrementMinutes: 1,
          minimumMinutes: 0,
          minimumChargeCents: 0,
          roundingMode: 'up',
          roundingIncrementCents: 1,
        },
      };
    }
    return { rule: rule.summary, terms: termsOf(rule) };
  }

  // ─── Packages ────────────────────────────────────────────────────────────────

  async listPackages(db: Queryable = this.pool): Promise<GamingPackageSummary[]> {
    const result = await db.query<PackageRow>(
      `${PACKAGE_SELECT} ORDER BY p.sort_order, p.duration_minutes`,
    );
    return result.rows.map(mapPackage);
  }

  async getPackage(id: string, db: Queryable = this.pool): Promise<GamingPackageSummary> {
    const result = await db.query<PackageRow>(`${PACKAGE_SELECT} WHERE p.id = $1`, [id]);
    if (!result.rows[0]) throw notFound('Package');
    return mapPackage(result.rows[0]);
  }

  /** Packages a station may buy right now (active, station allowed, inside the time window). */
  async availablePackages(
    stationId: string,
    at: Date = new Date(),
  ): Promise<GamingPackageSummary[]> {
    const all = await this.listPackages();
    const clock = localClock(at, safeTimeZone(await this.settings.get('locale.timezone')));
    return all.filter((p) => this.packageAvailable(p, stationId, clock));
  }

  packageAvailable(
    p: GamingPackageSummary,
    stationId: string,
    clock: ReturnType<typeof localClock>,
  ): boolean {
    if (!p.isActive) return false;
    if (p.stationIds && !p.stationIds.includes(stationId)) return false;
    const like: PricingRuleLike = {
      id: p.id,
      stationId: null,
      daysOfWeek: p.daysOfWeek,
      startTime: p.startTime,
      endTime: p.endTime,
      priority: 0,
      isActive: p.isActive,
      validFrom: p.validFrom,
      validTo: p.validTo,
      rateCentsPerHour: 0,
      billingIncrementMinutes: 1,
      minimumMinutes: 0,
      minimumChargeCents: 0,
      roundingMode: 'up',
      roundingIncrementCents: 1,
    };
    return selectPricingRule([like], stationId, clock) !== null;
  }

  async createPackage(input: GamingPackageInput, actor: AuditActor): Promise<GamingPackageSummary> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO gaming_packages (name, duration_minutes, price_cents, station_ids, days_of_week, start_time,
         end_time, is_promotional, valid_from, valid_to, is_active, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        input.name,
        input.durationMinutes,
        input.priceCents,
        input.stationIds,
        input.daysOfWeek,
        input.startTime,
        input.endTime,
        input.isPromotional,
        input.validFrom,
        input.validTo,
        input.isActive,
        input.sortOrder,
        actor.userId ?? null,
      ],
    );
    const pkg = await this.getPackage(inserted.rows[0]!.id);
    await recordAudit(this.pool, actor, {
      action: 'pricing.package.create',
      entityType: 'gaming_package',
      entityId: pkg.id,
      details: { name: pkg.name, durationMinutes: pkg.durationMinutes, priceCents: pkg.priceCents },
    });
    return pkg;
  }

  async updatePackage(
    id: string,
    patch: UpdateGamingPackageInput,
    actor: AuditActor,
  ): Promise<GamingPackageSummary> {
    const current = await this.getPackage(id);
    const next = { ...current, ...patch };
    await this.pool.query(
      `UPDATE gaming_packages SET name=$2, duration_minutes=$3, price_cents=$4, station_ids=$5, days_of_week=$6,
         start_time=$7, end_time=$8, is_promotional=$9, valid_from=$10, valid_to=$11, is_active=$12, sort_order=$13
       WHERE id = $1`,
      [
        id,
        next.name,
        next.durationMinutes,
        next.priceCents,
        next.stationIds,
        next.daysOfWeek,
        next.startTime,
        next.endTime,
        next.isPromotional,
        next.validFrom,
        next.validTo,
        next.isActive,
        next.sortOrder,
      ],
    );
    await recordAudit(this.pool, actor, {
      action: 'pricing.package.update',
      entityType: 'gaming_package',
      entityId: id,
      details: { changes: patch },
    });
    return this.getPackage(id);
  }

  async deletePackage(id: string, actor: AuditActor): Promise<void> {
    const pkg = await this.getPackage(id);
    const used = await this.pool.query(
      'SELECT 1 FROM gaming_sessions WHERE package_id = $1 LIMIT 1',
      [id],
    );
    if (used.rowCount)
      await this.pool.query('UPDATE gaming_packages SET is_active = false WHERE id = $1', [id]);
    else await this.pool.query('DELETE FROM gaming_packages WHERE id = $1', [id]);
    await recordAudit(this.pool, actor, {
      action: 'pricing.package.delete',
      entityType: 'gaming_package',
      entityId: id,
      details: { name: pkg.name, deactivatedOnly: Boolean(used.rowCount) },
    });
  }
}

export function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}
