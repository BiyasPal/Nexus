import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMetrics } from '../../observability/metrics.js';

describe('recordRequest - totals', () => {
  test('starts at zero before any request is recorded', () => {
    const metrics = createMetrics();
    const snapshot = metrics.snapshot();

    assert.deepEqual(snapshot.totals, { requests: 0, errors: 0, errorRate: 0 });
  });

  test('counts a successful request without marking it an error', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 10 });

    const { totals } = metrics.snapshot();
    assert.equal(totals.requests, 1);
    assert.equal(totals.errors, 0);
    assert.equal(totals.errorRate, 0);
  });

  test('counts 404/401/429/502 as errors, not just 5xx from a proxied backend', () => {
    const metrics = createMetrics();
    for (const status of [404, 401, 429, 502]) {
      metrics.recordRequest({ route: '/x', backend: 'web', status, durationMs: 5 });
    }

    const { totals } = metrics.snapshot();
    assert.equal(totals.requests, 4);
    assert.equal(totals.errors, 4);
    assert.equal(totals.errorRate, 1);
  });

  test('computes a correct mixed error rate', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 1 });
    metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 1 });
    metrics.recordRequest({ route: '/', backend: 'web', status: 500, durationMs: 1 });

    assert.equal(metrics.snapshot().totals.errorRate, 1 / 3);
  });
});

describe('recordRequest - per-route and per-backend breakdown', () => {
  test('tracks count, errors, and avg latency per route', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: '/api', backend: 'web', status: 200, durationMs: 10 });
    metrics.recordRequest({ route: '/api', backend: 'web', status: 500, durationMs: 20 });
    metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 30 });

    const { routes } = metrics.snapshot();
    assert.equal(routes['/api'].count, 2);
    assert.equal(routes['/api'].errors, 1);
    assert.equal(routes['/api'].avgLatencyMs, 15);
    assert.equal(routes['/'].count, 1);
    assert.equal(routes['/'].errors, 0);
  });

  test('tracks count, errors, and avg latency per backend independently of routes', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: '/a', backend: 'pool-1', status: 200, durationMs: 10 });
    metrics.recordRequest({ route: '/b', backend: 'pool-1', status: 200, durationMs: 30 });
    metrics.recordRequest({ route: '/c', backend: 'pool-2', status: 502, durationMs: 5 });

    const { backends } = metrics.snapshot();
    assert.equal(backends['pool-1'].count, 2);
    assert.equal(backends['pool-1'].avgLatencyMs, 20);
    assert.equal(backends['pool-2'].errors, 1);
  });

  test('a request with no matched route/backend (e.g. 404) is not attributed to either breakdown', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: null, backend: null, status: 404, durationMs: 2 });

    const { totals, routes, backends } = metrics.snapshot();
    assert.equal(totals.requests, 1);
    assert.equal(totals.errors, 1);
    assert.deepEqual(routes, {});
    assert.deepEqual(backends, {});
  });
});

describe('snapshot - rolling window latency', () => {
  test('reports a plain average and percentiles over recorded latencies', () => {
    const metrics = createMetrics();
    for (const durationMs of [10, 20, 30, 40, 50]) {
      metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs });
    }

    const { latency } = metrics.snapshot();
    assert.equal(latency.avgMs, 30);
    assert.equal(latency.p50Ms, 30);
    assert.equal(latency.windowSize, 5);
  });

  test('only keeps the most recent N samples once windowSize is configured', () => {
    const metrics = createMetrics({ windowSize: 3 });
    for (const durationMs of [100, 1, 2, 3]) {
      metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs });
    }

    const { latency } = metrics.snapshot();
    assert.equal(latency.windowSize, 3);
    assert.equal(latency.avgMs, 2);
  });

  test('p99 is never lower than p50 for a spread of latencies', () => {
    const metrics = createMetrics();
    for (let i = 1; i <= 100; i += 1) {
      metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: i });
    }

    const { latency } = metrics.snapshot();
    assert.ok(latency.p99Ms >= latency.p50Ms);
    assert.ok(latency.p95Ms >= latency.p50Ms);
  });
});

describe('reset', () => {
  test('clears totals, breakdowns, and the latency window', () => {
    const metrics = createMetrics();
    metrics.recordRequest({ route: '/', backend: 'web', status: 500, durationMs: 10 });

    metrics.reset();

    assert.deepEqual(metrics.snapshot(), {
      totals: { requests: 0, errors: 0, errorRate: 0 },
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, windowSize: 0 },
      routes: {},
      backends: {}
    });
  });
});
