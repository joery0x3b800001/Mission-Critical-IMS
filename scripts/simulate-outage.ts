#!/usr/bin/env node
/**
 * simulate-outage.ts
 *
 * Two modes:
 *   1. OUTAGE  — realistic cascading failure across 5 component types
 *   2. BURST   — true 10,000 signals/sec stress test with backpressure
 *                measurement and crash-resilience verification
 *
 * Usage:
 *   npx ts-node simulate-outage.ts            # runs outage scenario
 *   npx ts-node simulate-outage.ts --burst    # runs 10k/sec burst test
 *   npx ts-node simulate-outage.ts --both     # runs outage then burst
 */

const BASE_URL = process.env.API_URL ?? 'http://localhost:3001';
const MODE     = process.argv.includes('--burst') ? 'burst'
               : process.argv.includes('--both')  ? 'both'
               : 'outage';

// ── Types ────────────────────────────────────────────────────────────────────
interface Signal {
  componentId:   string;
  componentType: 'RDBMS' | 'CACHE' | 'API' | 'QUEUE' | 'NOSQL' | 'MCP_HOST';
  errorCode:     string;
  message:       string;
  latencyMs?:    number;
  metadata?:     Record<string, unknown>;
}

interface BurstStats {
  totalSent:      number;
  totalAccepted:  number;
  totalRejected:  number;  // rate-limited (429)
  totalFailed:    number;  // network / 5xx errors
  durationMs:     number;
  throughputPerSec: number;
  p50Ms:          number;
  p95Ms:          number;
  p99Ms:          number;
  maxMs:          number;
}

// ── Colours ──────────────────────────────────────────────────────────────────
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m',
      C = '\x1b[36m', B = '\x1b[1m',  D = '\x1b[0m';

// ── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function bar(filled: number, total: number, width = 30): string {
  const n = Math.round((filled / total) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

// ── Single signal send (returns latency and status) ──────────────────────────
async function sendSignal(
  signal: Signal,
): Promise<{ status: number; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/signals`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...signal, timestamp: new Date().toISOString() }),
    });
    return { status: res.status, latencyMs: Date.now() - start };
  } catch {
    return { status: 0, latencyMs: Date.now() - start };
  }
}

// ── Batch send (uses /signals/batch endpoint — 1 HTTP call per 100 signals) ──
async function sendBatch(
  signals: Signal[],
): Promise<{ status: number; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/signals/batch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signals }),
    });
    return { status: res.status, latencyMs: Date.now() - start };
  } catch {
    return { status: 0, latencyMs: Date.now() - start };
  }
}

// ── Sequential burst (used for outage scenario) ──────────────────────────────
async function burst(signal: Signal, count: number, delayMs = 50): Promise<void> {
  process.stdout.write(`  Sending ${count} signals for ${signal.componentId}...`);
  for (let i = 0; i < count; i++) {
    await sendSignal({ ...signal, latencyMs: Math.floor(Math.random() * 5000) + 1000 });
    if (delayMs > 0) await sleep(delayMs);
  }
  console.log(` ${G}✓${D}`);
}

// ════════════════════════════════════════════════════════════════════════════
// BURST TEST — sends 10,000 signals/sec for 5 seconds (50,000 total)
// Uses concurrent batch requests to achieve true high throughput.
// Measures: throughput, latency percentiles, rejection rate, server stability.
// ════════════════════════════════════════════════════════════════════════════
async function runBurstTest(): Promise<void> {
  console.log(`\n${B}${R}╔══════════════════════════════════════════════════════════╗${D}`);
  console.log(`${B}${R}║         BURST TEST — 10,000 signals/sec for 5s           ║${D}`);
  console.log(`${B}${R}╚══════════════════════════════════════════════════════════╝${D}\n`);

  // Verify server is up before starting
  console.log(`${C}[Pre-flight] Checking server health...${D}`);
  try {
    const health = await fetch(`${BASE_URL}/health`);
    const data   = await health.json() as Record<string, unknown>;
    if (data.status !== 'ok') {
      console.warn(`${Y}[Warning] Server health is degraded: ${JSON.stringify(data)}${D}`);
    } else {
      console.log(`${G}[Pre-flight] Server healthy ✓${D}\n`);
    }
  } catch {
    console.error(`${R}[Pre-flight] Cannot reach server at ${BASE_URL}. Is it running?${D}`);
    process.exit(1);
  }

  const TARGET_PER_SEC  = 10_000;
  const DURATION_SEC    = 5;
  const TOTAL_SIGNALS   = TARGET_PER_SEC * DURATION_SEC;  // 50,000
  const BATCH_SIZE      = 100;   // signals per HTTP request
  const BATCHES_PER_SEC = TARGET_PER_SEC / BATCH_SIZE;    // 100 batch requests/sec
  const BATCH_INTERVAL  = 1000 / BATCHES_PER_SEC;         // 10ms between batches

  // Component pool — spread load across multiple component IDs to test debounce
  const COMPONENTS: Signal[] = [
    { componentId: 'BURST_RDBMS_01',   componentType: 'RDBMS',    errorCode: 'BURST_CONN_TIMEOUT',  message: 'Burst test: RDBMS connection timeout' },
    { componentId: 'BURST_RDBMS_02',   componentType: 'RDBMS',    errorCode: 'BURST_DEADLOCK',      message: 'Burst test: RDBMS deadlock detected' },
    { componentId: 'BURST_CACHE_01',   componentType: 'CACHE',    errorCode: 'BURST_EVICTION',      message: 'Burst test: Cache eviction storm' },
    { componentId: 'BURST_CACHE_02',   componentType: 'CACHE',    errorCode: 'BURST_MISS',          message: 'Burst test: Cache miss rate critical' },
    { componentId: 'BURST_API_01',     componentType: 'API',      errorCode: 'BURST_5XX',           message: 'Burst test: API 5xx error rate spike' },
    { componentId: 'BURST_QUEUE_01',   componentType: 'QUEUE',    errorCode: 'BURST_BACKLOG',       message: 'Burst test: Queue backlog overflow' },
    { componentId: 'BURST_NOSQL_01',   componentType: 'NOSQL',    errorCode: 'BURST_WRITE_FAIL',    message: 'Burst test: NoSQL write failure' },
    { componentId: 'BURST_MCP_01',     componentType: 'MCP_HOST', errorCode: 'BURST_UNRESPONSIVE',  message: 'Burst test: MCP Host unresponsive' },
  ];

  const latencies:   number[]  = [];
  let   accepted              = 0;
  let   rejected              = 0;
  let   failed                = 0;
  let   batchesSent           = 0;
  const totalBatches          = (TOTAL_SIGNALS / BATCH_SIZE);

  // Progress reporter — prints a live bar every second
  const progressInterval = setInterval(() => {
    const pct  = Math.round((batchesSent / totalBatches) * 100);
    const sent = batchesSent * BATCH_SIZE;
    process.stdout.write(
      `\r  ${bar(batchesSent, totalBatches)} ${pct}%  ` +
      `sent=${G}${sent.toLocaleString()}${D}  ` +
      `accepted=${G}${accepted}${D}  ` +
      `rejected=${Y}${rejected}${D}  ` +
      `failed=${R}${failed}${D}   `
    );
  }, 250);

  // ── Main burst loop ──────────────────────────────────────────────────────
  const overallStart = Date.now();

  // Fire BATCHES_PER_SEC batches every second for DURATION_SEC seconds.
  // Each "tick" fires one batch of BATCH_SIZE signals concurrently.
  const promises: Promise<void>[] = [];

  for (let tick = 0; tick < totalBatches; tick++) {
    const delay = tick * BATCH_INTERVAL;

    const p = sleep(delay).then(async () => {
      // Build a batch of BATCH_SIZE signals, cycling through component pool
      const signals: Signal[] = Array.from({ length: BATCH_SIZE }, (_, i) => {
        const comp = COMPONENTS[(tick * BATCH_SIZE + i) % COMPONENTS.length];
        return {
          ...comp,
          latencyMs: Math.floor(Math.random() * 3000) + 100,
          metadata:  { tick, index: i, batchId: `batch-${tick}` },
        };
      });

      const result = await sendBatch(signals);
      batchesSent++;

      if (result.status === 202) {
        accepted += BATCH_SIZE;
      } else if (result.status === 429) {
        rejected += BATCH_SIZE;
      } else {
        failed += BATCH_SIZE;
      }
      latencies.push(result.latencyMs);
    });

    promises.push(p);
  }

  // Wait for all batches to complete
  await Promise.allSettled(promises);
  const durationMs = Date.now() - overallStart;

  clearInterval(progressInterval);
  process.stdout.write('\n\n');

  // ── Stats ────────────────────────────────────────────────────────────────
  latencies.sort((a, b) => a - b);
  const stats: BurstStats = {
    totalSent:        TOTAL_SIGNALS,
    totalAccepted:    accepted,
    totalRejected:    rejected,
    totalFailed:      failed,
    durationMs,
    throughputPerSec: Math.round((accepted / durationMs) * 1000),
    p50Ms:            percentile(latencies, 50),
    p95Ms:            percentile(latencies, 95),
    p99Ms:            percentile(latencies, 99),
    maxMs:            latencies[latencies.length - 1] ?? 0,
  };

  const acceptRate = ((accepted / TOTAL_SIGNALS) * 100).toFixed(1);
  const crashFree  = failed === 0 || (failed / TOTAL_SIGNALS) < 0.01;

  console.log(`${B}${C}╔══════════════════════════════════════════════════════════╗${D}`);
  console.log(`${B}${C}║                   BURST TEST RESULTS                     ║${D}`);
  console.log(`${B}${C}╚══════════════════════════════════════════════════════════╝${D}\n`);

  console.log(`  ${B}Throughput${D}`);
  console.log(`    Target:          ${TARGET_PER_SEC.toLocaleString()} signals/sec`);
  console.log(`    Achieved:        ${B}${G}${stats.throughputPerSec.toLocaleString()} signals/sec${D}`);
  console.log(`    Duration:        ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`    Total sent:      ${stats.totalSent.toLocaleString()}`);
  console.log('');

  console.log(`  ${B}Acceptance${D}`);
  console.log(`    Accepted (202):  ${G}${stats.totalAccepted.toLocaleString()}${D}  (${acceptRate}%)`);
  console.log(`    Rate-limited (429): ${Y}${stats.totalRejected.toLocaleString()}${D}`);
  console.log(`    Failed (5xx/net):   ${R}${stats.totalFailed.toLocaleString()}${D}`);
  console.log('');

  console.log(`  ${B}Latency (per batch request, not per signal)${D}`);
  console.log(`    p50:  ${stats.p50Ms}ms`);
  console.log(`    p95:  ${stats.p95Ms}ms`);
  console.log(`    p99:  ${stats.p99Ms}ms`);
  console.log(`    max:  ${stats.maxMs}ms`);
  console.log('');

  // ── Crash resilience verdict ─────────────────────────────────────────────
  console.log(`  ${B}Crash Resilience${D}`);
  if (crashFree) {
    console.log(`    ${G}${B}✓ PASS — Server did not crash under ${TARGET_PER_SEC.toLocaleString()}/sec burst${D}`);
    console.log(`    ${G}  BullMQ queue absorbed backpressure correctly${D}`);
  } else {
    const failPct = ((failed / TOTAL_SIGNALS) * 100).toFixed(1);
    console.log(`    ${R}${B}✗ FAIL — ${failPct}% of signals resulted in errors${D}`);
    console.log(`    ${R}  Check backend logs for OOM or queue overflow${D}`);
  }

  // ── Post-burst health check ──────────────────────────────────────────────
  console.log('');
  console.log(`${C}[Post-burst] Checking server health after load...${D}`);
  await sleep(2000);  // give server 2s to finish draining
  try {
    const health = await fetch(`${BASE_URL}/health`);
    const data   = await health.json() as Record<string, unknown>;
    if (data.status === 'ok') {
      console.log(`${G}[Post-burst] Server still healthy ✓  queueDepth=${data.queueDepth}${D}`);
    } else {
      console.log(`${Y}[Post-burst] Server degraded after burst: ${JSON.stringify(data)}${D}`);
    }
  } catch {
    console.log(`${R}[Post-burst] Server unreachable after burst — possible crash!${D}`);
  }

  console.log('');
}

// ════════════════════════════════════════════════════════════════════════════
// OUTAGE SCENARIO — realistic cascading failure across 5 component types
// ════════════════════════════════════════════════════════════════════════════
async function runOutageScenario(): Promise<void> {
  console.log(`\n${B}${R}╔══════════════════════════════════════════════════════════╗${D}`);
  console.log(`${B}${R}║           IMS OUTAGE SIMULATION — CASCADING FAILURE       ║${D}`);
  console.log(`${B}${R}╚══════════════════════════════════════════════════════════╝${D}\n`);

  // Phase 1: RDBMS primary goes down (P0)
  console.log(`${R}Phase 1: RDBMS Primary failure (P0)${D}`);
  await burst({
    componentId:   'POSTGRES_PRIMARY_01',
    componentType: 'RDBMS',
    errorCode:     'CONN_REFUSED',
    message:       'Connection to primary PostgreSQL refused — host unreachable',
    metadata:      { host: 'pg-primary-01.internal', port: 5432 },
  }, 120, 30);

  await sleep(2000);

  // Phase 2: Read replica overloaded
  console.log(`${R}Phase 2: Read replica overload cascade (P0)${D}`);
  await burst({
    componentId:   'POSTGRES_REPLICA_01',
    componentType: 'RDBMS',
    errorCode:     'MAX_CONN_EXCEEDED',
    message:       'Read replica max connections exceeded — all pools exhausted',
    metadata:      { maxConnections: 100, currentConnections: 100 },
  }, 80, 40);

  await sleep(1000);

  // Phase 3: MCP Host failure
  console.log(`${R}Phase 3: MCP Host failing due to DB dependency (P0)${D}`);
  await burst({
    componentId:   'MCP_HOST_GATEWAY_01',
    componentType: 'MCP_HOST',
    errorCode:     'DEPENDENCY_TIMEOUT',
    message:       'MCP Host unable to reach database — request pipeline stalled',
    metadata:      { dependency: 'POSTGRES_PRIMARY_01', timeoutMs: 30000 },
  }, 150, 25);

  await sleep(1000);

  // Phase 4: Cache miss storm
  console.log(`${Y}Phase 4: Cache miss storm (P2)${D}`);
  await burst({
    componentId:   'CACHE_CLUSTER_01',
    componentType: 'CACHE',
    errorCode:     'CACHE_MISS_STORM',
    message:       'Cache cluster overwhelmed by miss storm due to DB fallback',
    latencyMs:     8500,
    metadata:      { missRate: '94%', evictionRate: 'high' },
  }, 200, 15);

  await sleep(1000);

  // Phase 5: Queue backup
  console.log(`${Y}Phase 5: Async queue backlog growing (P1)${D}`);
  await burst({
    componentId:   'QUEUE_WORKER_POOL_01',
    componentType: 'QUEUE',
    errorCode:     'QUEUE_BACKLOG_CRITICAL',
    message:       'Job queue backlog exceeded 50k messages — workers blocked on DB writes',
    metadata:      { queueDepth: 52430, workers: 8, processingRate: '0 msg/s' },
  }, 90, 35);

  console.log(`\n${G}${B}✅ Outage simulation complete!${D}`);
  console.log(`   Dashboard → ${C}http://localhost:3000${D}\n`);
  console.log('   You should see:');
  console.log(`     ${R}• P0${D} incidents for POSTGRES_PRIMARY_01, POSTGRES_REPLICA_01, MCP_HOST_GATEWAY_01`);
  console.log(`     ${Y}• P1${D} incident for QUEUE_WORKER_POOL_01`);
  console.log(`     ${Y}• P2${D} incident for CACHE_CLUSTER_01`);
  console.log('     • All signals debounced — one Work Item per component\n');
}

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${B}IMS Signal Simulator${D}  mode=${B}${C}${MODE}${D}  target=${C}${BASE_URL}${D}`);

  if (MODE === 'outage' || MODE === 'both') {
    await runOutageScenario();
  }

  if (MODE === 'burst' || MODE === 'both') {
    if (MODE === 'both') await sleep(3000);
    await runBurstTest();
  }
}

main().catch((err) => {
  console.error(`\n${R}[Fatal]${D}`, err);
  process.exit(1);
});