export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ims_user:ims_pass@localhost:5432/ims_db',
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://ims_user:ims_pass@localhost:27017/ims_signals?authSource=admin',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  debounceWindowMs: 10_000,   // 10 seconds
  debounceThreshold: 100,
  rateLimitMax: 10_000,
  rateLimitWindowMs: 10_000,
  metricsIntervalMs: 5_000,
  workerConcurrency: 10,
  // ─ Security Configuration ────────────────────────────────────────────────────
  // API Key validation (optional, for demo)
  enableApiKeyAuth: process.env.ENABLE_API_KEY_AUTH === 'true',
  apiKey: process.env.API_KEY ?? 'dev-key-12345',
  // Maximum payload size for signals
  maxSignalPayloadBytes: 10_000, // 10KB max per signal
  // Maximum message length
  maxMessageLength: 1000,
  maxErrorCodeLength: 100,
  maxComponentIdLength: 255,
  // Per-IP rate limiting (additional to global rate limit)
  perIpRateLimitMax: 1000,
  perIpRateLimitWindowMs: 60_000, // 1 minute
};
