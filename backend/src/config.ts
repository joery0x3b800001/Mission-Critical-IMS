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
};
