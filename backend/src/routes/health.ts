import { FastifyInstance } from 'fastify';
import { pgPool } from '../db/postgres';
import { getMongoClient } from '../db/mongo';
import { redis } from '../db/redis';
import { getQueueDepth } from '../queue/signalQueue';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const [pgOk, mongoOk, redisOk, queueDepth] = await Promise.all([
      pgPool.query('SELECT 1').then(() => true).catch(() => false),
      getMongoClient().then(() => true).catch(() => false),
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
