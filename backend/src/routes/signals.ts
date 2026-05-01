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

  // ── Signal Ingestion Endpoint ────────────────────────────────────────────────
  app.post<{ Body: Signal }>(
    '/signals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['componentId', 'componentType', 'errorCode', 'message'],
          properties: {
            componentId: { type: 'string' },
            componentType: { type: 'string', enum: ['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST'] },
            errorCode: { type: 'string' },
            message: { type: 'string' },
            latencyMs: { type: 'number' },
            metadata: { type: 'object' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              accepted: { type: 'boolean' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // ── Validate Signal Schema ───────────────────────────────────────────────
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
        // ── Enqueue Signal with Priority ─────────────────────────────────────────
        // RDBMS and MCP_HOST failures are P0 (priority 1 = highest)
        const priority = signal.componentType === 'RDBMS' || signal.componentType === 'MCP_HOST' ? 1 : 2;
        await signalQueue.add('signal', signal, { priority });

        // ── Increment Throughput Metric ──────────────────────────────────────────
        await redis.incr(Keys.throughput());

        // ── Log Signal Ingestion ─────────────────────────────────────────────────
        app.log.info(
          {
            componentId: signal.componentId,
            componentType: signal.componentType,
            errorCode: signal.errorCode,
            priority,
            ip: req.ip,
          },
          'Signal ingested successfully'
        );

        return reply.status(202).send({
          accepted: true,
          timestamp: signal.timestamp,
        });
      } catch (error) {
        app.log.error(
          {
            error,
            signal,
            ip: req.ip,
          },
          'Failed to queue signal'
        );
        return reply.status(503).send({
          error: 'Service temporarily unavailable',
          message: 'Failed to process signal. Please retry.',
        });
      }
    }
  );
}
