import { getState } from '../patterns/workItemState';

// Mock pg pool
jest.mock('../db/postgres', () => ({
  pgPool: { query: jest.fn() },
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

describe('WorkItem State Machine', () => {
  test('OPEN → INVESTIGATING is valid', async () => {
    const { pgPool } = require('../db/postgres');
    pgPool.query.mockResolvedValue({});
    const state = getState('OPEN');
    await expect(state.transitionTo('some-id', 'INVESTIGATING')).resolves.not.toThrow();
  });

  test('OPEN → CLOSED is invalid', async () => {
    const state = getState('OPEN');
    await expect(state.transitionTo('some-id', 'CLOSED')).rejects.toThrow(
      'Cannot transition from OPEN → CLOSED'
    );
  });

  test('RESOLVED → CLOSED without RCA throws', async () => {
    const state = getState('RESOLVED');
    await expect(state.transitionTo('some-id', 'CLOSED', false)).rejects.toThrow(
      'RCA record is missing or incomplete'
    );
  });

  test('CLOSED → any throws', async () => {
    const state = getState('CLOSED');
    await expect(state.transitionTo('some-id', 'OPEN')).rejects.toThrow(
      'Work item is CLOSED'
    );
  });

  test('INVESTIGATING → RESOLVED is valid', async () => {
    const { pgPool } = require('../db/postgres');
    pgPool.query.mockResolvedValue({});
    const state = getState('INVESTIGATING');
    await expect(state.transitionTo('some-id', 'RESOLVED')).resolves.not.toThrow();
  });
});

describe('RCA Validation', () => {
  test('fixApplied must be present to close', async () => {
    const state = getState('RESOLVED');
    await expect(state.transitionTo('some-id', 'CLOSED', false)).rejects.toThrow();
  });

  test('With valid RCA, RESOLVED → CLOSED proceeds to DB', async () => {
    const { pgPool } = require('../db/postgres');
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ start_time: new Date(Date.now() - 3600_000), incident_end: new Date() }] }),
      release: jest.fn(),
    };
    pgPool.connect = jest.fn().mockResolvedValue(mockClient);
    const state = getState('RESOLVED');
    // Should not throw (rcaExists = true)
    await expect(state.transitionTo('some-id', 'CLOSED', true)).resolves.not.toThrow();
  });
});
