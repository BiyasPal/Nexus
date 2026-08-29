# `healthcheck.js` — Backend Health Check Module

## 1. Overview

The `healthcheck.js` module is responsible for continuously monitoring the health and availability of backend servers.

It performs HTTP or HTTPS health checks against configured backend URLs and maintains the health status of each backend. Based on consecutive successful or failed health checks, a backend can automatically transition between:

- **Healthy**
- **Unhealthy**

The module also provides utility functions for:

- Starting periodic health checks
- Stopping periodic health checks
- Performing an immediate health-check cycle
- Checking whether a specific backend is healthy
- Retrieving all healthy backends from a pool
- Getting a complete health-status snapshot
- Immediately marking a backend as unhealthy when an external request failure occurs

This module is particularly useful in a backend load-balancing or API gateway system where traffic should only be routed to available backend servers.

---

# 2. Imported Modules

```js
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
```

### `node:http`

The built-in Node.js HTTP module is used to perform health checks against backends using the `http://` protocol.

### `node:https`

The built-in HTTPS module is used when the backend uses the `https://` protocol.

### `URL`

The Node.js `URL` class is used to safely construct the final health-check URL from:

- The backend's base URL
- The configured health-check path

For example:

```text
Backend URL: http://localhost:8000
Check path: /health

Final URL:
http://localhost:8000/health
```

---

# 3. `keyFor()`

```js
function keyFor(poolName, backendUrl) {
  return `${poolName}::${backendUrl}`;
}
```

## Purpose

`keyFor()` generates a unique key for identifying a backend inside the internal health-state `Map`.

### Parameters

| Parameter | Description |
|---|---|
| `poolName` | Name of the backend pool |
| `backendUrl` | URL of the backend |

### Return Value

Returns a string in the following format:

```text
poolName::backendUrl
```

### Example

```js
keyFor('users', 'http://localhost:8000');
```

produces:

```text
users::http://localhost:8000
```

## Why this is needed

A backend URL alone may not be enough to uniquely identify a backend because different backend pools could contain the same URL.

Combining the pool name and URL creates a unique identifier for the internal state map.

---

# 4. `pingBackend()`

```js
export function pingBackend(backendUrl, checkPath, timeoutMs) {
```

## Purpose

`pingBackend()` performs a single health check against a backend.

It sends an HTTP `GET` request to the configured health-check endpoint and determines whether the backend responded successfully.

The function returns a `Promise` because network requests are asynchronous.

---

## Parameters

| Parameter | Description |
|---|---|
| `backendUrl` | Base URL of the backend |
| `checkPath` | Health-check endpoint path |
| `timeoutMs` | Maximum time allowed for the request |

---

## URL Construction

```js
let target;
try {
  target = new URL(checkPath, backendUrl);
} catch (err) {
  resolve({ ok: false, error: err });
  return;
}
```

The `URL` constructor combines the backend URL and health-check path.

For example:

```text
backendUrl = http://localhost:8000
checkPath = /health
```

results in:

```text
http://localhost:8000/health
```

If the URL is invalid, the function does not throw the error to the caller. Instead, it resolves the Promise with:

```js
{
  ok: false,
  error: err
}
```

This allows the health-check system to treat an invalid URL as a failed health check.

---

# 5. Selecting HTTP or HTTPS

```js
const client = target.protocol === 'https:' ? https : http;
```

The module dynamically chooses the correct Node.js client based on the target URL.

If the URL is:

```text
https://example.com
```

the `https` client is used.

If the URL is:

```text
http://localhost:8000
```

the `http` client is used.

This allows the same health-check function to support both HTTP and HTTPS backends.

---

# 6. Sending the Health Check Request

```js
const req = client.get(target, { timeout: timeoutMs }, (res) => {
  res.resume();
  resolve({
    ok: res.statusCode >= 200 && res.statusCode < 400,
    statusCode: res.statusCode
  });
});
```

A `GET` request is sent to the backend's health-check endpoint.

### `res.resume()`

```js
res.resume();
```

The response body is not required for the health check.

Calling `resume()` consumes and discards the response data so that the response stream can finish properly.

### Determining Health

```js
ok: res.statusCode >= 200 && res.statusCode < 400
```

A backend is considered healthy when it returns an HTTP status code from:

```text
200–399
```

Therefore:

| Status Code | Result |
|---|---|
| 200 | Healthy |
| 201 | Healthy |
| 301 | Healthy |
| 302 | Healthy |
| 399 | Healthy |
| 400 | Unhealthy |
| 404 | Unhealthy |
| 500 | Unhealthy |

The response also includes the actual status code.

Example:

```js
{
  ok: true,
  statusCode: 200
}
```

---

# 7. Request Timeout Handling

```js
req.on('timeout', () => {
  req.destroy(new Error(`health check timed out after ${timeoutMs}ms`));
});
```

If the backend does not respond within the configured timeout period, the request is destroyed.

An error is generated containing the timeout duration.

This prevents the health-check process from waiting indefinitely for an unavailable backend.

---

# 8. Request Error Handling

```js
req.on('error', (err) => {
  resolve({ ok: false, error: err });
});
```

Network errors such as:

- Connection refused
- DNS failure
- Connection reset
- Timeout-triggered destruction

are handled here.

Instead of allowing the error to crash the health-check process, the function resolves with:

```js
{
  ok: false,
  error: err
}
```

The backend is therefore treated as having failed its health check.

---

# 9. `createHealthChecker()`

```js
export function createHealthChecker(backends, healthcheckConfig, logger) {
```

## Purpose

`createHealthChecker()` creates a complete health-check manager for all configured backend pools.

It maintains the health state of every backend and returns an object containing functions that can control and query the health-check system.

---

## Parameters

| Parameter | Description |
|---|---|
| `backends` | Object containing backend pools |
| `healthcheckConfig` | Health-check configuration |
| `logger` | Optional logging object |

A typical configuration may contain:

```js
{
  path: '/health',
  intervalMs: 5000,
  unhealthyThreshold: 3,
  healthyThreshold: 2,
  timeoutMs: 2000
}
```

---

# 10. Logger Initialization

```js
const log = logger || console;
```

If a custom logger is provided, it is used.

Otherwise, the standard Node.js `console` object is used.

This allows the module to work with both:

- Custom application logging systems
- Standard console logging

---

# 11. Reading Health-Check Configuration

```js
const checkPath = healthcheckConfig.path;
const intervalMs = healthcheckConfig.intervalMs;
const unhealthyThreshold = healthcheckConfig.unhealthyThreshold;
const healthyThreshold = healthcheckConfig.healthyThreshold;
const timeoutMs = healthcheckConfig.timeoutMs || intervalMs;
```

These values control the health-check behavior.

### `checkPath`

The endpoint used for checking backend health.

Example:

```text
/health
```

### `intervalMs`

Defines how frequently health checks are performed.

For example:

```text
5000 ms = every 5 seconds
```

### `unhealthyThreshold`

Defines how many consecutive failures are required before a healthy backend is marked unhealthy.

### `healthyThreshold`

Defines how many consecutive successful checks are required before an unhealthy backend becomes healthy again.

### `timeoutMs`

Defines how long each health-check request is allowed to run.

If it is not configured:

```js
healthcheckConfig.timeoutMs || intervalMs
```

the interval value is used as the timeout.

---

# 12. Backend Health State

```js
const state = new Map();
```

The module uses a JavaScript `Map` to maintain the current health information of every backend.

Each backend gets an entry containing:

```js
{
  poolName,
  url,
  healthy: true,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0
}
```

### Meaning of Each Property

| Property | Purpose |
|---|---|
| `poolName` | Backend pool containing the backend |
| `url` | Backend URL |
| `healthy` | Current health status |
| `consecutiveFailures` | Number of failures in a row |
| `consecutiveSuccesses` | Number of successful checks in a row |

Every backend starts with:

```js
healthy: true
```

and both counters set to `0`.

---

# 13. Initializing Backend State

```js
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
```

This nested loop goes through every backend pool and every backend inside each pool.

For each backend, an entry is added to the `state` map.

### Example

Suppose:

```js
backends = {
  users: [
    { url: 'http://localhost:8001' },
    { url: 'http://localhost:8002' }
  ],
  payments: [
    { url: 'http://localhost:9001' }
  ]
};
```

The module creates health state for all three backends.

---

# 14. Timer

```js
let timer = null;
```

The `timer` variable stores the interval returned by `setInterval()`.

It is initially `null`, meaning health-check polling has not started.

---

# 15. `transition()`

```js
function transition(entry, healthy) {
```

## Purpose

`transition()` changes a backend's health status and logs the transition.

---

## Preventing Unnecessary Transitions

```js
if (entry.healthy === healthy) return;
```

If the backend is already in the requested state, nothing happens.

For example, if the backend is already healthy and another successful health check occurs, the function does not log another "healthy" transition.

---

## Updating the State

```js
entry.healthy = healthy;
```

The backend's health status is updated.

---

## Healthy Transition

```js
if (healthy) {
  log.info(`backend ${entry.url} (${entry.poolName}) is now healthy`);
}
```

When a backend recovers, an informational log is generated.

---

## Unhealthy Transition

```js
else {
  log.warn(`backend ${entry.url} (${entry.poolName}) is now unhealthy`);
}
```

When a backend becomes unavailable, a warning is logged.

---

# 16. `recordResult()`

```js
function recordResult(entry, ok) {
```

## Purpose

`recordResult()` processes the result of a health check and updates the backend's consecutive success/failure counters.

This function is responsible for applying the configured health thresholds.

---

# 17. Successful Health Check

```js
if (ok) {
  entry.consecutiveSuccesses += 1;
  entry.consecutiveFailures = 0;
```

When a health check succeeds:

1. The success counter increases.
2. The failure counter is reset to zero.

This ensures that only **consecutive** successes count toward recovery.

---

## Recovering an Unhealthy Backend

```js
if (!entry.healthy && entry.consecutiveSuccesses >= healthyThreshold) {
  transition(entry, true);
}
```

If the backend is currently unhealthy, it is not immediately marked healthy after one successful request.

Instead, it must pass the configured number of consecutive health checks.

For example:

```text
healthyThreshold = 2
```

The backend must successfully respond twice in a row before being marked healthy.

This helps prevent unstable backends from repeatedly switching between healthy and unhealthy states.

---

# 18. Failed Health Check

```js
else {
  entry.consecutiveFailures += 1;
  entry.consecutiveSuccesses = 0;
```

When a health check fails:

1. The failure counter increases.
2. The success counter is reset.

Again, only consecutive failures count.

---

## Marking a Backend Unhealthy

```js
if (entry.healthy && entry.consecutiveFailures >= unhealthyThreshold) {
  transition(entry, false);
}
```

A backend that is currently healthy becomes unhealthy only after reaching the configured failure threshold.

For example:

```text
unhealthyThreshold = 3
```

means the backend must fail three consecutive health checks before being marked unhealthy.

---

# 19. Health State Transition Example

Suppose:

```text
unhealthyThreshold = 3
healthyThreshold = 2
```

A healthy backend receives:

```text
Failure → still healthy
Failure → still healthy
Failure → unhealthy
```

After becoming unhealthy:

```text
Success → still unhealthy
Success → healthy
```

This threshold-based approach prevents temporary network problems from causing unnecessary backend state changes.

---

# 20. `pollOnce()`

```js
async function pollOnce() {
```

## Purpose

`pollOnce()` performs one complete health-check cycle for all registered backends.

---

## Creating Health Check Promises

```js
const checks = [];
```

An array is created to store all health-check promises.

---

## Checking Every Backend

```js
for (const entry of state.values()) {
  checks.push(
    pingBackend(entry.url, checkPath, timeoutMs).then((result) => {
      recordResult(entry, result.ok);
    })
  );
}
```

Every backend in the `state` map is checked.

For each backend:

1. `pingBackend()` sends the health request.
2. The result is received.
3. `recordResult()` updates the backend state.

---

# 21. Parallel Health Checks

```js
await Promise.all(checks);
```

All backend health checks are allowed to run concurrently.

This is important because the system does not have to wait for one backend before checking the next one.

For example, if there are three backends:

```text
Backend A ────────┐
Backend B ────────┤── checked concurrently
Backend C ────────┘
```

This makes the health-check cycle more efficient.

---

# 22. `start()`

```js
function start() {
```

## Purpose

Starts periodic health-check polling.

---

## Preventing Multiple Timers

```js
if (timer) return;
```

If the health checker is already running, `start()` does nothing.

This prevents accidentally creating multiple polling intervals.

---

## Creating the Interval

```js
timer = setInterval(() => {
  pollOnce().catch((err) => {
    log.error(`health check poll failed: ${err.message}`);
  });
}, intervalMs);
```

`setInterval()` schedules `pollOnce()` repeatedly.

The interval is controlled by:

```js
intervalMs
```

If:

```text
intervalMs = 5000
```

a new health-check cycle starts every five seconds.

---

# 23. `timer.unref()`

```js
if (timer.unref) timer.unref();
```

Node.js timers normally keep the process alive.

Calling `unref()` allows the Node.js process to exit naturally if nothing else is keeping it alive.

This is useful for applications where the health-check timer should not prevent graceful process termination.

The conditional check:

```js
if (timer.unref)
```

ensures that the method is called only when available.

---

# 24. `stop()`

```js
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
```

## Purpose

Stops periodic health checking.

### `clearInterval()`

Cancels the interval created by `start()`.

### Resetting the Timer

```js
timer = null;
```

This indicates that the health checker is no longer running.

It also allows `start()` to be called again later.

---

# 25. `isHealthy()`

```js
function isHealthy(poolName, backendUrl) {
```

## Purpose

Checks the current health status of a specific backend.

---

## Finding the Backend

```js
const entry = state.get(keyFor(poolName, backendUrl));
```

The same key-generation function used during initialization is used to retrieve the backend's state.

---

## Returning the Health Status

```js
return entry ? entry.healthy : false;
```

If the backend exists, its `healthy` value is returned.

If the backend is not registered, the function returns:

```js
false
```

This is a safe default because an unknown backend should not be considered available for traffic.

---

# 26. `getHealthyBackends()`

```js
function getHealthyBackends(poolName) {
```

## Purpose

Returns only the currently healthy backends belonging to a specific pool.

---

## Selecting the Pool

```js
const pool = backends[poolName] || [];
```

If the requested pool exists, its backends are retrieved.

If the pool does not exist, an empty array is used.

---

## Filtering Healthy Backends

```js
return pool.filter((backend) => isHealthy(poolName, backend.url));
```

Each backend is checked using `isHealthy()`.

Only backends whose health status is `true` are returned.

### Example

If a pool contains:

```text
Backend A → healthy
Backend B → unhealthy
Backend C → healthy
```

the function returns:

```text
Backend A
Backend C
```

This is especially useful for request routing and load balancing.

---

# 27. `getStatusSnapshot()`

```js
function getStatusSnapshot() {
```

## Purpose

Creates a complete snapshot of the health status of all backend pools.

---

## Snapshot Object

```js
const snapshot = {};
```

The result is built as a normal JavaScript object.

---

## Grouping Backends by Pool

```js
for (const entry of state.values()) {
  if (!snapshot[entry.poolName]) {
    snapshot[entry.poolName] = [];
  }
  snapshot[entry.poolName].push({
    url: entry.url,
    healthy: entry.healthy
  });
}
```

Every backend is added under its corresponding pool.

### Example Result

```js
{
  users: [
    {
      url: 'http://localhost:8001',
      healthy: true
    },
    {
      url: 'http://localhost:8002',
      healthy: false
    }
  ],
  payments: [
    {
      url: 'http://localhost:9001',
      healthy: true
    }
  ]
}
```

This snapshot can be useful for:

- Monitoring
- Debugging
- Health/status APIs
- Logging
- Administrative dashboards

---

# 28. `reportFailure()`

```js
function reportFailure(poolName, backendUrl) {
```

## Purpose

`reportFailure()` allows another part of the application to immediately report that a backend has failed.

This is different from waiting for the next scheduled health check.

For example, if the load balancer sends a request to a backend and the connection fails, it can call:

```js
reportFailure(poolName, backendUrl);
```

---

## Finding the Backend

```js
const entry = state.get(keyFor(poolName, backendUrl));
if (!entry) return;
```

If the backend does not exist in the health state, the function simply returns.

---

## Resetting Successes

```js
entry.consecutiveSuccesses = 0;
```

Any previous successful streak is discarded because a real request failure has occurred.

---

## Forcing the Failure Threshold

```js
entry.consecutiveFailures = Math.max(
  entry.consecutiveFailures,
  unhealthyThreshold
);
```

The failure counter is forced to at least the configured unhealthy threshold.

For example, if:

```text
unhealthyThreshold = 3
consecutiveFailures = 1
```

the counter becomes:

```text
3
```

This effectively tells the health-check system that the backend has reached the failure threshold.

---

## Immediate Transition to Unhealthy

```js
if (entry.healthy) {
  transition(entry, false);
}
```

If the backend is currently healthy, it is immediately marked unhealthy.

This allows real request failures to influence backend availability without waiting for scheduled health checks.

---

# 29. Returned Health Checker API

At the end of `createHealthChecker()`, the following object is returned:

```js
return {
  start,
  stop,
  pollOnce,
  isHealthy,
  getHealthyBackends,
  getStatusSnapshot,
  reportFailure
};
```

This exposes the internal functionality while keeping implementation details private.

The following functions become available to the caller:

| Function | Purpose |
|---|---|
| `start()` | Start periodic health checks |
| `stop()` | Stop periodic health checks |
| `pollOnce()` | Perform one health-check cycle immediately |
| `isHealthy()` | Check one backend's health |
| `getHealthyBackends()` | Get healthy backends from a pool |
| `getStatusSnapshot()` | Get health status of all backends |
| `reportFailure()` | Immediately mark a backend unhealthy |

Functions such as `transition()`, `recordResult()`, and the `state` map remain internal to the health checker.

---

# 30. Overall Execution Flow

The complete lifecycle of this module can be summarized as:

```text
createHealthChecker()
        │
        ▼
Initialize backend health state
        │
        ▼
start()
        │
        ▼
setInterval()
        │
        ▼
pollOnce()
        │
        ├───────────────┐
        ▼               ▼
Backend A           Backend B
        │               │
        ▼               ▼
pingBackend()       pingBackend()
        │               │
        └───────┬───────┘
                ▼
          recordResult()
                │
        ┌───────┴────────┐
        ▼                ▼
 Consecutive          Consecutive
 failures             successes
        │                │
        ▼                ▼
  Unhealthy           Healthy
```

The process repeats according to `intervalMs`.

---

# 31. Health State Management Strategy

The module uses a **consecutive result threshold strategy** instead of changing the backend state after every individual request.

### Failure Path

```text
Healthy
   │
   ├── Failure
   │
   ├── Failure
   │
   └── Failure >= unhealthyThreshold
             │
             ▼
         Unhealthy
```

### Recovery Path

```text
Unhealthy
    │
    ├── Success
    │
    └── Success >= healthyThreshold
              │
              ▼
           Healthy
```

This provides stability against temporary network failures and brief backend outages.

---

# 32. Important Design Characteristics

## 32.1 Supports HTTP and HTTPS

The module automatically selects the appropriate Node.js client based on the backend URL.

## 32.2 Concurrent Health Checks

`Promise.all()` allows multiple backend checks to execute concurrently.

## 32.3 Configurable Failure Threshold

A backend does not immediately become unhealthy after a single failed check unless the configured threshold requires only one failure.

## 32.4 Configurable Recovery Threshold

An unhealthy backend must successfully pass the configured number of consecutive checks before being restored.

## 32.5 Timeout Protection

Every health check has a maximum allowed duration.

## 32.6 External Failure Reporting

`reportFailure()` allows the request-routing layer to mark a backend unhealthy immediately.

## 32.7 Encapsulated Internal State

The `state` map and internal helper functions are hidden inside `createHealthChecker()`.

Only the intended public API is returned.

---

# 33. Example Usage

A higher-level application can create a health checker like this:

```js
const healthChecker = createHealthChecker(
  backends,
  {
    path: '/health',
    intervalMs: 5000,
    unhealthyThreshold: 3,
    healthyThreshold: 2,
    timeoutMs: 2000
  },
  console
);
```

The checker can then be started:

```js
healthChecker.start();
```

Healthy backends can be retrieved:

```js
const healthyBackends =
  healthChecker.getHealthyBackends('users');
```

The current health status can be inspected:

```js
const status =
  healthChecker.getStatusSnapshot();
```

And the checker can eventually be stopped:

```js
healthChecker.stop();
```

---

# 34. Relationship with a Load Balancer / Gateway

In a gateway or load-balancer architecture, this module can work as the backend availability layer.

For example:

```text
                    Client
                       │
                       ▼
                API Gateway
                       │
                Health Checker
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Backend A    Backend B    Backend C
       Healthy     Unhealthy     Healthy
          │                         │
          └──────────┬──────────────┘
                     ▼
              Available Pool
```

The gateway can call:

```js
getHealthyBackends(poolName)
```

and route requests only to the returned backends.

If a backend starts failing, the health checker removes it from the available set by changing its health state to `false`.

When the backend recovers and passes the required number of consecutive health checks, it becomes available again.

---

# 35. Summary

`healthcheck.js` provides the backend availability and monitoring mechanism for the application.

Its main responsibilities are:

1. Construct health-check URLs.
2. Send HTTP/HTTPS health-check requests.
3. Handle request errors and timeouts.
4. Maintain health state for every backend.
5. Track consecutive successes and failures.
6. Automatically transition backends between healthy and unhealthy states.
7. Periodically check all backends.
8. Provide only healthy backends to the rest of the application.
9. Expose a complete backend health snapshot.
10. Allow external request failures to immediately mark a backend unhealthy.

In short, **this module acts as the application's backend health-monitoring layer, ensuring that unhealthy servers can be detected and excluded from request routing while recovered servers can automatically be brought back into service.**