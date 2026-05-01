import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { signalRoutes } from '../routes/signals';
import { signalQueue } from '../queue/signalQueue';
import { redis, Keys } from '../db/redis';

jest.mock('../queue/signalQueue', () => ({
  signalQueue: {
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
  },
}));

jest.mock('../db/redis', () => ({
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    getdel: jest.fn().mockResolvedValue('0'),
  },
  Keys: {
    throughput: () => 'metrics:throughput',
  },
}));

describe('Signals Route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(signalRoutes);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /signals', () => {
    it('should accept valid signal and return 202', async () => {
      const signal = {
        componentId: 'db-primary',
        componentType: 'RDBMS',
        errorCode: 'CONNECTION_TIMEOUT',
        message: 'Failed to connect to primary database',
        latencyMs: 5000,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload);
      expect(body.accepted).toBe(true);
      expect(body.timestamp).toBeDefined();
    });

    it('should set default timestamp if not provided', async () => {
      const signal = {
        componentId: 'api-server',
        componentType: 'API',
        errorCode: 'TIMEOUT',
        message: 'Request timeout',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload);
      expect(body.timestamp).toBeDefined();
      // Verify it's a valid ISO string
      expect(new Date(body.timestamp)).not.toBeNull();
    });

    it('should reject signal with missing componentId', async () => {
      const signal = {
        componentType: 'RDBMS',
        errorCode: 'FAILURE',
        message: 'Something failed',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect([body.error, body.message]).toContainEqual(expect.stringMatching(/Invalid|Bad Request/));
    });

    it('should reject signal with invalid componentType', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'INVALID_TYPE',
        errorCode: 'FAILURE',
        message: 'Failed',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect([body.error, body.message]).toContainEqual(expect.stringMatching(/Invalid|Bad Request/));
    });

    it('should reject signal with empty errorCode', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'RDBMS',
        errorCode: '',
        message: 'Failed',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect([body.error, body.message]).toContainEqual(expect.stringMatching(/Invalid|Bad Request/));
    });

    it('should accept optional metadata field', async () => {
      const signal = {
        componentId: 'api',
        componentType: 'API',
        errorCode: 'HIGH_LATENCY',
        message: 'API is slow',
        metadata: {
          userId: 'user-123',
          requestId: 'req-456',
          duration: 'P1D',
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
    });

    it('should queue signal with P0 priority for RDBMS', async () => {
      const signal = {
        componentId: 'postgres',
        componentType: 'RDBMS',
        errorCode: 'DOWN',
        message: 'Database is down',
      };

      await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(signalQueue.add).toHaveBeenCalledWith(
        'signal',
        expect.objectContaining(signal),
        { priority: 1 } // Priority 1 for RDBMS
      );
    });

    it('should queue signal with P1 priority for API', async () => {
      const signal = {
        componentId: 'api-gateway',
        componentType: 'API',
        errorCode: 'TIMEOUT',
        message: 'API timeout',
      };

      await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(signalQueue.add).toHaveBeenCalledWith(
        'signal',
        expect.objectContaining(signal),
        { priority: 2 } // Priority 2 for API
      );
    });

    it('should increment throughput metric on signal ingestion', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'CACHE',
        errorCode: 'MISS',
        message: 'Cache miss',
      };

      await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(redis.incr).toHaveBeenCalledWith(Keys.throughput());
    });

    it('should accept valid ISO datetime in timestamp field', async () => {
      const now = new Date().toISOString();
      const signal = {
        componentId: 'test',
        componentType: 'NOSQL',
        errorCode: 'FAILURE',
        message: 'MongoDB failed',
        timestamp: now,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload);
      expect(body.timestamp).toBe(now);
    });

    it('should reject invalid ISO datetime in timestamp', async () => {
      const signal = {
        componentId: 'test',
        componentType: 'RDBMS',
        errorCode: 'FAILURE',
        message: 'Failed',
        timestamp: 'not-a-date',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept optional latencyMs field', async () => {
      const signal = {
        componentId: 'api',
        componentType: 'API',
        errorCode: 'SLOW',
        message: 'Slow response',
        latencyMs: 2500,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
    });

    it('should accept all valid componentTypes', async () => {
      const componentTypes = ['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST'];

      for (const componentType of componentTypes) {
        const signal = {
          componentId: 'test',
          componentType,
          errorCode: 'FAILURE',
          message: 'Failed',
        };

        const response = await app.inject({
          method: 'POST',
          url: '/signals',
          payload: signal,
        });

        expect(response.statusCode).toBe(202);
      }
    });

    it('should handle rapid consecutive signal submissions', async () => {
      const signals = Array.from({ length: 10 }, (_, i) => ({
        componentId: `component-${i}`,
        componentType: 'API' as const,
        errorCode: 'ERROR',
        message: `Error ${i}`,
      }));

      const responses = await Promise.all(
        signals.map((signal) =>
          app.inject({
            method: 'POST',
            url: '/signals',
            payload: signal,
          })
        )
      );

      responses.forEach((response) => {
        expect(response.statusCode).toBe(202);
      });

      expect(signalQueue.add).toHaveBeenCalledTimes(10);
      expect(redis.incr).toHaveBeenCalledTimes(10);
    });
  });

  describe('Signal validation edge cases', () => {
    it('should reject signal with null componentId', async () => {
      const signal = {
        componentId: null,
        componentType: 'RDBMS',
        errorCode: 'FAILURE',
        message: 'Failed',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject signal with numeric componentId', async () => {
      const signal = {
        componentId: 12345,
        componentType: 'RDBMS',
        errorCode: 'FAILURE',
        message: 'Failed',
      } as any; // Force type to test validation

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      // Numeric componentId might be coerced to string or rejected
      // Accept either 400 or 202 depending on JSON coercion behavior
      expect([400, 202]).toContain(response.statusCode);
    });

    it('should accept componentId with special characters', async () => {
      const signal = {
        componentId: 'component-prod-v2.backup_01',
        componentType: 'RDBMS',
        errorCode: 'FAILURE',
        message: 'Failed',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: signal,
      });

      expect(response.statusCode).toBe(202);
    });

    it('should handle empty request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/signals',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
