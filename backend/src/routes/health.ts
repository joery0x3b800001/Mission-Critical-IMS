import { FastifyInstance } from 'fastify';
import { pgPool } from '../db/postgres';
import { getMongoClient } from '../db/mongo';
import { redis } from '../db/redis';
import { getQueueDepth } from '../queue/signalQueue';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    // Use faster health checks: SELECT 1 for connectivity, PING for Redis
    // For MongoDB, attempt connection but cache result to avoid repeated connections
    const [pgOk, mongoOk, redisOk, queueDepth] = await Promise.all([
      pgPool.query('SELECT 1').then(() => true).catch(() => false),
      // Check if MongoDB client was previously initialized (avoid expensive connection in health check)
      getMongoClient()
        .then(() => true)
        .catch(() => false),
      redis.ping().then(() => true).catch(() => false),
      getQueueDepth().catch(() => -1),
    ]);

    const status = pgOk && mongoOk && redisOk ? 'ok' : 'degraded';
    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      postgres: pgOk,
      mongo: mongoOk,
      redis: redisOk,
      queueDepth,
      uptime: Math.floor(process.uptime()),
    });
  });
}
