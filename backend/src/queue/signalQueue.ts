import { Queue, Worker, Job } from 'bullmq';
import { config } from '../config';
import { processSignal } from './signalProcessor';
import { Signal } from '../types';

// ── Helper: Parse Redis URL to connection config ─────────────────────────────
const parseRedisUrl = (url: string): { host: string; port: number } => {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'redis', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'redis', port: 6379 };
  }
};

const connection = parseRedisUrl(config.redisUrl);

export const signalQueue = new Queue<Signal>('signals', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    // Remove jobs after they're completed or failed to prevent memory accumulation
    // Uses time-based cleanup (1 hour) instead of count to prevent unbounded memory growth
    removeOnComplete: { age: 3600 }, // Remove completed jobs after 1 hour
    removeOnFail: { age: 3600 },     // Remove failed jobs after 1 hour
  },
});

let worker: Worker<Signal>;

export function startWorker(onProcessed: () => void): void {
  worker = new Worker<Signal>(
    'signals',
    async (job: Job<Signal>) => {
      await processSignal(job.data);
      onProcessed();
    },
    { connection, concurrency: config.workerConcurrency }
  );

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  console.log(`[Worker] Started with concurrency=${config.workerConcurrency}`);
}

export async function getQueueDepth(): Promise<number> {
  const counts = await signalQueue.getJobCounts('waiting', 'active', 'delayed');
  return counts.waiting + counts.active + counts.delayed;
}

export async function closeQueue(): Promise<void> {
  await signalQueue.close();
  if (worker) await worker.close();
  console.log('[Queue] Closed');
}
