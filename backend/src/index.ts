import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config';
import { redis, Keys } from './db/redis';
import { signalRoutes } from './routes/signals';
import { incidentRoutes } from './routes/incidents';
import { healthRoutes } from './routes/health';
import { startWorker, signalQueue } from './queue/signalQueue';
import { registerClient } from './ws/broadcaster';

async function main() {
  const app = Fastify({ logger: { level: 'warn' } });

  // ── Plugins ─────────────────────────────────────────────────────────────────
  await app.register(cors, { origin: '*' });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    errorResponseBuilder: () => ({ error: 'Rate limit exceeded. Slow down signal ingestion.' }),
  });
  await app.register(websocket);

  // ── WebSocket endpoint ───────────────────────────────────────────────────────
  app.get('/ws', { websocket: true }, (socket) => {
    registerClient(socket);
    socket.send(JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() }));
  });

  // ── Routes ───────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(signalRoutes);
  await app.register(incidentRoutes);

  // ── Throughput metrics (every 5 seconds) ─────────────────────────────────────
  let processedCount = 0;
  setInterval(async () => {
    const raw = await redis.getdel(Keys.throughput()).catch(() => '0');
    const ingest = parseInt(raw ?? '0', 10);
    const counts = await signalQueue.getJobCounts('waiting', 'active').catch(() => ({ waiting: 0, active: 0 }));
    console.log(
      `[Metrics] Signals ingested: ${ingest}/5s | Processed: ${processedCount}/5s | Queue: ${counts.waiting + counts.active} waiting`
    );
    processedCount = 0;
  }, config.metricsIntervalMs);

  // ── Start worker ─────────────────────────────────────────────────────────────
  startWorker(() => { processedCount++; });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`\n🚀 IMS Backend running on http://0.0.0.0:${config.port}`);
  console.log(`   Health: http://localhost:${config.port}/health`);
  console.log(`   WebSocket: ws://localhost:${config.port}/ws\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
