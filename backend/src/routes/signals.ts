import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signalQueue } from '../queue/signalQueue';
import { redis, Keys } from '../db/redis';
import { config } from '../config';

// ── Schema with enhanced validation ──────────────────────────────────────────
const SignalSchema = z.object({
  componentId: z
    .string()
    .min(1, 'componentId must be at least 1 character')
    .max(config.maxComponentIdLength, `componentId must be at most ${config.maxComponentIdLength} characters`)
    .regex(/^[a-zA-Z0-9_\-\.]*$/, 'componentId can only contain alphanumeric characters, hyphens, underscores, and dots'),
  componentType: z.enum(['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST']),
  errorCode: z
    .string()
    .min(1, 'errorCode must be at least 1 character')
    .max(config.maxErrorCodeLength, `errorCode must be at most ${config.maxErrorCodeLength} characters`)
    .regex(/^[A-Z0-9_]*$/, 'errorCode must be uppercase alphanumeric or underscore'),
  message: z
    .string()
    .min(1, 'message must be at least 1 character')
    .max(config.maxMessageLength, `message must be at most ${config.maxMessageLength} characters`)
    .trim(),
  latencyMs: z
    .number()
    .int()
    .min(0, 'latencyMs must be non-negative')
    .max(60_000, 'latencyMs must be at most 60000ms')
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z
    .string()
    .datetime()
    .optional(),
});

// ── Batch schema — up to 100 signals per request ──────────────────────────────
const BatchSignalSchema = z.object({
  signals: z.array(SignalSchema).min(1).max(100),
});

type Signal = z.infer<typeof SignalSchema>;

export async function signalRoutes(app: FastifyInstance) {
  // ── Optional API Key Authentication Hook ─────────────────────────────────────
  if (config.enableApiKeyAuth) {
    app.addHook('preHandler', async (request, reply) => {
      if (request.url.startsWith('/signals')) {
        const apiKey = request.headers['x-api-key'];
        if (!apiKey || apiKey !== config.apiKey) {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Missing or invalid X-API-Key header',
          });
        }
      }
    });
  }

  // ── Single Signal Ingestion ────────────────────────────────────────────────
  app.post<{ Body: Signal }>(
    '/signals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['componentId', 'componentType', 'errorCode', 'message'],
          properties: {
            componentId:   { type: 'string' },
            componentType: { type: 'string', enum: ['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST'] },
            errorCode:     { type: 'string' },
            message:       { type: 'string' },
            latencyMs:     { type: 'number' },
            metadata:      { type: 'object' },
            timestamp:     { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = SignalSchema.safeParse(req.body);
      if (!parsed.success) {
        app.log.warn(
          { errors: parsed.error.flatten(), ip: req.ip, body: req.body },
          'Signal validation failed'
        );
        return reply.status(400).send({
          error: 'Invalid signal payload',
          details: parsed.error.flatten(),
        });
      }

      const signal = {
        ...parsed.data,
        timestamp: parsed.data.timestamp ?? new Date().toISOString(),
      };

      try {
        const priority = signal.componentType === 'RDBMS' || signal.componentType === 'MCP_HOST' ? 1 : 2;
        await signalQueue.add('signal', signal, { priority });
        await redis.incr(Keys.throughput());

        return reply.status(202).send({
          accepted:  true,
          timestamp: signal.timestamp,
        });
      } catch (error) {
        app.log.error({ error, signal }, 'Failed to queue signal');
        return reply.status(503).send({
          error:   'Service temporarily unavailable',
          message: 'Failed to process signal. Please retry.',
        });
      }
    }
  );

  // ── Batch Signal Ingestion — 100 signals per HTTP round-trip ─────────────
  // This is the high-throughput path used by the burst test and any producer
  // that batches signals client-side. Reduces TCP overhead by up to 100x.
  app.post(
    '/signals/batch',
    {
      // Override body limit for batch: 100 signals × ~500 bytes each = ~50 KB
      config: { rawBody: false },
    },
    async (req, reply) => {
      const parsed = BatchSignalSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error:   'Invalid batch payload',
          details: parsed.error.flatten(),
        });
      }

      const now  = new Date().toISOString();
      const jobs = parsed.data.signals.map((s) => ({
        name: 'signal',
        data: { ...s, timestamp: s.timestamp ?? now },
        opts: {
          priority: s.componentType === 'RDBMS' || s.componentType === 'MCP_HOST' ? 1 : 2,
        },
      }));

      try {
        await signalQueue.addBulk(jobs);
        await redis.incrby(Keys.throughput(), jobs.length);

        return reply.status(202).send({
          accepted: true,
          count:    jobs.length,
        });
      } catch (error) {
        app.log.error({ error, count: jobs.length }, 'Failed to queue batch');
        return reply.status(503).send({
          error:   'Service temporarily unavailable',
          message: 'Failed to process batch. Please retry.',
        });
      }
    }
  );
}
