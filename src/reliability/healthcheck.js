import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

function keyFor(poolName, backendUrl) {
  return `${poolName}::${backendUrl}`;
}

export function pingBackend(backendUrl, checkPath, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(checkPath, backendUrl);
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        statusCode: res.statusCode
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`health check timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err });
    });
  });
}

export function createHealthChecker(backends, healthcheckConfig, logger) {
  const log = logger || console;
  const checkPath = healthcheckConfig.path;
  const intervalMs = healthcheckConfig.intervalMs;
  const unhealthyThreshold = healthcheckConfig.unhealthyThreshold;
  const healthyThreshold = healthcheckConfig.healthyThreshold;
  const timeoutMs = healthcheckConfig.timeoutMs || intervalMs;

  const state = new Map();

  for (const [poolName, pool] of Object.entries(backends)) {
    for (const backend of pool) {
      state.set(keyFor(poolName, backend.url), {
        poolName,
        url: backend.url,
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0
      });
    }
  }

  let timer = null;

  function transition(entry, healthy) {
    if (entry.healthy === healthy) return;
    entry.healthy = healthy;
    if (healthy) {
      log.info(`backend ${entry.url} (${entry.poolName}) is now healthy`);
    } else {
      log.warn(`backend ${entry.url} (${entry.poolName}) is now unhealthy`);
    }
  }

  function recordResult(entry, ok) {
    if (ok) {
      entry.consecutiveSuccesses += 1;
      entry.consecutiveFailures = 0;
      if (!entry.healthy && entry.consecutiveSuccesses >= healthyThreshold) {
        transition(entry, true);
      }
    } else {
      entry.consecutiveFailures += 1;
      entry.consecutiveSuccesses = 0;
      if (entry.healthy && entry.consecutiveFailures >= unhealthyThreshold) {
        transition(entry, false);
      }
    }
  }

  async function pollOnce() {
    const checks = [];
    for (const entry of state.values()) {
      checks.push(
        pingBackend(entry.url, checkPath, timeoutMs).then((result) => {
          recordResult(entry, result.ok);
        })
      );
    }
    await Promise.all(checks);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      pollOnce().catch((err) => {
        log.error(`health check poll failed: ${err.message}`);
      });
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function isHealthy(poolName, backendUrl) {
    const entry = state.get(keyFor(poolName, backendUrl));
    return entry ? entry.healthy : false;
  }

  function getHealthyBackends(poolName) {
    const pool = backends[poolName] || [];
    return pool.filter((backend) => isHealthy(poolName, backend.url));
  }

  function getStatusSnapshot() {
    const snapshot = {};
    for (const entry of state.values()) {
      if (!snapshot[entry.poolName]) {
        snapshot[entry.poolName] = [];
      }
      snapshot[entry.poolName].push({ url: entry.url, healthy: entry.healthy });
    }
    return snapshot;
  }

  function reportFailure(poolName, backendUrl) {
    const entry = state.get(keyFor(poolName, backendUrl));
    if (!entry) return;
    entry.consecutiveSuccesses = 0;
    entry.consecutiveFailures = Math.max(entry.consecutiveFailures, unhealthyThreshold);
    if (entry.healthy) {
      transition(entry, false);
    }
  }

  return {
    start,
    stop,
    pollOnce,
    isHealthy,
    getHealthyBackends,
    getStatusSnapshot,
    reportFailure
  };
}