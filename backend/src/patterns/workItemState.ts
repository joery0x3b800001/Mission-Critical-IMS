import { WorkItemStatus } from '../types';
import { pgPool, withRetry } from '../db/postgres';

// ── State transition validation & MTTR calculation helper ─────────────────────
const updateWorkItemStatus = async (workItemId: string, status: WorkItemStatus): Promise<void> => {
  await withRetry(() =>
    pgPool.query(
      `UPDATE work_items SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, workItemId]
    )
  );
};

// ── State Machine: Validates transitions and enforces business rules ──────────
export interface WorkItemState {
  getStatus(): WorkItemStatus;
  transitionTo(workItemId: string, next: WorkItemStatus, rcaExists?: boolean): Promise<void>;
}

// ── Concrete state implementations with validation ────────────────────────────
export class OpenState implements WorkItemState {
  getStatus(): WorkItemStatus { return 'OPEN'; }
  async transitionTo(workItemId: string, next: WorkItemStatus): Promise<void> {
    if (next !== 'INVESTIGATING') {
      throw new Error(`Cannot transition from OPEN → ${next}. Only OPEN → INVESTIGATING allowed.`);
    }
    await updateWorkItemStatus(workItemId, next);
  }
}

export class InvestigatingState implements WorkItemState {
  getStatus(): WorkItemStatus { return 'INVESTIGATING'; }
  async transitionTo(workItemId: string, next: WorkItemStatus): Promise<void> {
    if (next !== 'RESOLVED') {
      throw new Error(`Cannot transition from INVESTIGATING → ${next}. Only INVESTIGATING → RESOLVED allowed.`);
    }
    await updateWorkItemStatus(workItemId, next);
  }
}

export class ResolvedState implements WorkItemState {
  getStatus(): WorkItemStatus { return 'RESOLVED'; }
  async transitionTo(workItemId: string, next: WorkItemStatus, rcaExists?: boolean): Promise<void> {
    if (next !== 'CLOSED') {
      throw new Error(`Cannot transition from RESOLVED → ${next}. Only RESOLVED → CLOSED allowed.`);
    }
    if (!rcaExists) {
      throw new Error('Cannot CLOSE work item: RCA record is missing or incomplete.');
    }
    
    // Calculate MTTR (Mean Time To Recovery) and close atomically
    await withRetry(async () => {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT r.incident_start, r.incident_end FROM work_items w
           JOIN rca_records r ON r.work_item_id = w.id WHERE w.id = $1 FOR UPDATE`,
          [workItemId]
        );
        if (!rows[0]) throw new Error('Work item or RCA not found');
        
        const mttrSeconds = Math.round(
          (new Date(rows[0].incident_end).getTime() - new Date(rows[0].incident_start).getTime()) / 1000
        );
        
        await client.query(
          `UPDATE work_items
           SET status = 'CLOSED', closed_at = NOW(), mttr_seconds = $1, updated_at = NOW()
           WHERE id = $2`,
          [mttrSeconds, workItemId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });
  }
}

export class ClosedState implements WorkItemState {
  getStatus(): WorkItemStatus { return 'CLOSED'; }
  async transitionTo(_workItemId: string, next: WorkItemStatus): Promise<void> {
    throw new Error(`Work item is CLOSED. No further transitions allowed. Attempted: → ${next}`);
  }
}

// ── State Factory: Instantiate state machine by current status ────────────────
export function getState(status: WorkItemStatus): WorkItemState {
  const states: Record<WorkItemStatus, WorkItemState> = {
    OPEN: new OpenState(),
    INVESTIGATING: new InvestigatingState(),
    RESOLVED: new ResolvedState(),
    CLOSED: new ClosedState(),
  };
  const state = states[status];
  if (!state) throw new Error(`Unknown work item status: ${status}`);
  return state;
}
