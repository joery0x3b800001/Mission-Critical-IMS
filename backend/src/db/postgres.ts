import { Pool } from 'pg';
import { config } from '../config';

export const pgPool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,             // Configurable pool size (default 50)
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  statement_timeout: config.dbStatementTimeoutMs, // Kill slow queries to prevent connection exhaustion
});

pgPool.on('error', (err) => {
  console.error('[Postgres] Unexpected pool error:', err.message);
});

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = config.queueRetryAttempts,
  delayMs = config.queueRetryDelayMs
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = delayMs * Math.pow(2, attempt - 1); // exponential backoff
      console.warn(`[Postgres] Retry attempt ${attempt}/${retries} after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

export async function closePostgresPool(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    console.log('[Postgres] Pool closed');
  }
}
