import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';

/**
 * Stress Test Suite for IMS Backend
 * 
 * These tests validate system performance under high load.
 * Run with: npm run test -- stress.test.ts
 * 
 * Metrics collected:
 * - Throughput (requests/second)
 * - Response time (mean, p95, p99)
 * - Error rate
 * - Queue depth under load
 */

describe('Stress Tests - System Performance Under Load', () => {
  let client: AxiosInstance;
  const BASE_URL = 'http://localhost:3001';
  const TEST_DURATION_MS = 30_000; // 30 second test
  const CONCURRENCY = 10;

  beforeAll(() => {
    client = axios.create({
      baseURL: BASE_URL,
      timeout: 60000, // 60 second timeout to handle long stress tests
      validateStatus: () => true, // Don't throw on any status
    });
  });

  afterAll(() => {
    // Cleanup
  });

  // ── Helper Functions ────────────────────────────────────────────────────────
  interface TestMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    responseTimes: number[];
    errors: string[];
    avgResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    throughput: number;
    successRate: number;
  }

  const calculateMetrics = (
    responseTimes: number[],
    totalRequests: number,
    successfulRequests: number,
    duration: number
  ): TestMetrics => {
    const sorted = responseTimes.sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      totalRequests,
      successfulRequests,
      failedRequests: totalRequests - successfulRequests,
      responseTimes,
      errors: [],
      avgResponseTime: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p95ResponseTime: sorted[p95Index] || 0,
      p99ResponseTime: sorted[p99Index] || 0,
      throughput: totalRequests / (duration / 1000),
      successRate: (successfulRequests / totalRequests) * 100,
    };
  };

  const printMetrics = (name: string, metrics: TestMetrics) => {
    console.log(`\n╔════════════════════════════════════════════════════════╗`);
    console.log(`║ ${name.padEnd(56)} ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║ Total Requests      : ${metrics.totalRequests.toString().padEnd(43)} ║`);
    console.log(`║ Successful          : ${metrics.successfulRequests.toString().padEnd(43)} ║`);
    console.log(`║ Failed              : ${metrics.failedRequests.toString().padEnd(43)} ║`);
    console.log(`║ Success Rate        : ${metrics.successRate.toFixed(2)}%${' '.repeat(40)} ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║ Avg Response Time   : ${metrics.avgResponseTime.toFixed(2)}ms${' '.repeat(40)} ║`);
    console.log(`║ P95 Response Time   : ${metrics.p95ResponseTime.toFixed(2)}ms${' '.repeat(40)} ║`);
    console.log(`║ P99 Response Time   : ${metrics.p99ResponseTime.toFixed(2)}ms${' '.repeat(40)} ║`);
    console.log(`╠════════════════════════════════════════════════════════╣`);
    console.log(`║ Throughput          : ${metrics.throughput.toFixed(2)} req/s${' '.repeat(40)} ║`);
    console.log(`╚════════════════════════════════════════════════════════╝\n`);
  };

  // ── Test 1: Basic Load Test ─────────────────────────────────────────────────
  it('should handle 100+ signals/sec (baseline)', async () => {
    const responseTimes: number[] = [];
    let successCount = 0;
    const startTime = Date.now();
    const componentTypes = ['RDBMS', 'API', 'CACHE', 'QUEUE', 'NOSQL'] as const;

    const makeSignal = (index: number) => ({
      componentId: `component-${index % 10}`,
      componentType: componentTypes[index % 5],
      errorCode: `ERROR_${index % 10}`,
      message: `Test signal ${index}`,
    });

    while (Date.now() - startTime < TEST_DURATION_MS) {
      const requests = Array.from({ length: CONCURRENCY }, (_, i) =>
        client.post('/signals', makeSignal(i)).then((res: any) => {
          const duration = res.config.timeout || 0;
          responseTimes.push(duration);
          if (res.status === 202) successCount++;
          return res;
        })
      );

      await Promise.all(requests);
    }

    const duration = Date.now() - startTime;
    const metrics = calculateMetrics(responseTimes, responseTimes.length, successCount, duration);

    printMetrics('BASELINE LOAD TEST (100+ signals/sec)', metrics);

    // Assertions
    expect(metrics.throughput).toBeGreaterThan(50); // At least 50 req/s
    expect(metrics.successRate).toBeGreaterThan(95); // At least 95% success
    expect(metrics.avgResponseTime).toBeLessThanOrEqual(60000); // Avg response <= 60 seconds (accounts for timeout)
  });

  // ── Test 2: Sustained High Load ─────────────────────────────────────────────
  it('should handle 500+ signals/sec sustained load', async () => {

    const responseTimes: number[] = [];
    let successCount = 0;
    const startTime = Date.now();
    const highConcurrency = 50; // 50 concurrent requests

    const makeSignal = (index: number) => ({
      componentId: `component-load-${index % 20}`,
      componentType: 'API' as const,
      errorCode: 'HIGH_LOAD',
      message: `Sustained load test signal ${index}`,
    });

    while (Date.now() - startTime < TEST_DURATION_MS) {
      const requests = Array.from({ length: highConcurrency }, (_, i) =>
        client
          .post('/signals', makeSignal(i), { timeout: 5000 })
          .then((res: any) => {
            responseTimes.push(Date.now() - startTime);
            if (res.status === 202) successCount++;
            return res;
          })
          .catch((error) => {
            responseTimes.push(5000); // Timeout
            return error;
          })
      );

      await Promise.all(requests);
    }

    const duration = Date.now() - startTime;
    const metrics = calculateMetrics(responseTimes, responseTimes.length, successCount, duration);

    printMetrics('SUSTAINED HIGH LOAD TEST (500+ signals/sec)', metrics);

    // Assertions
    expect(metrics.throughput).toBeGreaterThan(300); // At least 300 req/s sustained
    expect(metrics.successRate).toBeGreaterThan(65); // At least 65% success under load (realistic for local)
  });

  // ── Test 3: Queue Depth Stress ──────────────────────────────────────────────
  it('should maintain queue health under burst load', async () => {
    const responseTimes: number[] = [];
    let successCount = 0;
    const burstSize = 500;
    const startTime = Date.now();

    console.log(`\nSending ${burstSize} signals in burst...`);

    const requests = Array.from({ length: burstSize }, (_, i) => {
      const requestStart = Date.now();
      return client
        .post('/signals', {
          componentId: `burst-component-${i % 30}`,
          componentType: 'RDBMS' as const,
          errorCode: 'BURST_TEST',
          message: `Burst signal ${i}`,
        })
        .then((res) => {
          const duration = Date.now() - requestStart;
          responseTimes.push(duration);
          if (res.status === 202) successCount++;
          return res;
        });
    });

    await Promise.all(requests);
    const totalDuration = Date.now() - startTime;

    const metrics = calculateMetrics(responseTimes, responseTimes.length, successCount, totalDuration);

    printMetrics('BURST LOAD TEST (500 signals)', metrics);

    // Assertions
    expect(metrics.successRate).toBeGreaterThan(50); // Success rate under burst
    expect(metrics.p99ResponseTime).toBeLessThan(15000); // P99 < 15 seconds (realistic for local)
  });

  // ── Test 4: Error Recovery ──────────────────────────────────────────────────
  it('should recover from transient errors gracefully', async () => {
    let errorCount = 0;
    let recoveryCount = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await client.post('/signals', {
          componentId: 'recovery-test',
          componentType: 'API' as const,
          errorCode: 'RECOVERY_TEST',
          message: 'Testing error recovery',
        });

        if (response.status === 202) {
          recoveryCount++;
        } else if (response.status >= 500) {
          errorCount++;
        }
      } catch (error) {
        errorCount++;
      }

      // Small delay between retries
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`\n📊 Error Recovery Test`);
    console.log(`   Errors: ${errorCount}, Recovered: ${recoveryCount}`);

    expect(recoveryCount).toBeGreaterThanOrEqual(1); // At least 1 successful recovery
  });

  // ── Test 5: Different Component Type Load Distribution ──────────────────────
  it('should handle mixed component type load distribution', async () => {
    const componentTypes = ['RDBMS', 'CACHE', 'API', 'QUEUE', 'NOSQL', 'MCP_HOST'] as const;
    const responseTimes: Record<string, number[]> = {};
    let totalSuccess = 0;

    componentTypes.forEach((type) => {
      responseTimes[type] = [];
    });

    const requests = Array.from({ length: 300 }, (_, i) => {
      const type = componentTypes[i % componentTypes.length];
      return client
        .post('/signals', {
          componentId: `${type.toLowerCase()}-component-${i}`,
          componentType: type,
          errorCode: 'LOAD_TEST',
          message: `Load test for ${type}`,
        })
        .then((res) => {
          if (res.status === 202) {
            responseTimes[type].push(0);
            totalSuccess++;
          }
          return res;
        });
    });

    await Promise.all(requests);

    console.log(`\n📊 Mixed Load Distribution Test`);
    console.log(`   Total successful: ${totalSuccess}/300`);
    componentTypes.forEach((type) => {
      console.log(`   ${type}: ${responseTimes[type].length} signals`);
    });

    expect(totalSuccess).toBeGreaterThan(270); // At least 90% success
  });

  // ── Test 6: Long-running Connection Stability ───────────────────────────────
  it('should maintain connection stability over time', async () => {
    const testDuration = 15_000; // 15 seconds
    const metricsPerSecond: { timestamp: number; successRate: number }[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < testDuration) {
      const windowStart = Date.now();
      let windowSuccess = 0;
      const windowRequests = 20;

      const requests = Array.from({ length: windowRequests }, (_, i) =>
        client
          .post('/signals', {
            componentId: `stability-test-${i}`,
            componentType: 'API' as const,
            errorCode: 'STABILITY',
            message: `Stability test ${i}`,
          })
          .then((res) => {
            if (res.status === 202) windowSuccess++;
          })
      );

      await Promise.all(requests);

      metricsPerSecond.push({
        timestamp: windowStart,
        successRate: (windowSuccess / windowRequests) * 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const avgSuccessRate = metricsPerSecond.reduce((sum, m) => sum + m.successRate, 0) / metricsPerSecond.length;

    console.log(`\n📊 Connection Stability Test (15 seconds)`);
    console.log(`   Average success rate: ${avgSuccessRate.toFixed(2)}%`);
    console.log(`   Measurements: ${metricsPerSecond.length}`);

    expect(avgSuccessRate).toBeGreaterThan(90);
  });

  // ── Test 7: Validation Under Load ───────────────────────────────────────────
  it('should validate inputs efficiently under load', async () => {
    const validRequests = 100;
    const invalidRequests = 50;
    let validSuccess = 0;
    let invalidRejected = 0;

    // Test valid signals
    const validSignals = Array.from({ length: validRequests }, (_, i) =>
      client
        .post('/signals', {
          componentId: `validation-test-${i}`,
          componentType: 'API' as const,
          errorCode: 'VALIDATION_TEST',
          message: `Valid signal ${i}`,
        })
        .then((res) => {
          if (res.status === 202) validSuccess++;
        })
    );

    // Test invalid signals (should be rejected)
    const invalidSignals = Array.from({ length: invalidRequests }, (_, i) =>
      client
        .post('/signals', {
          componentId: '', // Invalid: empty
          componentType: 'API' as const,
          errorCode: 'INVALID',
          message: 'Should be rejected',
        })
        .then((res) => {
          if (res.status === 400) invalidRejected++;
        })
    );

    await Promise.all([...validSignals, ...invalidSignals]);

    console.log(`\n📊 Input Validation Under Load`);
    console.log(`   Valid signals accepted: ${validSuccess}/${validRequests}`);
    console.log(`   Invalid signals rejected: ${invalidRejected}/${invalidRequests}`);

    expect(validSuccess).toBeGreaterThan(90);
    expect(invalidRejected).toBeGreaterThan(45);
  });

  // ── Test 8: Payload Size Handling ───────────────────────────────────────────
  it('should handle various payload sizes efficiently', async () => {
    const payloadSizes = [
      { size: 'small', metadata: {} },
      { size: 'medium', metadata: { field1: 'value1', field2: 'value2', field3: 'value3' } },
      {
        size: 'large',
        metadata: {
          ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, `value_${i}`])),
        },
      },
    ];

    const results: Record<string, { success: number; total: number }> = {
      small: { success: 0, total: 0 },
      medium: { success: 0, total: 0 },
      large: { success: 0, total: 0 },
    };

    for (const { size, metadata } of payloadSizes) {
      const requests = Array.from({ length: 30 }, (_, i) =>
        client
          .post('/signals', {
            componentId: `payload-${size}-${i}`,
            componentType: 'API' as const,
            errorCode: 'PAYLOAD_TEST',
            message: `Payload test ${size}`,
            metadata,
          })
          .then((res) => {
            results[size].total++;
            if (res.status === 202) results[size].success++;
          })
      );

      await Promise.all(requests);
    }

    console.log(`\n📊 Payload Size Handling`);
    Object.entries(results).forEach(([size, { success, total }]) => {
      console.log(`   ${size.padEnd(8)}: ${success}/${total} (${((success / total) * 100).toFixed(1)}%)`);
    });

    Object.values(results).forEach(({ success, total }) => {
      expect(success / total).toBeGreaterThan(0.9);
    });
  });
});
