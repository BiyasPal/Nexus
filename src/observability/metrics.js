const DEFAULT_WINDOW_SIZE = 100;
const ERROR_STATUS_THRESHOLD = 400;

function newStat() {
  return { count: 0, errors: 0, totalLatencyMs: 0 };
}

function avgLatency(stat) {
  return stat.count === 0 ? 0 : stat.totalLatencyMs / stat.count;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const index = Math.min(sortedValues.length - 1, Math.max(rank, 0));
  return sortedValues[index];
}

/**
 * In-memory counters/timers backing the dashboard. Independent of
 * logger.js on purpose - don't let one depend on the other.
 * Zero-dep swap for prom-client: plain Map/object counters + manual
 * percentile math.
 */
export function createMetrics(metricsConfig = {}) {
  const windowSize = metricsConfig.windowSize || DEFAULT_WINDOW_SIZE;

  let totalRequests = 0;
  let totalErrors = 0;
  let latencyWindow = [];

  const routeStats = new Map();
  const backendStats = new Map();

  function isErrorStatus(status) {
    return typeof status === 'number' && status >= ERROR_STATUS_THRESHOLD;
  }

  function ensureStat(map, key) {
    if (!map.has(key)) {
      map.set(key, newStat());
    }
    return map.get(key);
  }

  function pushLatency(durationMs) {
    if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) return;
    latencyWindow.push(durationMs);
    if (latencyWindow.length > windowSize) {
      latencyWindow = latencyWindow.slice(latencyWindow.length - windowSize);
    }
  }

  function applyStat(map, key, durationMs, error) {
    if (!key) return;
    const stat = ensureStat(map, key);
    stat.count += 1;
    stat.totalLatencyMs += durationMs || 0;
    if (error) stat.errors += 1;
  }

  /**
   * Must be called on every response path - 404/401/429/502 included,
   * not just successful proxied requests. Missing a branch here is what
   * causes a false "100% error rate" from a couple of stray failures.
   */
  function recordRequest({ route, backend, status, durationMs }) {
    totalRequests += 1;
    const error = isErrorStatus(status);
    if (error) totalErrors += 1;

    pushLatency(durationMs);
    applyStat(routeStats, route, durationMs, error);
    applyStat(backendStats, backend, durationMs, error);
  }

  function breakdown(map) {
    const result = {};
    for (const [key, stat] of map.entries()) {
      result[key] = {
        count: stat.count,
        errors: stat.errors,
        avgLatencyMs: avgLatency(stat)
      };
    }
    return result;
  }

  function snapshot() {
    const sorted = [...latencyWindow].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);

    return {
      totals: {
        requests: totalRequests,
        errors: totalErrors,
        errorRate: totalRequests === 0 ? 0 : totalErrors / totalRequests
      },
      latency: {
        avgMs: sorted.length === 0 ? 0 : sum / sorted.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        windowSize: latencyWindow.length
      },
      routes: breakdown(routeStats),
      backends: breakdown(backendStats)
    };
  }

  function reset() {
    totalRequests = 0;
    totalErrors = 0;
    latencyWindow = [];
    routeStats.clear();
    backendStats.clear();
  }

  return {
    recordRequest,
    snapshot,
    reset
  };
}
