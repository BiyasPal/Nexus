import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

import {
  pingBackend,
  createHealthChecker
} from '../../reliability/healthcheck.js';

function fakeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    warn: (msg) => logs.warn.push(msg),
    error: (msg) => logs.error.push(msg)
  };
}

test('pingBackend resolves ok true for a 2xx response', async (t) => {
  t.mock.method(http, 'get', (url, options, callback) => {
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const result = await pingBackend('http://localhost:9001', '/health', 1000);
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
});

test('pingBackend resolves ok false for a 5xx response', async (t) => {
  t.mock.method(http, 'get', (url, options, callback) => {
    callback({ statusCode: 503, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const result = await pingBackend('http://localhost:9001', '/health', 1000);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
});

test('pingBackend resolves ok false on connection error', async (t) => {
  let errorHandler;
  t.mock.method(http, 'get', () => {
    return {
      on: (event, cb) => {
        if (event === 'error') errorHandler = cb;
      },
      destroy: () => {}
    };
  });
  const promise = pingBackend('http://localhost:9001', '/health', 1000);
  errorHandler(new Error('ECONNREFUSED'));
  const result = await promise;
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('pingBackend destroys the request and resolves ok false on timeout', async (t) => {
  let timeoutHandler;
  let errorHandler;
  let destroyed = false;
  t.mock.method(http, 'get', () => {
    return {
      on: (event, cb) => {
        if (event === 'timeout') timeoutHandler = cb;
        if (event === 'error') errorHandler = cb;
      },
      destroy: (err) => {
        destroyed = true;
        if (err) errorHandler(err);
      }
    };
  });
  const promise = pingBackend('http://localhost:9001', '/health', 50);
  timeoutHandler();
  const result = await promise;
  assert.equal(result.ok, false);
  assert.ok(destroyed);
});

test('pingBackend uses https for https backends', async (t) => {
  const httpMock = t.mock.method(http, 'get', () => {
    throw new Error('http.get should not be called for an https backend');
  });
  t.mock.method(https, 'get', (url, options, callback) => {
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const result = await pingBackend('https://localhost:9443', '/health', 1000);
  assert.equal(result.ok, true);
  assert.equal(httpMock.mock.callCount(), 0);
});

test('all backends start healthy', () => {
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2 };
  const checker = createHealthChecker(backends, config, fakeLogger());
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), true);
});

test('marks a backend unhealthy only after N consecutive failures and logs once', async (t) => {
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 2, healthyThreshold: 2 };
  const logger = fakeLogger();
  t.mock.method(http, 'get', (url, options, callback) => {
    return {
      on: (event, cb) => {
        if (event === 'error') cb(new Error('refused'));
      },
      destroy: () => {}
    };
  });
  const checker = createHealthChecker(backends, config, logger);

  await checker.pollOnce();
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), true);
  assert.equal(logger.logs.warn.length, 0);

  await checker.pollOnce();
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), false);
  assert.equal(logger.logs.warn.length, 1);

  await checker.pollOnce();
  assert.equal(logger.logs.warn.length, 1);
});

test('recovers to healthy only after N consecutive successes', async (t) => {
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 1, healthyThreshold: 2 };
  const logger = fakeLogger();
  let shouldFail = true;
  t.mock.method(http, 'get', (url, options, callback) => {
    if (shouldFail) {
      return {
        on: (event, cb) => {
          if (event === 'error') cb(new Error('refused'));
        },
        destroy: () => {}
      };
    }
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const checker = createHealthChecker(backends, config, logger);

  await checker.pollOnce();
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), false);
  assert.equal(logger.logs.warn.length, 1);

  shouldFail = false;
  await checker.pollOnce();
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), false);
  assert.equal(logger.logs.info.length, 0);

  await checker.pollOnce();
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), true);
  assert.equal(logger.logs.info.length, 1);
});

test('getHealthyBackends filters out unhealthy backends from the pool', async (t) => {
  const backends = {
    web: [
      { url: 'http://localhost:9001', weight: 1 },
      { url: 'http://localhost:9002', weight: 1 }
    ]
  };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 1, healthyThreshold: 2 };
  t.mock.method(http, 'get', (url, options, callback) => {
    if (url.href.includes('9002')) {
      return {
        on: (event, cb) => {
          if (event === 'error') cb(new Error('refused'));
        },
        destroy: () => {}
      };
    }
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const checker = createHealthChecker(backends, config, fakeLogger());
  await checker.pollOnce();
  const healthy = checker.getHealthyBackends('web');
  assert.equal(healthy.length, 1);
  assert.equal(healthy[0].url, 'http://localhost:9001');
});

test('reportFailure marks a backend unhealthy immediately without waiting for the next poll', () => {
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 5, healthyThreshold: 2 };
  const logger = fakeLogger();
  const checker = createHealthChecker(backends, config, logger);
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), true);
  checker.reportFailure('web', 'http://localhost:9001');
  assert.equal(checker.isHealthy('web', 'http://localhost:9001'), false);
  assert.equal(logger.logs.warn.length, 1);
});

test('reportFailure on an unknown backend is a no-op', () => {
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 5, healthyThreshold: 2 };
  const checker = createHealthChecker(backends, config, fakeLogger());
  assert.doesNotThrow(() => checker.reportFailure('web', 'http://localhost:9999'));
});

test('getStatusSnapshot groups backend status by pool', () => {
  const backends = {
    web: [{ url: 'http://localhost:9001', weight: 1 }],
    api: [{ url: 'http://localhost:9101', weight: 1 }]
  };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2 };
  const checker = createHealthChecker(backends, config, fakeLogger());
  const snapshot = checker.getStatusSnapshot();
  assert.deepEqual(snapshot.web, [{ url: 'http://localhost:9001', healthy: true }]);
  assert.deepEqual(snapshot.api, [{ url: 'http://localhost:9101', healthy: true }]);
});

test('start polls on the configured interval and stop clears it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2 };
  let pollCount = 0;
  t.mock.method(http, 'get', (url, options, callback) => {
    pollCount += 1;
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const checker = createHealthChecker(backends, config, fakeLogger());

  checker.start();
  t.mock.timers.tick(5000);
  assert.equal(pollCount, 1);

  t.mock.timers.tick(5000);
  assert.equal(pollCount, 2);

  checker.stop();
  t.mock.timers.tick(5000);
  assert.equal(pollCount, 2);
});

test('start is idempotent when called twice', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const backends = { web: [{ url: 'http://localhost:9001', weight: 1 }] };
  const config = { path: '/health', intervalMs: 1000, unhealthyThreshold: 3, healthyThreshold: 2 };
  let pollCount = 0;
  t.mock.method(http, 'get', (url, options, callback) => {
    pollCount += 1;
    callback({ statusCode: 200, resume: () => {} });
    return { on: () => {}, destroy: () => {} };
  });
  const checker = createHealthChecker(backends, config, fakeLogger());
  checker.start();
  checker.start();
  t.mock.timers.tick(1000);
  assert.equal(pollCount, 1);
  checker.stop();
});