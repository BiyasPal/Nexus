function resolveLimits(defaults, override) {
  if (!override) {
    return defaults;
  }

  return {
    windowMs: override.windowMs || defaults.windowMs,
    maxRequests: override.maxRequests || defaults.maxRequests,
    burst: override.burst != null ? override.burst : defaults.burst
  };
}

function bucketKey(clientIp, routeKey) {
  return routeKey ? `${routeKey}::${clientIp}` : clientIp;
}

export function createRateLimiter(ratelimitConfig, logger) {
  const log = logger || console;

  const defaults = {
    windowMs: ratelimitConfig.windowMs,
    maxRequests: ratelimitConfig.maxRequests,
    burst: ratelimitConfig.burst || 0
  };

  const buckets = new Map();

  function getBucket(key, capacity, now) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  function refill(bucket, capacity, refillRatePerMs, now) {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
    bucket.lastRefill = now;
  }

  function checkLimit(clientIp, options = {}) {
    const { routeKey, override } = options;
    const { windowMs, maxRequests, burst } = resolveLimits(defaults, override);

    const capacity = maxRequests + burst;
    const refillRatePerMs = maxRequests / windowMs;

    const key = bucketKey(clientIp, routeKey);
    const now = Date.now();
    const bucket = getBucket(key, capacity, now);

    refill(bucket, capacity, refillRatePerMs, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: null
      };
    }

    const deficitTokens = 1 - bucket.tokens;
    const msUntilAllowed = deficitTokens / refillRatePerMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(msUntilAllowed / 1000));

    log.warn(
      `rate limit exceeded for ${clientIp}${routeKey ? ` on route ${routeKey}` : ''}`
    );

    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds
    };
  }

  function reset(clientIp, routeKey) {
    buckets.delete(bucketKey(clientIp, routeKey));
  }

  function size() {
    return buckets.size;
  }

  return {
    checkLimit,
    reset,
    size
  };
}