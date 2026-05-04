import { Signal, ComponentType } from '../types';
import { pgPool, withRetry } from '../db/postgres';
import { getRawSignalsCollection } from '../db/mongo';
import { redis, Keys } from '../db/redis';
import { config } from '../config';
import { resolveAlertStrategy, AlertContext } from '../patterns/alertStrategy';
import { broadcastUpdate } from '../ws/broadcaster';

// Use Lua script for atomic debounce check
const DEBOUNCE_SCRIPT = `
-- KEYS[1] = debounce key
-- ARGV[1] = window TTL in ms
-- Returns: 1 if first signal, 0 if duplicate

local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

// Helper: Create new work item (extracted to eliminate duplication)
const createWorkItem = async (
  componentId: string,
  componentType: ComponentType,
  errorCode: string,
  timestamp: string
): Promise<{ id: string; priority: string }> => {
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
        [componentId, componentType, priority, title, timestamp]
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

  return { id: newWorkItem.id, priority };
};

export async function processSignal(signal: Signal): Promise<void> {
  const { componentId, componentType, errorCode } = signal;

  const debounceKey = Keys.debounce(componentId);
  const wiKey = Keys.workItemId(componentId);

  // 1. Atomic debounce check using Lua script
  const isFirstSignal = await redis.eval(
    DEBOUNCE_SCRIPT,
    1,
    debounceKey,
    config.debounceWindowMs
  );

  let workItemId: string;
  let priority: string;

  if (isFirstSignal === 1) {
    // Create Work Item (only once per debounce window)
    const newWorkItem = await createWorkItem(componentId, componentType, errorCode, signal.timestamp);
    workItemId = newWorkItem.id;
    priority = newWorkItem.priority;

    // Set work item ID in Redis with TTL
    await redis.set(
      wiKey,
      workItemId,
      'EX',
      Math.ceil(config.debounceWindowMs / 1000) + 60
    );

    // Fire alert
    const strategy = resolveAlertStrategy(componentType);
    const ctx = new AlertContext(strategy);
    ctx.notify(componentId, workItemId);

    // Broadcast to WebSocket clients
    broadcastUpdate({ type: 'WORK_ITEM_CREATED', workItemId, componentId, priority });
  } else {
    // Subsequent signal: try to get existing work item or create new one if expired
    const existingWorkItemId = await redis.get(wiKey);
    
    if (existingWorkItemId) {
      workItemId = existingWorkItemId;
      // Increment signal count in Postgres
      await withRetry(() =>
        pgPool.query(
          `UPDATE work_items SET signal_count = signal_count + 1, updated_at = NOW() WHERE id = $1`,
          [existingWorkItemId]
        )
      );
    } else {
      // Fallback: debounce window expired but signal still arriving
      const newWorkItem = await createWorkItem(componentId, componentType, errorCode, signal.timestamp);
      workItemId = newWorkItem.id;
      priority = newWorkItem.priority;

      await redis.set(wiKey, workItemId, 'EX', Math.ceil(config.debounceWindowMs / 1000) + 60);
      
      const strategy = resolveAlertStrategy(componentType);
      const ctx = new AlertContext(strategy);
      ctx.notify(componentId, workItemId);
      broadcastUpdate({ type: 'WORK_ITEM_CREATED', workItemId, componentId, priority });
    }
  }

  // 2. Parallelize MongoDB insert and PostgreSQL metric (non-blocking operations)
  Promise.all([
    // Write raw signal to MongoDB
    (async () => {
      try {
        const col = await getRawSignalsCollection();
        await col.insertOne({ ...signal, workItemId, ingestedAt: new Date() });
      } catch (err) {
        console.error('[Mongo] Failed to store raw signal:', (err as Error).message);
        // Non-fatal — audit log write failure doesn't block processing
      }
    })(),
    // Write timeseries metric (best effort)
    (async () => {
      try {
        await pgPool.query(
          `INSERT INTO signal_metrics (time, component_id, signal_count) VALUES (NOW(), $1, 1)`,
          [componentId]
        );
      } catch (_) { /* best effort */ }
    })()
  ]).catch(console.error); // Prevent unhandled rejection
}
