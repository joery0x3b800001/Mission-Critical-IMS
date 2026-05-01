import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signalQueue } from '../queue/signalQueue';
import { redis, Keys } from '../db/redis';

const SignalSchema = z.object({
  componentId: z.string().min(1),
  componentType: z.enum(['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST']),
  errorCode: z.string().min(1),
  message: z.string().min(1),
  latencyMs: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

export async function signalRoutes(app: FastifyInstance) {
  app.post('/signals', async (req, reply) => {
    const parsed = SignalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid signal payload', details: parsed.error.flatten() });
    }

    const signal = {
      ...parsed.data,
      timestamp: parsed.data.timestamp ?? new Date().toISOString(),
    };

    // Enqueue immediately — 202 Accepted, do not wait for processing
    await signalQueue.add('signal', signal, { priority: signal.componentType === 'RDBMS' || signal.componentType === 'MCP_HOST' ? 1 : 2 });

    // Increment throughput counter for metrics
    await redis.incr(Keys.throughput());

    return reply.status(202).send({ accepted: true, timestamp: signal.timestamp });
  });
}
