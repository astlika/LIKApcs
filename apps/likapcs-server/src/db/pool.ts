import pg from 'pg';

const { Pool, types } = pg;

// int8 (BIGINT) → JavaScript number, refusing values outside the safe range.
// All money/quantity columns are BIGINT; a value beyond 2^53 cents would be a bug, not data.
types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`BIGINT value ${value} exceeds the JavaScript safe integer range`);
  }
  return n;
});
// Keep NUMERIC as string (we do not use NUMERIC for authoritative values).
types.setTypeParser(1700, (value: string) => value);

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool (auto-commit) or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, options: { max?: number } = {}): DbPool {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'likapcs-server',
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. database restarted). The pool recovers by creating new clients.
    console.error('[db] idle client error:', err.message);
  });
  // Schedules (ads' weekly hours, daily reports) are evaluated "in local time": pin every
  // connection to the server process's zone so SQL and JavaScript never disagree.
  const zone = localTimeZone();
  if (zone) {
    pool.on('connect', (client) => {
      client.query(`SET TIME ZONE '${zone.replace(/'/g, '')}'`).catch((err: Error) => {
        console.error('[db] could not set the session time zone:', err.message);
      });
    });
  }
  return pool;
}

const commitHooks = new WeakMap<DbClient, (() => void | Promise<void>)[]>();

/**
 * Runs `fn` once the surrounding `withTransaction` has committed (never on rollback). For side
 * effects that must only follow durable data — pushing a changed balance to a PC, say — and that
 * read through another connection, which would not see the uncommitted rows. Failures are
 * logged, not propagated: the transaction is already committed. Outside a transaction (a bare
 * pool client) the hook runs right away.
 */
export function afterCommit(client: DbClient, fn: () => void | Promise<void>): void {
  const hooks = commitHooks.get(client);
  if (hooks) hooks.push(fn);
  else void Promise.resolve().then(fn).catch(reportHookError);
}

function reportHookError(err: unknown): void {
  console.error('[db] after-commit hook failed:', err instanceof Error ? err.message : err);
}

/**
 * Runs `fn` inside a transaction. Commits on success, rolls back on any throw.
 * Nested usage must pass the same client down instead of calling withTransaction again.
 */
export async function withTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const hooks: (() => void | Promise<void>)[] = [];
  commitHooks.set(client, hooks);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    commitHooks.delete(client);
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        reportHookError(err);
      }
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; release below */
    }
    throw err;
  } finally {
    commitHooks.delete(client);
    client.release();
  }
}

/** IANA zone of this process (e.g. `Europe/Belgrade`), or null when unknown. */
function localTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && /^[A-Za-z0-9_+\-/]+$/.test(zone) && zone !== 'Etc/Unknown' ? zone : null;
  } catch {
    return null;
  }
}
