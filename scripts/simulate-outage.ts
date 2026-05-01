#!/usr/bin/env node
/**
 * simulate-outage.ts
 * Simulates an RDBMS outage followed by MCP_HOST cascade failure.
 * Run: npx ts-node scripts/simulate-outage.ts
 */

const BASE_URL = process.env.API_URL ?? 'http://localhost:3001';

interface Signal {
  componentId: string;
  componentType: string;
  errorCode: string;
  message: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

async function sendSignal(signal: Signal): Promise<void> {
  const res = await fetch(`${BASE_URL}/signals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...signal, timestamp: new Date().toISOString() }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error('Failed to send signal:', err);
  }
}

async function burst(signal: Signal, count: number, delayMs = 50): Promise<void> {
  console.log(`  Sending ${count} signals for ${signal.componentId}...`);
  for (let i = 0; i < count; i++) {
    await sendSignal({ ...signal, latencyMs: Math.floor(Math.random() * 5000) + 1000 });
    await sleep(delayMs);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🔴 === OUTAGE SIMULATION START ===\n');

  // Phase 1: RDBMS primary goes down (P0)
  console.log('Phase 1: RDBMS Primary failure...');
  await burst({
    componentId: 'POSTGRES_PRIMARY_01',
    componentType: 'RDBMS',
    errorCode: 'CONN_REFUSED',
    message: 'Connection to primary PostgreSQL refused — host unreachable',
    metadata: { host: 'pg-primary-01.internal', port: 5432 },
  }, 120, 30);

  await sleep(2000);

  // Phase 2: Read replica overloaded
  console.log('\nPhase 2: Read replica overload cascade...');
  await burst({
    componentId: 'POSTGRES_REPLICA_01',
    componentType: 'RDBMS',
    errorCode: 'MAX_CONN_EXCEEDED',
    message: 'Read replica max connections exceeded — all pools exhausted',
    metadata: { maxConnections: 100, currentConnections: 100 },
  }, 80, 40);

  await sleep(1000);

  // Phase 3: MCP Host failure due to DB dependency
  console.log('\nPhase 3: MCP Host failing due to DB dependency...');
  await burst({
    componentId: 'MCP_HOST_GATEWAY_01',
    componentType: 'MCP_HOST',
    errorCode: 'DEPENDENCY_TIMEOUT',
    message: 'MCP Host unable to reach database — request pipeline stalled',
    metadata: { dependency: 'POSTGRES_PRIMARY_01', timeoutMs: 30000 },
  }, 150, 25);

  await sleep(1000);

  // Phase 4: Cache miss storm (Redis overwhelmed)
  console.log('\nPhase 4: Cache miss storm...');
  await burst({
    componentId: 'CACHE_CLUSTER_01',
    componentType: 'CACHE',
    errorCode: 'CACHE_MISS_STORM',
    message: 'Cache cluster overwhelmed by miss storm due to DB fallback',
    latencyMs: 8500,
    metadata: { missRate: '94%', evictionRate: 'high' },
  }, 200, 15);

  await sleep(1000);

  // Phase 5: Queue backup
  console.log('\nPhase 5: Async queue backlog growing...');
  await burst({
    componentId: 'QUEUE_WORKER_POOL_01',
    componentType: 'QUEUE',
    errorCode: 'QUEUE_BACKLOG_CRITICAL',
    message: 'Job queue backlog exceeded 50k messages — workers blocked on DB writes',
    metadata: { queueDepth: 52430, workers: 8, processingRate: '0 msg/s' },
  }, 90, 35);

  console.log('\n✅ Simulation complete! Check your IMS dashboard at http://localhost:3000\n');
  console.log('You should see:');
  console.log('  • P0 incident for POSTGRES_PRIMARY_01');
  console.log('  • P0 incident for MCP_HOST_GATEWAY_01');
  console.log('  • P2 incidents for CACHE and QUEUE components');
  console.log('  • All signals debounced into single Work Items per component\n');
}

main().catch(console.error);
