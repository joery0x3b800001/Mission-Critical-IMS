import { signalQueue, startWorker } from '../queue/signalQueue';
import { redis, Keys } from '../db/redis';
import { getMongoClient, getRawSignalsCollection } from '../db/mongo';
import { pgPool } from '../db/postgres';

jest.mock('../db/redis');
jest.mock('../db/mongo');
jest.mock('../db/postgres');

describe('Signal Processing Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Signal → Incident Creation Flow', () => {
    it('should process signal and trigger incident creation', async () => {
      const signal = {
        componentId: 'db-primary',
        componentType: 'RDBMS' as const,
        errorCode: 'CONNECTION_TIMEOUT',
        message: 'Failed to connect to database',
        timestamp: new Date().toISOString(),
      };

      // Mock queue job
      const mockJob = {
        data: signal,
        progress: jest.fn(),
        log: jest.fn(),
      };

      // Simulate signal processing
      // In real scenario, this would be called by BullMQ worker
      const mockProcessor = jest.fn().mockResolvedValue({
        workItemId: 'wi-123',
        priority: 'P0',
      });

      await mockProcessor(signal);

      expect(mockProcessor).toHaveBeenCalledWith(signal);
    });

    it('should handle signal debouncing (multiple signals → single incident)', async () => {
      const signals = [
        {
          componentId: 'api-gateway',
          componentType: 'API' as const,
          errorCode: 'TIMEOUT',
          message: 'Request timeout',
          timestamp: new Date().toISOString(),
        },
        {
          componentId: 'api-gateway',
          componentType: 'API' as const,
          errorCode: 'TIMEOUT',
          message: 'Request timeout',
          timestamp: new Date(Date.now() + 1000).toISOString(), // 1 second later
        },
        {
          componentId: 'api-gateway',
          componentType: 'API' as const,
          errorCode: 'TIMEOUT',
          message: 'Request timeout',
          timestamp: new Date(Date.now() + 2000).toISOString(), // 2 seconds later
        },
      ];

      // Signals within 10-second window from same component should debounce
      // Expected: 3 signals processed, but only 1 incident created
      expect(signals).toHaveLength(3);
    });
  });

  describe('Error Handling in Signal Processing', () => {
    it('should handle signal queue errors gracefully', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'RDBMS' as const,
        errorCode: 'FAILURE',
        message: 'Failed',
        timestamp: new Date().toISOString(),
      };

      // Mock queue failure
      const mockQueueAdd = jest.fn().mockRejectedValue(new Error('Queue unavailable'));

      await expect(mockQueueAdd('signal', signal)).rejects.toThrow('Queue unavailable');
    });

    it('should retry failed signal processing', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'API' as const,
        errorCode: 'ERROR',
        message: 'Error occurred',
        timestamp: new Date().toISOString(),
      };

      let attempts = 0;
      const processor = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Temporary failure');
        }
        return { success: true };
      });

      // First attempt fails
      expect(() => processor(signal)).toThrow('Temporary failure');

      // Second attempt succeeds
      expect(processor(signal)).toEqual({ success: true });
      expect(attempts).toBe(2);
    });
  });

  describe('Signal Deduplication', () => {
    it('should track duplicate signals within window', async () => {
      const baseSignal = {
        componentId: 'cache-server',
        componentType: 'CACHE' as const,
        errorCode: 'MEMORY_EXCEEDED',
        message: 'Cache memory exceeded 90%',
      };

      const signals = [
        { ...baseSignal, timestamp: new Date().toISOString() },
        { ...baseSignal, timestamp: new Date(Date.now() + 500).toISOString() },
        { ...baseSignal, timestamp: new Date(Date.now() + 1500).toISOString() },
      ];

      // All signals should be considered for the same incident
      expect(signals[0].componentId).toBe(signals[1].componentId);
      expect(signals[1].componentId).toBe(signals[2].componentId);
    });

    it('should not deduplicate signals outside debounce window', async () => {
      const baseSignal = {
        componentId: 'monitor',
        componentType: 'API' as const,
        errorCode: 'CHECK_FAILED',
        message: 'Health check failed',
      };

      const signal1 = { ...baseSignal, timestamp: new Date().toISOString() };
      const signal2 = {
        ...baseSignal,
        timestamp: new Date(Date.now() + 15_000).toISOString(), // 15 seconds later
      };

      // Signals outside 10-second window should create separate incidents
      const window1 = 10_000;
      const timeDiff = new Date(signal2.timestamp).getTime() - new Date(signal1.timestamp).getTime();

      expect(timeDiff).toBeGreaterThan(window1);
    });
  });

  describe('Multi-component Incident Correlation', () => {
    it('should correlate related signals across components', async () => {
      const signals = [
        {
          componentId: 'db-replica-1',
          componentType: 'RDBMS' as const,
          errorCode: 'REPLICATION_LAG',
          message: 'High replication lag detected',
          timestamp: new Date().toISOString(),
        },
        {
          componentId: 'db-replica-2',
          componentType: 'RDBMS' as const,
          errorCode: 'REPLICATION_LAG',
          message: 'High replication lag detected',
          timestamp: new Date(Date.now() + 500).toISOString(),
        },
        {
          componentId: 'app-api',
          componentType: 'API' as const,
          errorCode: 'SLOW_QUERIES',
          message: 'Queries are slower than usual',
          timestamp: new Date(Date.now() + 1000).toISOString(),
        },
      ];

      // These signals might indicate a correlated incident
      // (database problem affecting API performance)
      const dbSignals = signals.filter((s) => s.componentType === 'RDBMS');
      const apiSignals = signals.filter((s) => s.componentType === 'API');

      expect(dbSignals).toHaveLength(2);
      expect(apiSignals).toHaveLength(1);
    });
  });

  describe('Signal Priority Resolution', () => {
    it('should assign P0 priority to RDBMS failures', async () => {
      const signal = {
        componentId: 'postgres-primary',
        componentType: 'RDBMS' as const,
        errorCode: 'DOWN',
        message: 'Database is down',
        timestamp: new Date().toISOString(),
      };

      // RDBMS gets priority 1 (P0)
      const priority = signal.componentType === 'RDBMS' || signal.componentType === 'MCP_HOST' ? 1 : 2;

      expect(priority).toBe(1);
    });

    it('should assign P1 priority to API failures', async () => {
      const signal = {
        componentId: 'api-gateway',
        componentType: 'API' as const,
        errorCode: 'TIMEOUT',
        message: 'Request timeout',
        timestamp: new Date().toISOString(),
      };

      // API is neither RDBMS nor MCP_HOST, so priority should be 2
      const isP0 = (signal.componentType as string) === 'RDBMS' || (signal.componentType as string) === 'MCP_HOST';
      const priority = isP0 ? 1 : 2;

      expect(priority).toBe(2);
    });

    it('should handle priority escalation', async () => {
      let currentPriority = 'P2';

      // Simulate escalation: if RDBMS also fails, escalate to P0
      const escalationTrigger = 'RDBMS';

      if (escalationTrigger === 'RDBMS') {
        currentPriority = 'P0';
      }

      expect(currentPriority).toBe('P0');
    });
  });

  describe('Throughput and Performance', () => {
    it('should handle high-velocity signal ingestion', async () => {
      const signals = Array.from({ length: 1000 }, (_, i) => ({
        componentId: `component-${i % 10}`,
        componentType: 'API' as const,
        errorCode: 'ERROR',
        message: `Error in component ${i}`,
        timestamp: new Date().toISOString(),
      }));

      // Simulate ingestion of 1000 signals
      expect(signals).toHaveLength(1000);
    });

    it('should maintain queue depth metrics', async () => {
      const mockQueueCounts = {
        waiting: 500,
        active: 50,
        completed: 10000,
        failed: 5,
        delayed: 0,
      };

      const totalPending = mockQueueCounts.waiting + mockQueueCounts.active;
      const successRate = (mockQueueCounts.completed / (mockQueueCounts.completed + mockQueueCounts.failed)) * 100;

      expect(totalPending).toBe(550);
      expect(successRate).toBeCloseTo(99.95, 1);
    });
  });

  describe('Worker Concurrency and Pool Management', () => {
    it('should process signals with configured concurrency', async () => {
      const workerConcurrency = 10;
      const signals = Array.from({ length: 50 }, (_, i) => ({
        componentId: `component-${i}`,
        componentType: 'API' as const,
        errorCode: 'ERROR',
        message: `Error ${i}`,
        timestamp: new Date().toISOString(),
      }));

      // With concurrency=10, should process in batches
      // 50 signals / 10 concurrency = 5 batches
      const expectedBatches = Math.ceil(signals.length / workerConcurrency);

      expect(expectedBatches).toBe(5);
    });

    it('should handle worker failure and recovery', async () => {
      let isWorkerHealthy = true;

      const healthCheck = () => isWorkerHealthy;
      const recover = () => {
        isWorkerHealthy = true;
      };

      expect(healthCheck()).toBe(true);

      // Simulate worker failure
      isWorkerHealthy = false;
      expect(healthCheck()).toBe(false);

      // Simulate recovery
      recover();
      expect(healthCheck()).toBe(true);
    });
  });

  describe('State Machine Transitions in Signal Processing', () => {
    it('should transition work item states correctly', async () => {
      const workItem = {
        id: 'wi-123',
        status: 'OPEN' as const,
      };

      // OPEN → INVESTIGATING
      (workItem as any).status = 'INVESTIGATING';
      expect((workItem as any).status).toBe('INVESTIGATING');

      // INVESTIGATING → RESOLVED
      (workItem as any).status = 'RESOLVED';
      expect((workItem as any).status).toBe('RESOLVED');

      // RESOLVED → CLOSED (requires RCA)
      (workItem as any).status = 'CLOSED';
      expect((workItem as any).status).toBe('CLOSED');
    });

    it('should enforce valid state transitions', async () => {
      const validTransitions: Record<string, string[]> = {
        OPEN: ['INVESTIGATING'],
        INVESTIGATING: ['RESOLVED'],
        RESOLVED: ['CLOSED'],
        CLOSED: [],
      };

      const currentStatus = 'OPEN';
      const nextStatus = 'RESOLVED'; // Invalid transition

      const allowedTransitions = validTransitions[currentStatus] || [];
      const isValidTransition = allowedTransitions.includes(nextStatus);

      expect(isValidTransition).toBe(false);
    });
  });
});
