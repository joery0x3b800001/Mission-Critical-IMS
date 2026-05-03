export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://ims_user:ims_pass@localhost:5432/ims_db',
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://ims_user:ims_pass@localhost:27017/ims_signals?authSource=admin',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  
  // ─ Debounce & Queueing Configuration ──────────────────────────────────────
  debounceWindowMs: parseInt(process.env.DEBOUNCE_WINDOW_MS ?? '10000', 10),
  debounceThreshold: parseInt(process.env.DEBOUNCE_THRESHOLD ?? '100', 10),
  
  // ─ Rate Limiting Configuration ───────────────────────────────────────────
  // Global rate limit: 10,000 requests per 10 seconds
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '10000', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '10000', 10),
  // Per-IP rate limiting (additional to global rate limit)
  perIpRateLimitMax: parseInt(process.env.PER_IP_RATE_LIMIT_MAX ?? '1000', 10),
  perIpRateLimitWindowMs: parseInt(process.env.PER_IP_RATE_LIMIT_WINDOW_MS ?? '60000', 10),
  
  // ─ Worker & Queue Configuration ──────────────────────────────────────────
  metricsIntervalMs: parseInt(process.env.METRICS_INTERVAL_MS ?? '5000', 10),
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY ?? `${require('os').cpus().length * 2}`, 10),
  
  // BullMQ Queue Configuration
  queueRetryAttempts: parseInt(process.env.QUEUE_RETRY_ATTEMPTS ?? '3', 10),
  queueRetryDelayMs: parseInt(process.env.QUEUE_RETRY_DELAY_MS ?? '500', 10),
  queueJobRetentionSeconds: parseInt(process.env.QUEUE_JOB_RETENTION_SECONDS ?? '3600', 10),
  
  // ─ HTTP Server Configuration ─────────────────────────────────────────────
  bodyLimitBytes: parseInt(process.env.BODY_LIMIT_BYTES ?? '1048576', 10), // 1MB default
  batchSignalMaxSize: parseInt(process.env.BATCH_SIGNAL_MAX_SIZE ?? '100', 10), // Max signals per batch
  
  // ─ Signal Validation Configuration ──────────────────────────────────────
  maxSignalPayloadBytes: parseInt(process.env.MAX_SIGNAL_PAYLOAD_BYTES ?? '10000', 10),
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH ?? '1000', 10),
  maxErrorCodeLength: parseInt(process.env.MAX_ERROR_CODE_LENGTH ?? '100', 10),
  maxComponentIdLength: parseInt(process.env.MAX_COMPONENT_ID_LENGTH ?? '255', 10),
  maxLatencyMs: parseInt(process.env.MAX_LATENCY_MS ?? '60000', 10),
  
  // ─ Security Configuration ────────────────────────────────────────────────
  enableApiKeyAuth: process.env.ENABLE_API_KEY_AUTH === 'true',
  apiKey: process.env.API_KEY ?? 'dev-key-12345',
  
  // ─ Pagination & Caching Configuration ────────────────────────────────────
  defaultIncidentsLimit: parseInt(process.env.DEFAULT_INCIDENTS_LIMIT ?? '50', 10),
  maxIncidentsLimit: parseInt(process.env.MAX_INCIDENTS_LIMIT ?? '200', 10),
  defaultSignalsLimit: parseInt(process.env.DEFAULT_SIGNALS_LIMIT ?? '50', 10),
  maxSignalsLimit: parseInt(process.env.MAX_SIGNALS_LIMIT ?? '100', 10),
  
  // ─ RCA Configuration ────────────────────────────────────────────────────
  rcaMinTextLength: parseInt(process.env.RCA_MIN_TEXT_LENGTH ?? '10', 10),
  
  // ─ Cache TTL Configuration (seconds) ────────────────────────────────────
  incidentsListCacheTtl: parseInt(process.env.INCIDENTS_LIST_CACHE_TTL ?? '30', 10),
  incidentDetailCacheTtl: parseInt(process.env.INCIDENT_DETAIL_CACHE_TTL ?? '60', 10),
  
  // ─ Database Connection Pool Configuration ───────────────────────────────
  dbPoolMax: parseInt(process.env.DB_POOL_MAX ?? '50', 10),
  dbIdleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? '30000', 10),
  dbConnectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS ?? '5000', 10),
  dbStatementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '10000', 10),
};
