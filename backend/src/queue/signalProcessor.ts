import { Signal } from '../types';
import { pgPool, withRetry } from '../db/postgres';
import { getRawSignalsCollection } from '../db/mongo';
import { redis, Keys } from '../db/redis';
import { config } from '../config';
import { resolveAlertStrategy, AlertContext } from '../patterns/alertStrategy';
import { broadcastUpdate } from '../ws/broadcaster';

export async function processSignal(signal: Signal): Promise<void> {
  const { componentId, componentType, errorCode } = signal;

  // 1. Always store raw signal in MongoDB (fire-and-forget path)
  let workItemId: string | null = null;

  // 2. Debounce: atomic INCR in Redis
  const debounceKey = Keys.debounce(componentId);
  const wiKey = Keys.workItemId(componentId);

  const count = await redis.incr(debounceKey);
  if (count === 1) {
    // First signal in this window → set TTL
    await redis.pexpire(debounceKey, config.debounceWindowMs);
  }

  if (count === 1) {
    // Create Work Item (only once per debounce window)
    const strategy = resolveAlertStrategy(componentType);
    const ctx = new AlertContext(strategy);
    const title = ctx.getTitle(componentId, errorCode);
    const priority = ctx.getPriority();

    const newWorkItem = await withRetry(async () => {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO work_items (component_id, component_type, priority, status, title, signal_count, start_time, updated_at)
           VALUES ($1, $2, $3, 'OPEN', $4, 1, $5, NOW())
           RETURNING id`,
          [componentId, componentType, priority, title, signal.timestamp]
        );
        await client.query('COMMIT');
        return rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    workItemId = newWorkItem.id;
    await redis.set(wiKey, workItemId, 'EX', Math.ceil(config.debounceWindowMs / 1000) + 60);

    // Fire alert
    ctx.notify(componentId, workItemId);

    // Broadcast to WebSocket clients
    broadcastUpdate({ type: 'WORK_ITEM_CREATED', workItemId, componentId, priority });

  } else {
    // Subsequent signal: just increment signal_count in Postgres
    workItemId = await redis.get(wiKey);
    if (workItemId) {
      await withRetry(() =>
        pgPool.query(
          `UPDATE work_items SET signal_count = signal_count + 1, updated_at = NOW() WHERE id = $1`,
          [workItemId]
        )
      );
    }
  }

  // 3. Always write raw signal to MongoDB
  try {
    const col = await getRawSignalsCollection();
    await col.insertOne({ ...signal, workItemId, ingestedAt: new Date() });
  } catch (err) {
    console.error('[Mongo] Failed to store raw signal:', (err as Error).message);
    // Non-fatal — audit log write failure doesn't block processing
  }

  // 4. Timeseries metric
  try {
    await pgPool.query(
      `INSERT INTO signal_metrics (time, component_id, signal_count) VALUES (NOW(), $1, 1)`,
      [componentId]
    );
  } catch (_) { /* best effort */ }
}
