# `ratelimiter.js` — Request Rate Limiting Module

## 1. Overview

The `ratelimiter.js` module implements request rate limiting using the **Token Bucket algorithm**.

Its primary purpose is to prevent a client from sending an excessive number of requests within a given period.

The module supports:

- Global/default rate-limit configuration
- Per-route rate-limit overrides
- Burst capacity
- Client-specific buckets
- Route-specific buckets
- Automatic token refilling
- Retry-after calculation
- Bucket reset
- Active bucket counting
- Logging when a rate limit is exceeded

The main entry point is:

```js
createRateLimiter()
```

The module returns three public operations:

```text
checkLimit()
reset()
size()
```

---

# 2. Rate Limiting Concept

Rate limiting controls how frequently a client can access a service.

For example, a configuration might specify:

```text
100 requests per 60 seconds
```

This means the client should normally be allowed to make approximately 100 requests during that window.

However, real applications often need to support short bursts of traffic.

This module therefore combines:

- `maxRequests` — normal request rate
- `burst` — additional temporary capacity

The effective bucket capacity is:

```text
capacity = maxRequests + burst
```

---

# 3. Token Bucket Algorithm

This module uses a token bucket.

Conceptually:

```text
                 Token Refill
                      │
                      ▼
              ┌───────────────┐
              │     BUCKET    │
              │               │
              │  ● ● ● ● ●    │
              │               │
              └───────┬───────┘
                      │
                  Request
                      │
              ┌───────┴───────┐
              │               │
          Token available   No token
              │               │
              ▼               ▼
            Allow           Reject
              │
              ▼
         Remove 1 token
```

Each allowed request consumes one token.

Tokens are continuously replenished according to the configured rate.

This allows controlled bursts while still enforcing an average request rate.

---

# 4. `resolveLimits()`

```js
function resolveLimits(defaults, override) {
```

## Purpose

Determines which rate-limit configuration should be applied to a request.

It supports both:

- Default/global configuration
- Route-specific overrides

---

## No Override

```js
if (!override) {
  return defaults;
}
```

If the request does not specify an override, the global defaults are returned unchanged.

For example:

```js
defaults = {
  windowMs: 60000,
  maxRequests: 100,
  burst: 20
}
```

will remain unchanged if there is no override.

---

## Applying an Override

```js
return {
  windowMs: override.windowMs || defaults.windowMs,
  maxRequests: override.maxRequests || defaults.maxRequests,
  burst: override.burst != null ? override.burst : defaults.burst
};
```

Each configuration property can be overridden individually.

### `windowMs`

```js
override.windowMs || defaults.windowMs
```

Uses the route-specific window when provided.

Otherwise, the default window is used.

---

### `maxRequests`

```js
override.maxRequests || defaults.maxRequests
```

Uses the route-specific maximum request count when available.

Otherwise, the global value is used.

---

### `burst`

```js
override.burst != null
  ? override.burst
  : defaults.burst
```

The `burst` property is handled differently.

The code explicitly checks for `null` and `undefined`.

This allows values such as:

```text
0
```

to be treated as a valid override.

That is important because:

```js
override.burst || defaults.burst
```

would incorrectly treat `0` as missing.

---

# 5. `bucketKey()`

```js
function bucketKey(clientIp, routeKey) {
```

## Purpose

Creates a unique key for identifying a rate-limit bucket.

---

## Route-Specific Bucket

```js
return routeKey
  ? `${routeKey}::${clientIp}`
  : clientIp;
```

If a route key exists, the bucket key contains both:

```text
route + client IP
```

For example:

```text
/api/users::192.168.1.10
```

This means the same client can have separate rate limits for different routes.

---

## No Route Key

If no route key is provided, the client IP itself is used:

```text
192.168.1.10
```

Therefore, the module can support both:

```text
Client-based limiting
```

and:

```text
Client + route-based limiting
```

---

# 6. `createRateLimiter()`

```js
export function createRateLimiter(ratelimitConfig, logger) {
```

## Purpose

Creates a rate limiter instance using the supplied configuration.

The function also accepts an optional logger.

---

# 7. Logger Initialization

```js
const log = logger || console;
```

If the application provides a custom logger, it is used.

Otherwise, the standard Node.js `console` object is used.

This allows the module to work independently while still supporting the application's logging system.

---

# 8. Default Rate-Limit Configuration

```js
const defaults = {
  windowMs: ratelimitConfig.windowMs,
  maxRequests: ratelimitConfig.maxRequests,
  burst: ratelimitConfig.burst || 0
};
```

The module extracts the default rate-limit configuration.

The three important values are:

| Property | Meaning |
|---|---|
| `windowMs` | Length of the rate-limit window in milliseconds |
| `maxRequests` | Normal number of requests allowed during the window |
| `burst` | Additional temporary request capacity |

If `burst` is not configured, it defaults to:

```text
0
```

---

# 9. Bucket Storage

```js
const buckets = new Map();
```

A JavaScript `Map` stores the rate-limit state for each client or client-route combination.

Conceptually:

```text
Map
│
├── client-A → bucket
├── client-B → bucket
├── route-A::client-A → bucket
└── route-B::client-A → bucket
```

Each bucket contains:

```js
{
  tokens,
  lastRefill
}
```

---

# 10. `getBucket()`

```js
function getBucket(key, capacity, now) {
```

## Purpose

Retrieves an existing token bucket or creates a new one.

---

## Looking Up the Bucket

```js
let bucket = buckets.get(key);
```

The function checks whether a bucket already exists for the supplied key.

---

## Creating a New Bucket

```js
if (!bucket) {
  bucket = {
    tokens: capacity,
    lastRefill: now
  };

  buckets.set(key, bucket);
}
```

When a client is seen for the first time, a new bucket is created.

The bucket starts completely full:

```text
tokens = capacity
```

and its initial refill timestamp is set to the current time.

---

## Returning the Bucket

```js
return bucket;
```

The existing or newly created bucket is returned to the caller.

---

# 11. `refill()`

```js
function refill(bucket, capacity, refillRatePerMs, now) {
```

## Purpose

Adds tokens to a bucket based on how much time has elapsed since the previous refill.

This is the core mechanism that makes the token bucket continuously recover capacity.

---

# 12. Calculating Elapsed Time

```js
const elapsed = now - bucket.lastRefill;
```

The time elapsed since the last refill is calculated in milliseconds.

For example:

```text
Current time:      10,000 ms
Last refill:        7,000 ms

Elapsed:            3,000 ms
```

---

# 13. Preventing Invalid Refills

```js
if (elapsed <= 0) return;
```

If no positive amount of time has passed, there is nothing to refill.

The function returns immediately.

---

# 14. Adding Tokens

```js
bucket.tokens = Math.min(
  capacity,
  bucket.tokens + elapsed * refillRatePerMs
);
```

The number of tokens added is:

```text
elapsed time × refill rate
```

However, the number of tokens can never exceed the bucket's maximum capacity.

`Math.min()` enforces that limit.

---

## Example

Suppose:

```text
capacity = 120
current tokens = 80
refill rate = 0.001 tokens/ms
elapsed = 10,000 ms
```

Then:

```text
new tokens
= 80 + (10,000 × 0.001)
= 90
```

The bucket becomes:

```text
90 tokens
```

---

# 15. Updating the Refill Timestamp

```js
bucket.lastRefill = now;
```

After refilling, the current timestamp becomes the new reference point.

This prevents the same elapsed period from being counted again.

---

# 16. `checkLimit()`

```js
function checkLimit(clientIp, options = {}) {
```

## Purpose

Checks whether a request from a client should be allowed.

This is the primary function used by the application for rate limiting.

---

# 17. Reading Request Options

```js
const { routeKey, override } = options;
```

The caller can optionally provide:

- `routeKey`
- `override`

Example:

```js
{
  routeKey: '/api/login',
  override: {
    maxRequests: 10
  }
}
```

---

# 18. Resolving the Applicable Limits

```js
const {
  windowMs,
  maxRequests,
  burst
} = resolveLimits(defaults, override);
```

The module determines whether the request should use:

- Global defaults
- Route-specific values

---

# 19. Calculating Bucket Capacity

```js
const capacity = maxRequests + burst;
```

The bucket's maximum token count is:

```text
capacity = maxRequests + burst
```

For example:

```text
maxRequests = 100
burst = 20
```

results in:

```text
capacity = 120
```

Therefore, a newly created bucket can initially handle up to 120 immediate requests before becoming empty.

---

# 20. Calculating Refill Rate

```js
const refillRatePerMs = maxRequests / windowMs;
```

This determines how quickly tokens are replenished.

For example:

```text
maxRequests = 60
windowMs = 60,000 ms
```

gives:

```text
60 / 60,000
= 0.001 tokens/ms
```

Equivalent to:

```text
1 token every 1,000 ms
```

or:

```text
1 request per second
```

The important point is that the **normal request rate** determines the refill rate, while `burst` increases temporary capacity.

---

# 21. Creating the Bucket Key

```js
const key = bucketKey(clientIp, routeKey);
```

The key uniquely identifies which bucket belongs to the request.

Examples:

```text
192.168.1.20
```

or:

```text
/api/login::192.168.1.20
```

---

# 22. Getting the Current Time

```js
const now = Date.now();
```

The current timestamp is used for calculating token refills.

---

# 23. Retrieving the Bucket

```js
const bucket = getBucket(key, capacity, now);
```

If the client has never been seen before, a new full bucket is created.

Otherwise, the existing bucket is reused.

---

# 24. Refilling Before Checking

```js
refill(
  bucket,
  capacity,
  refillRatePerMs,
  now
);
```

Before deciding whether to allow the request, the module first restores any tokens that should have accumulated since the previous check.

This means rate limiting is based on elapsed time rather than requiring a periodic background process.

---

# 25. Checking Token Availability

```js
if (bucket.tokens >= 1) {
```

A request requires at least one complete token.

If the bucket contains one or more tokens, the request is allowed.

---

# 26. Consuming a Token

```js
bucket.tokens -= 1;
```

One token is consumed for the current request.

For example:

```text
Before request:
10 tokens

After request:
9 tokens
```

---

# 27. Successful Rate-Limit Response

```js
return {
  allowed: true,
  remaining: Math.floor(bucket.tokens),
  retryAfterSeconds: null
};
```

When the request is allowed, the function returns:

```js
{
  allowed: true,
  remaining: <remaining tokens>,
  retryAfterSeconds: null
}
```

### `allowed`

Indicates whether the request can proceed.

```text
true
```

means the request is allowed.

### `remaining`

Shows the number of complete tokens remaining.

`Math.floor()` ensures that a fractional token is not reported as a usable full request.

### `retryAfterSeconds`

This is:

```text
null
```

because the request does not need to wait.

---

# 28. Handling an Empty Bucket

If:

```js
bucket.tokens < 1
```

the request cannot consume a token.

The function calculates how long the client needs to wait before another token becomes available.

---

# 29. Calculating the Token Deficit

```js
const deficitTokens = 1 - bucket.tokens;
```

If the bucket contains:

```text
0.25 tokens
```

then the missing amount is:

```text
1 - 0.25
= 0.75 tokens
```

The client needs 0.75 additional tokens before the next request can be allowed.

---

# 30. Calculating Wait Time

```js
const msUntilAllowed =
  deficitTokens / refillRatePerMs;
```

The required wait time is calculated from:

```text
required tokens ÷ refill rate
```

For example:

```text
deficit = 0.5 tokens
refill rate = 0.001 tokens/ms
```

gives:

```text
0.5 / 0.001
= 500 ms
```

So the client needs to wait approximately half a second.

---

# 31. Calculating `retryAfterSeconds`

```js
const retryAfterSeconds = Math.max(
  1,
  Math.ceil(msUntilAllowed / 1000)
);
```

The wait time is converted from milliseconds to seconds.

`Math.ceil()` rounds upward because the client should not retry before enough tokens are actually available.

`Math.max(1, ...)` ensures the returned value is never less than one second.

---

# 32. Logging Rate-Limit Violations

```js
log.warn(
  `rate limit exceeded for ${clientIp}${
    routeKey ? ` on route ${routeKey}` : ''
  }`
);
```

When a request is rejected, a warning is logged.

Without a route:

```text
rate limit exceeded for 192.168.1.20
```

With a route:

```text
rate limit exceeded for 192.168.1.20 on route /api/login
```

This can help with monitoring and debugging excessive traffic.

---

# 33. Rejected Request Response

```js
return {
  allowed: false,
  remaining: 0,
  retryAfterSeconds
};
```

When the rate limit is exceeded, the caller receives:

```js
{
  allowed: false,
  remaining: 0,
  retryAfterSeconds: <seconds>
}
```

The surrounding HTTP server can use this information to return an appropriate rate-limit response, such as HTTP `429 Too Many Requests`.

---

# 34. `reset()`

```js
function reset(clientIp, routeKey) {
```

## Purpose

Deletes the rate-limit bucket for a specific client or client-route combination.

---

## Removing the Bucket

```js
buckets.delete(
  bucketKey(clientIp, routeKey)
);
```

After deletion, the next request creates a fresh bucket.

Because new buckets start with full capacity, resetting effectively clears the client's current rate-limit state.

This can be useful for:

- Administrative resets
- Testing
- Session changes
- Manual recovery
- Special application workflows

---

# 35. `size()`

```js
function size() {
  return buckets.size;
}
```

## Purpose

Returns the number of currently stored rate-limit buckets.

For example:

```text
size() → 25
```

means the limiter currently tracks 25 distinct bucket keys.

This can be useful for:

- Monitoring memory usage
- Diagnostics
- Tests
- Observability

---

# 36. Public API

The function returns:

```js
return {
  checkLimit,
  reset,
  size
};
```

Therefore, external code can use:

| Function | Purpose |
|---|---|
| `checkLimit()` | Determine whether a request is allowed |
| `reset()` | Remove a client's rate-limit bucket |
| `size()` | Return the number of active buckets |

The internal implementation details remain private.

---

# 37. Complete Request Flow

The complete process for a request is:

```text
Incoming Request
       │
       ▼
Extract Client IP
       │
       ▼
Determine Route
       │
       ▼
Resolve Default/Route Limits
       │
       ▼
Calculate Capacity
(maxRequests + burst)
       │
       ▼
Calculate Refill Rate
(maxRequests / windowMs)
       │
       ▼
Get Client Bucket
       │
       ▼
Refill Bucket
       │
       ▼
Does bucket have ≥ 1 token?
       │
   ┌───┴────┐
  Yes       No
   │         │
   ▼         ▼
Consume    Calculate
1 token    retry time
   │         │
   ▼         ▼
Allow      Reject
Request    Request
```

---

# 38. Example

Suppose the configuration is:

```js
{
  windowMs: 60000,
  maxRequests: 100,
  burst: 20
}
```

This produces:

```text
Normal rate:       100 requests / 60 seconds
Burst capacity:    20
Bucket capacity:   120 tokens
```

A new client starts with:

```text
120 tokens
```

If the client immediately sends 20 requests:

```text
120 → 100 tokens
```

The client still has its normal 100-token allowance.

As time passes, tokens are replenished at:

```text
100 / 60,000
```

tokens per millisecond.

---

# 39. Burst Behavior

The `burst` setting allows temporary traffic spikes.

For:

```text
maxRequests = 100
burst = 20
```

the bucket can temporarily contain:

```text
120 tokens
```

This means a client can make a short burst beyond the normal 100-request capacity.

However, the refill rate remains based on:

```text
100 requests / window
```

rather than:

```text
120 requests / window
```

Therefore, burst capacity does not permanently increase the normal request rate.

---

# 40. Route-Specific Limiting

The module can maintain separate buckets for different routes.

For example:

```text
/api/login::10.0.0.5
/api/users::10.0.0.5
/api/search::10.0.0.5
```

These are three different buckets.

Therefore, heavy traffic against `/api/search` does not automatically consume the bucket for `/api/login`.

This is useful when sensitive endpoints need stricter limits.

For example:

```text
/api/login
10 requests/minute

/api/products
100 requests/minute
```

---

# 41. Global vs Route-Specific Configuration

The module uses this hierarchy:

```text
Route-specific override
          │
          ▼
    If provided
          │
          ▼
      Use it
          │
          │ otherwise
          ▼
   Global defaults
```

For example:

```js
defaults = {
  windowMs: 60000,
  maxRequests: 100,
  burst: 20
}
```

A route may override only:

```js
{
  maxRequests: 10
}
```

The resulting configuration becomes conceptually:

```js
{
  windowMs: 60000,
  maxRequests: 10,
  burst: 20
}
```

Only the specified property is changed.

---

# 42. Why a `Map` Is Used

The module stores buckets in:

```js
const buckets = new Map();
```

A `Map` provides efficient key-based lookup.

Each request can quickly find its associated bucket using:

```js
buckets.get(key)
```

and reset it using:

```js
buckets.delete(key)
```

This makes it suitable for an in-memory rate limiter.

---

# 43. In-Memory Nature

The rate-limit state exists only inside the current process.

For example:

```text
Application Process
       │
       └── buckets Map
             ├── Client A
             ├── Client B
             └── Client C
```

If the process restarts, the `Map` is recreated and all bucket state is lost.

Similarly, if the application is running on multiple server instances:

```text
Server 1 → own buckets
Server 2 → own buckets
Server 3 → own buckets
```

each instance maintains independent rate-limit state unless a shared external storage mechanism is introduced.

---

# 44. Important Implementation Detail: Fractional Tokens

The module allows fractional token values.

For example:

```text
bucket.tokens = 0.35
```

This is intentional.

Continuous refilling allows the limiter to calculate precise waiting times instead of only refilling tokens in fixed integer intervals.

However, a request requires:

```text
tokens >= 1
```

Therefore, fractional tokens cannot directly allow a request.

---

# 45. Retry Calculation

When no token is available:

```text
Current tokens
      │
      ▼
Calculate deficit
      │
      ▼
Divide by refill rate
      │
      ▼
Milliseconds until next token
      │
      ▼
Convert to seconds
      │
      ▼
retryAfterSeconds
```

This allows the caller to tell the client approximately how long it should wait before retrying.

---

# 46. Logging and Observability

The module logs only when the rate limit is exceeded:

```js
log.warn(...)
```

This prevents normal successful requests from generating unnecessary warning logs.

The logger is configurable:

```js
createRateLimiter(config, logger)
```

If no logger is supplied:

```js
console
```

is used.

This allows the module to integrate with a project's centralized logging system.

---

# 47. Edge Cases Handled

The implementation handles several important situations.

### Missing Override

Falls back to global defaults.

### Missing Burst

Defaults to zero.

### Zero Burst Override

Correctly preserves `0` because the code uses:

```js
override.burst != null
```

rather than a simple truthiness check.

### New Client

Creates a fresh full bucket.

### Empty Bucket

Rejects the request and calculates retry time.

### Reset Client

Deletes the client's bucket.

### Route-Specific Client

Creates an independent bucket using:

```text
routeKey::clientIp
```

---

# 48. Overall Architecture

```text
                 createRateLimiter()
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
       Configuration              buckets Map
             │                       │
             ▼                       ▼
     resolveLimits()             getBucket()
                                     │
                                     ▼
                                  refill()
                                     │
                                     ▼
                               checkLimit()
                              /            \
                             /              \
                       Token available    No token
                           │                  │
                           ▼                  ▼
                      Consume token       Calculate retry
                           │                  │
                           ▼                  ▼
                         Allow              Reject
```

Additional management operations:

```text
reset() ──→ Delete bucket

size() ──→ Count buckets
```

---

# 49. Function Summary

| Function | Visibility | Responsibility |
|---|---|---|
| `resolveLimits()` | Internal | Merge default and route-specific limits |
| `bucketKey()` | Internal | Generate a unique bucket identifier |
| `createRateLimiter()` | Exported | Create a rate limiter instance |
| `getBucket()` | Internal | Retrieve or create a token bucket |
| `refill()` | Internal | Replenish tokens based on elapsed time |
| `checkLimit()` | Public | Allow or reject a request |
| `reset()` | Public | Remove a client's bucket |
| `size()` | Public | Return bucket count |

---

# 50. Summary

`ratelimiter.js` provides an in-memory, token-bucket-based rate-limiting mechanism.

Its key responsibilities are:

1. Maintain a separate bucket for each client or client-route combination.
2. Allow a configurable number of requests during a time window.
3. Support additional burst capacity.
4. Refill tokens continuously based on elapsed time.
5. Support route-specific rate-limit overrides.
6. Reject requests when no token is available.
7. Calculate an appropriate retry delay.
8. Log rate-limit violations.
9. Allow individual buckets to be reset.
10. Provide the number of currently tracked buckets.

The central algorithm can be summarized as:

```text
             maxRequests
                  │
                  ▼
          Calculate refill rate
                  │
                  ▼
        ┌───────────────────┐
        │    Token Bucket   │
        │                   │
        │ ● ● ● ● ● ● ●     │
        └─────────┬─────────┘
                  │
             Incoming Request
                  │
          ┌───────┴────────┐
          │                │
       ≥ 1 token        < 1 token
          │                │
          ▼                ▼
       Consume 1       Calculate wait
          │                │
          ▼                ▼
        ALLOW            REJECT
```

In short, **`ratelimiter.js` protects the application from excessive request traffic by using per-client token buckets, configurable request rates, burst capacity, route-specific overrides, and calculated retry delays.**