import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config';
import { redis, Keys } from './db/redis';
import { signalRoutes } from './routes/signals';
import { incidentRoutes } from './routes/incidents';
import { healthRoutes } from './routes/health';
import { startWorker, signalQueue, closeQueue } from './queue/signalQueue';
import { registerClient, closeAllConnections } from './ws/broadcaster';
import { closeMongo } from './db/mongo';
import { closePostgresPool } from './db/postgres';

async function main() {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: config.bodyLimitBytes }); // Configurable via BODY_LIMIT_BYTES env

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
    registerClient(socket.socket);
    socket.socket.send(JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() }));
  });

  // ── Routes ───────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(signalRoutes);
  await app.register(incidentRoutes);

  // ── Throughput metrics (every 5 seconds) ─────────────────────────────────────
  let processedCount = 0;
  const metricsInterval = setInterval(async () => {
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

  // ── Graceful Shutdown Handler ────────────────────────────────────────────────
  async function gracefulShutdown(signal: string) {
    console.log(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);

    try {
      // 1. Stop accepting new requests
      console.log('[Shutdown] Stopping HTTP server...');
      await app.close();

      // 2. Stop metrics collection
      clearInterval(metricsInterval);

      // 3. Close all WebSocket connections
      console.log('[Shutdown] Closing WebSocket connections...');
      await closeAllConnections();

      // 4. Drain queue gracefully
      console.log('[Shutdown] Draining queue...');
      await closeQueue();

      // 5. Close databases
      console.log('[Shutdown] Closing database connections...');
      await Promise.all([
        closeMongo(),
        closePostgresPool(),
        redis.quit(),
      ]);

      console.log('[Shutdown] ✅ Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[Shutdown] Error during shutdown:', (err as Error).message);
      process.exit(1);
    }
  }

  // Listen for shutdown signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Prevent uncaught exceptions from crashing without cleanup
  process.on('uncaughtException', (err) => {
    console.error('[Fatal] Uncaught exception:', err);
    gracefulShutdown('uncaughtException').catch(console.error);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] Unhandled rejection:', reason);
    gracefulShutdown('unhandledRejection').catch(console.error);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
