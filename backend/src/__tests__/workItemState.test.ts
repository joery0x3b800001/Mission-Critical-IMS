import {
  OpenState,
  InvestigatingState,
  ResolvedState,
  ClosedState,
  getState,
} from '../patterns/workItemState';
import { pgPool } from '../db/postgres';

// Mock the PostgreSQL pool
jest.mock('../db/postgres', () => ({
  pgPool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
  withRetry: jest.fn((fn: any) => fn()),
}));

describe('WorkItemState Pattern', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── OpenState Tests ──────────────────────────────────────────────────────────
  describe('OpenState', () => {
    it('should return OPEN status', () => {
      const state = new OpenState();
      expect(state.getStatus()).toBe('OPEN');
    });

    it('should allow transition from OPEN to INVESTIGATING', async () => {
      const state = new OpenState();
      const pgMock = pgPool.query as jest.Mock;
      pgMock.mockResolvedValue({});

      await expect(state.transitionTo('wi-001', 'INVESTIGATING')).resolves.not.toThrow();
      expect(pgMock).toHaveBeenCalled();
    });

    it('should reject transition from OPEN to RESOLVED', async () => {
      const state = new OpenState();
      await expect(state.transitionTo('wi-001', 'RESOLVED')).rejects.toThrow(
        'Cannot transition from OPEN → RESOLVED'
      );
    });

    it('should reject transition from OPEN to CLOSED', async () => {
      const state = new OpenState();
      await expect(state.transitionTo('wi-001', 'CLOSED')).rejects.toThrow(
        'Cannot transition from OPEN → CLOSED'
      );
    });
  });

  // ── InvestigatingState Tests ─────────────────────────────────────────────────
  describe('InvestigatingState', () => {
    it('should return INVESTIGATING status', () => {
      const state = new InvestigatingState();
      expect(state.getStatus()).toBe('INVESTIGATING');
    });

    it('should allow transition from INVESTIGATING to RESOLVED', async () => {
      const state = new InvestigatingState();
      const pgMock = pgPool.query as jest.Mock;
      pgMock.mockResolvedValue({});

      await expect(state.transitionTo('wi-002', 'RESOLVED')).resolves.not.toThrow();
      expect(pgMock).toHaveBeenCalled();
    });

    it('should reject transition from INVESTIGATING to OPEN', async () => {
      const state = new InvestigatingState();
      await expect(state.transitionTo('wi-002', 'OPEN')).rejects.toThrow(
        'Cannot transition from INVESTIGATING → OPEN'
      );
    });

    it('should reject transition from INVESTIGATING to CLOSED', async () => {
      const state = new InvestigatingState();
      await expect(state.transitionTo('wi-002', 'CLOSED')).rejects.toThrow(
        'Cannot transition from INVESTIGATING → CLOSED'
      );
    });
  });

  // ── ResolvedState Tests ──────────────────────────────────────────────────────
  describe('ResolvedState', () => {
    it('should return RESOLVED status', () => {
      const state = new ResolvedState();
      expect(state.getStatus()).toBe('RESOLVED');
    });

    it('should require RCA to transition to CLOSED', async () => {
      const state = new ResolvedState();
      await expect(state.transitionTo('wi-003', 'CLOSED', false)).rejects.toThrow(
        'Cannot CLOSE work item: RCA record is missing or incomplete'
      );
    });

    it('should allow transition to CLOSED with RCA present', async () => {
      const state = new ResolvedState();
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ start_time: '2024-01-01T00:00:00Z', incident_end: '2024-01-01T00:10:00Z' }],
        }) // SELECT
        .mockResolvedValueOnce(undefined) // UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const pgConnectMock = pgPool.connect as jest.Mock;
      pgConnectMock.mockResolvedValue(mockClient);

      await expect(state.transitionTo('wi-003', 'CLOSED', true)).resolves.not.toThrow();
      expect(mockClient.query).toHaveBeenCalled();
    });

    it('should calculate MTTR correctly', async () => {
      const state = new ResolvedState();
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };

      const startTime = new Date('2024-01-01T10:00:00Z');
      const endTime = new Date('2024-01-01T10:10:30Z');

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ start_time: startTime.toISOString(), incident_end: endTime.toISOString() }],
        }) // SELECT
        .mockResolvedValueOnce(undefined) // UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const pgConnectMock = pgPool.connect as jest.Mock;
      pgConnectMock.mockResolvedValue(mockClient);

      await state.transitionTo('wi-003', 'CLOSED', true);

      // Verify UPDATE was called with MTTR calculation
      const updateCall = mockClient.query.mock.calls.find((call: any) =>
        call[0].includes('UPDATE work_items')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1][0]).toBe(630); // 10.5 minutes = 630 seconds
    });

    it('should reject transition to OPEN', async () => {
      const state = new ResolvedState();
      await expect(state.transitionTo('wi-003', 'OPEN')).rejects.toThrow(
        'Cannot transition from RESOLVED → OPEN'
      );
    });

    it('should rollback transaction on error', async () => {
      const state = new ResolvedState();
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed')); // SELECT fails

      const pgConnectMock = pgPool.connect as jest.Mock;
      pgConnectMock.mockResolvedValue(mockClient);

      await expect(state.transitionTo('wi-003', 'CLOSED', true)).rejects.toThrow();
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  // ── ClosedState Tests ────────────────────────────────────────────────────────
  describe('ClosedState', () => {
    it('should return CLOSED status', () => {
      const state = new ClosedState();
      expect(state.getStatus()).toBe('CLOSED');
    });

    it('should reject all transitions from CLOSED', async () => {
      const state = new ClosedState();

      await expect(state.transitionTo('wi-004', 'OPEN')).rejects.toThrow(
        'Work item is CLOSED. No further transitions allowed'
      );
      await expect(state.transitionTo('wi-004', 'INVESTIGATING')).rejects.toThrow(
        'Work item is CLOSED. No further transitions allowed'
      );
      await expect(state.transitionTo('wi-004', 'RESOLVED')).rejects.toThrow(
        'Work item is CLOSED. No further transitions allowed'
      );
    });
  });

  // ── State Factory Tests ──────────────────────────────────────────────────────
  describe('getState factory', () => {
    it('should return OpenState for OPEN status', () => {
      const state = getState('OPEN');
      expect(state).toBeInstanceOf(OpenState);
      expect(state.getStatus()).toBe('OPEN');
    });

    it('should return InvestigatingState for INVESTIGATING status', () => {
      const state = getState('INVESTIGATING');
      expect(state).toBeInstanceOf(InvestigatingState);
      expect(state.getStatus()).toBe('INVESTIGATING');
    });

    it('should return ResolvedState for RESOLVED status', () => {
      const state = getState('RESOLVED');
      expect(state).toBeInstanceOf(ResolvedState);
      expect(state.getStatus()).toBe('RESOLVED');
    });

    it('should return ClosedState for CLOSED status', () => {
      const state = getState('CLOSED');
      expect(state).toBeInstanceOf(ClosedState);
      expect(state.getStatus()).toBe('CLOSED');
    });

    it('should throw for unknown status', () => {
      expect(() => getState('INVALID' as any)).toThrow('Unknown status: INVALID');
    });
  });

  // ── State Transition Chain Tests ─────────────────────────────────────────────
  describe('Complete state transition chain', () => {
    it('should follow correct path: OPEN → INVESTIGATING → RESOLVED → CLOSED', async () => {
      const pgMock = pgPool.query as jest.Mock;
      pgMock.mockResolvedValue({});

      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };

      mockClient.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [{ start_time: '2024-01-01T00:00:00Z', incident_end: '2024-01-01T00:05:00Z' }],
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const pgConnectMock = pgPool.connect as jest.Mock;
      pgConnectMock.mockResolvedValue(mockClient);

      const wi = 'wi-chain-001';

      // OPEN → INVESTIGATING
      const open = getState('OPEN');
      await open.transitionTo(wi, 'INVESTIGATING');

      // INVESTIGATING → RESOLVED
      const investigating = getState('INVESTIGATING');
      await investigating.transitionTo(wi, 'RESOLVED');

      // RESOLVED → CLOSED
      const resolved = getState('RESOLVED');
      await resolved.transitionTo(wi, 'CLOSED', true);

      // CLOSED (no further transitions)
      const closed = getState('CLOSED');
      await expect(closed.transitionTo(wi, 'OPEN')).rejects.toThrow();
    });
  });
});
