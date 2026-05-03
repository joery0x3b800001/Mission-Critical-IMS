import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

// Keys with namespacing for better cache organization
export const Keys = {
  debounce: (componentId: string) => `debounce:${componentId}`,
  workItemId: (componentId: string) => `witem:${componentId}`,
  dashboard: () => 'dashboard:incidents',
  throughput: () => 'metrics:throughput',
  // New cache keys for paginated queries
  incidents: (offset: number, limit: number) => `incidents:${offset}:${limit}`,
  incident: (id: string, signalOffset: number, signalLimit: number) => `incident:${id}:${signalOffset}:${signalLimit}`,
};
