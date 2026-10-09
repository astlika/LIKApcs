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
  return pool;
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
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; release below */
    }
    throw err;
  } finally {
    client.release();
  }
}
