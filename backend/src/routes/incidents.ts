import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pgPool, withRetry } from '../db/postgres';
import { getRawSignalsCollection } from '../db/mongo';
import { redis, Keys } from '../db/redis';
import { getState } from '../patterns/workItemState';
import { WorkItemStatus } from '../types';
import { broadcastUpdate } from '../ws/broadcaster';

const RcaSchema = z.object({
  incidentStart: z.string().datetime(),
  incidentEnd: z.string().datetime(),
  rootCauseCategory: z.enum([
    'INFRASTRUCTURE', 'APPLICATION_BUG', 'CONFIGURATION',
    'DEPENDENCY_FAILURE', 'CAPACITY', 'NETWORK',
    'SECURITY', 'HUMAN_ERROR', 'UNKNOWN',
  ]),
  fixApplied: z.string().min(10, 'Fix applied must be at least 10 characters'),
  preventionSteps: z.string().min(10, 'Prevention steps must be at least 10 characters'),
});

const StatusSchema = z.object({
  status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED']),
});

export async function incidentRoutes(app: FastifyInstance) {
  // GET /incidents — list with pagination support
  // Query params: offset (default 0), limit (default 50, max 200)
  app.get('/incidents', async (req, reply) => {
    const offset = Math.max(0, parseInt((req.query as any).offset ?? '0', 10));
    const limit = Math.min(200, Math.max(1, parseInt((req.query as any).limit ?? '50', 10)));
    
    try {
      // Fetch total count for pagination metadata
      const { rows: countRows } = await pgPool.query(`SELECT COUNT(*) as total FROM work_items`);
      const total = parseInt(countRows[0].total, 10);
      
      const { rows } = await pgPool.query(
        `SELECT w.*, r.root_cause_category
         FROM work_items w
         LEFT JOIN rca_records r ON r.work_item_id = w.id
         ORDER BY
           CASE priority WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 ELSE 3 END,
           w.start_time DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return reply.send({
        incidents: rows.map(toWorkItem),
        pagination: { offset, limit, total, hasMore: offset + rows.length < total }
      });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to fetch incidents' });
    }
  });

  // GET /incidents/:id — detail with raw signals (paginated)
  app.get('/incidents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const signalOffset = Math.max(0, parseInt((req.query as any).signalOffset ?? '0', 10));
    const signalLimit = Math.min(100, Math.max(1, parseInt((req.query as any).signalLimit ?? '50', 10)));
    
    try {
      const { rows } = await pgPool.query(
        `SELECT w.*, r.id as rca_id, r.incident_start, r.incident_end,
                r.root_cause_category, r.fix_applied, r.prevention_steps, r.submitted_at
         FROM work_items w
         LEFT JOIN rca_records r ON r.work_item_id = w.id
         WHERE w.id = $1`,
        [id]
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Incident not found' });

      // Fetch raw signals from MongoDB with pagination
      const col = await getRawSignalsCollection();
      const [signals, totalSignals] = await Promise.all([
        col
          .find({ workItemId: id }, { projection: { _id: 0 } })
          .sort({ ingestedAt: -1 })
          .skip(signalOffset)
          .limit(signalLimit)
          .toArray(),
        col.countDocuments({ workItemId: id })
      ]);

      return reply.send({
        workItem: toWorkItem(rows[0]),
        rca: toRca(rows[0]),
        rawSignals: signals,
        signalsPagination: { offset: signalOffset, limit: signalLimit, total: totalSignals, hasMore: signalOffset + signals.length < totalSignals }
      });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to fetch incident detail' });
    }
  });

  // PATCH /incidents/:id/status — state transition
  app.patch('/incidents/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid status', details: parsed.error.flatten() });

    const nextStatus = parsed.data.status as WorkItemStatus;

    try {
      const { rows } = await pgPool.query(`SELECT status FROM work_items WHERE id = $1`, [id]);
      if (!rows[0]) return reply.status(404).send({ error: 'Incident not found' });

      const currentState = getState(rows[0].status as WorkItemStatus);

      // Check RCA if closing
      let rcaExists = false;
      if (nextStatus === 'CLOSED') {
        const { rows: rcaRows } = await pgPool.query(
          `SELECT id FROM rca_records WHERE work_item_id = $1`, [id]
        );
        rcaExists = rcaRows.length > 0;
      }

      await currentState.transitionTo(id, nextStatus, rcaExists);

      // Invalidate dashboard cache
      await redis.del(Keys.dashboard());

      broadcastUpdate({ type: 'STATUS_CHANGED', workItemId: id, status: nextStatus });
      return reply.send({ workItemId: id, status: nextStatus });
    } catch (err) {
      const message = (err as Error).message;
      const isLogic = message.includes('Cannot') || message.includes('CLOSED') || message.includes('RCA');
      return reply.status(isLogic ? 422 : 500).send({ error: message });
    }
  });

  // POST /incidents/:id/rca — submit RCA
  app.post('/incidents/:id/rca', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RcaSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid RCA payload', details: parsed.error.flatten() });

    const { incidentStart, incidentEnd, rootCauseCategory, fixApplied, preventionSteps } = parsed.data;

    if (new Date(incidentEnd) <= new Date(incidentStart)) {
      return reply.status(400).send({ error: 'incident_end must be after incident_start' });
    }

    try {
      const { rows: wiRows } = await pgPool.query(`SELECT status FROM work_items WHERE id = $1`, [id]);
      if (!wiRows[0]) return reply.status(404).send({ error: 'Incident not found' });
      if (wiRows[0].status === 'CLOSED') return reply.status(422).send({ error: 'Cannot modify RCA of a CLOSED incident' });

      await withRetry(() =>
        pgPool.query(
          `INSERT INTO rca_records (work_item_id, incident_start, incident_end, root_cause_category, fix_applied, prevention_steps)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (work_item_id) DO UPDATE SET
             incident_start = EXCLUDED.incident_start,
             incident_end = EXCLUDED.incident_end,
             root_cause_category = EXCLUDED.root_cause_category,
             fix_applied = EXCLUDED.fix_applied,
             prevention_steps = EXCLUDED.prevention_steps,
             submitted_at = NOW()`,
          [id, incidentStart, incidentEnd, rootCauseCategory, fixApplied, preventionSteps]
        )
      );

      broadcastUpdate({ type: 'RCA_SUBMITTED', workItemId: id });
      return reply.status(201).send({ workItemId: id, rcaSubmitted: true });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to save RCA' });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toWorkItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    componentId: row.component_id,
    componentType: row.component_type,
    priority: row.priority,
    status: row.status,
    title: row.title,
    signalCount: row.signal_count,
    startTime: row.start_time,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? null,
    mttrSeconds: row.mttr_seconds ?? null,
  };
}

function toRca(row: Record<string, unknown>) {
  if (!row.rca_id) return null;
  return {
    id: row.rca_id,
    workItemId: row.id,
    incidentStart: row.incident_start,
    incidentEnd: row.incident_end,
    rootCauseCategory: row.root_cause_category,
    fixApplied: row.fix_applied,
    preventionSteps: row.prevention_steps,
    submittedAt: row.submitted_at,
  };
}
