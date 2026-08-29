import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../../security/ratelimiter.js';

function fakeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    warn: (msg) => logs.warn.push(msg),
    error: (msg) => logs.error.push(msg)
  };
}

test('checkLimit allows requests under the configured max', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 5 });

  for (let i = 0; i < 5; i += 1) {
    const result = limiter.checkLimit('1.2.3.4');
    assert.equal(result.allowed, true);
  }
});

test('checkLimit denies once the bucket is exhausted', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 3 });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
  }

  const denied = limiter.checkLimit('1.2.3.4');
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterSeconds >= 1);
});

test('denied result carries a Retry-After-suitable value, allowed result does not', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });

  const first = limiter.checkLimit('9.9.9.9');
  assert.equal(first.allowed, true);
  assert.equal(first.retryAfterSeconds, null);

  const second = limiter.checkLimit('9.9.9.9');
  assert.equal(second.allowed, false);
  assert.equal(typeof second.retryAfterSeconds, 'number');
});

test('checkLimit tracks separate buckets per client IP', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });

  assert.equal(limiter.checkLimit('1.1.1.1').allowed, true);
  assert.equal(limiter.checkLimit('2.2.2.2').allowed, true);
  assert.equal(limiter.checkLimit('1.1.1.1').allowed, false);
  assert.equal(limiter.checkLimit('2.2.2.2').allowed, false);
});

test('tokens refill over time and allow requests again', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
  assert.equal(limiter.checkLimit('1.2.3.4').allowed, false);

  t.mock.timers.tick(1000);

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
});

test('burst option raises capacity above the steady-state max', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 2 });

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(limiter.checkLimit('1.2.3.4', { override: { burst: 3 } }).allowed);
  }

  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(limiter.checkLimit('1.2.3.4', { override: { burst: 3 } }).allowed, false);
});

test('per-route override keeps its own bucket separate from the global one', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
  assert.equal(
    limiter.checkLimit('1.2.3.4', { routeKey: '/login', override: { maxRequests: 1 } }).allowed,
    true
  );

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, false);
  assert.equal(
    limiter.checkLimit('1.2.3.4', { routeKey: '/login', override: { maxRequests: 1 } }).allowed,
    false
  );
});

test('reset clears a client bucket so the next request is allowed', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
  assert.equal(limiter.checkLimit('1.2.3.4').allowed, false);

  limiter.reset('1.2.3.4');

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, true);
});

test('reset scoped to a routeKey does not clear the global bucket', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });

  limiter.checkLimit('1.2.3.4');
  limiter.checkLimit('1.2.3.4', { routeKey: '/login' });

  limiter.reset('1.2.3.4', '/login');

  assert.equal(limiter.checkLimit('1.2.3.4').allowed, false);
  assert.equal(limiter.checkLimit('1.2.3.4', { routeKey: '/login' }).allowed, true);
});

test('size reflects the number of distinct buckets tracked', () => {
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 5 });

  limiter.checkLimit('1.1.1.1');
  limiter.checkLimit('2.2.2.2');
  limiter.checkLimit('1.1.1.1', { routeKey: '/login' });

  assert.equal(limiter.size(), 3);
});

test('checkLimit logs a warning when a client is denied', () => {
  const logger = fakeLogger();
  const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 }, logger);

  limiter.checkLimit('1.2.3.4');
  limiter.checkLimit('1.2.3.4');

  assert.equal(logger.logs.warn.length, 1);
  assert.match(logger.logs.warn[0], /1\.2\.3\.4/);
});