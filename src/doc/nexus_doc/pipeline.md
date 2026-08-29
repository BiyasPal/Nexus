# Nexus Request Pipeline Explained

## 1. What does this file do?

This file is the **central request handler** of Nexus.

It connects:

* Router
* Load balancer
* Rate limiter
* Authenticator
* Health checker
* WAL
* Metrics
* Logger
* Dashboard

and controls the order in which they process an incoming request.

The most important responsibility of this file is:

> **Make sure every request goes through the correct processing stages in the correct order.**

The pipeline is:

```text
Request
   │
   ▼
Dashboard check
   │
   ▼
Rate limiting
   │
   ▼
Route matching
   │
   ▼
Authentication
   │
   ▼
Backend selection
   │
   ▼
Forward request
   │
   ▼
Backend
   │
   ▼
Response
```

---

# 2. What does the code FIRST do?

The first thing in the file is importing Node.js modules:

```js
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
```

These provide the functionality needed by the pipeline.

### `http`

Used when Nexus forwards a request to an HTTP backend.

```text
http://localhost:9001
```

### `https`

Used when Nexus forwards a request to an HTTPS backend.

```text
https://backend.example.com
```

### `crypto`

Used to generate a unique request ID:

```js
crypto.randomUUID()
```

### `URL`

Used to safely parse and construct URLs.

---

# 3. Required Dependencies

Next:

```js
const REQUIRED_DEPS = [
  'config',
  'metrics',
  'router',
  'loadBalancer',
  'rateLimiter',
  'authenticator'
];
```

This defines the modules that the pipeline absolutely needs.

Conceptually:

```text
Pipeline requires:

config
metrics
router
loadBalancer
rateLimiter
authenticator
```

Without these, the pipeline cannot work correctly.

---

# 4. `assertDeps()`

The next function checks those dependencies:

```js
function assertDeps(deps) {
  for (const key of REQUIRED_DEPS) {
    if (!deps[key]) {
      throw new Error(`createPipeline requires a "${key}" dependency`);
    }
  }
}
```

Suppose the application creates the pipeline like this:

```js
createPipeline({
  config,
  metrics,
  router,
  loadBalancer,
  rateLimiter
});
```

The `authenticator` is missing.

The code immediately throws:

```text
createPipeline requires a "authenticator" dependency
```

This is called **fail-fast behavior**.

Instead of allowing Nexus to start with a broken pipeline and fail later during a request, it detects the missing dependency immediately.

---

# 5. `extractClientIp()`

```js
function extractClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
```

This extracts the client's IP address from the incoming request.

For example:

```text
Client
  IP: 192.168.1.20
       ↓
Nexus
       ↓
req.socket.remoteAddress
```

The IP is later used for things such as:

```text
Rate limiting
IP-hash load balancing
Logging
Forwarded headers
```

If the IP cannot be obtained, it uses:

```text
unknown
```

---

# 6. `parseRequestUrl()`

```js
function parseRequestUrl(req) {
  const hostHeader = req.headers.host || 'localhost';
  return new URL(req.url, `http://${hostHeader}`);
}
```

Node's `req.url` might contain something like:

```text
/api/users?id=10
```

The function converts it into a proper `URL` object.

For example:

```text
URL
├── pathname → /api/users
├── search   → ?id=10
└── host     → example.com
```

The router mainly needs:

```text
pathname
host
```

---

# 7. `isEncrypted()`

```js
function isEncrypted(req) {
  return Boolean(req.socket && req.socket.encrypted);
}
```

This checks whether the incoming connection is HTTPS.

It returns:

```text
true
```

for HTTPS and:

```text
false
```

for HTTP.

This information is later used to set:

```text
X-Forwarded-Proto
```

---

# 8. `createPipeline()`

The main function starts here:

```js
export function createPipeline(deps) {
```

This creates the entire Nexus request-processing pipeline.

First:

```js
assertDeps(deps);
```

So before doing anything else, it verifies that all required modules exist.

---

# 9. Extracting Dependencies

Then:

```js
const {
  config,
  metrics,
  router,
  loadBalancer,
  rateLimiter,
  authenticator,
  logger = console,
  healthChecker = null,
  wal = null,
  dashboard = null
} = deps;
```

The pipeline receives all the modules it needs.

Conceptually:

```text
                    Pipeline
                       │
        ┌──────────────┼──────────────┐
        │              │              │
      Router      Load Balancer   Rate Limiter
        │              │              │
        ├──────────────┼──────────────┤
        │              │              │
   Authenticator   Health Checker   Metrics
        │              │              │
        ├──────────────┼──────────────┤
        │              │              │
       WAL           Logger        Dashboard
```

Some dependencies are optional:

```text
healthChecker
wal
dashboard
```

If they aren't provided, they become:

```text
null
```

---

# 10. Dashboard Enabled Check

```js
const dashboardEnabled =
  Boolean(
    dashboard &&
    config.dashboard &&
    config.dashboard.enabled
  );
```

The dashboard is enabled only when:

```text
Dashboard module exists
        AND
config.dashboard exists
        AND
config.dashboard.enabled === true
```

So all three conditions must be satisfied.

---

# 11. Building the Request Context

The function:

```js
function buildContext(req, res, parsedUrl) {
```

creates a single object containing information about the current request.

It returns:

```js
{
  req,
  res,
  method: req.method,
  pathname: parsedUrl.pathname,
  host: req.headers.host,
  clientIp: extractClientIp(req),
  requestId: crypto.randomUUID(),
  startedAt: Date.now(),
  route: null,
  backendPool: null,
  routeAuth: null
}
```

This object is called:

```text
ctx
```

or **request context**.

---

# 12. Why Use a Context Object?

Every pipeline phase needs information about the same request.

Instead of passing many variables around:

```text
req
res
pathname
host
clientIp
route
backend
...
```

the pipeline keeps them together:

```text
ctx
├── req
├── res
├── method
├── pathname
├── host
├── clientIp
├── requestId
├── startedAt
├── route
├── backendPool
└── routeAuth
```

Every phase receives the same `ctx`.

This makes communication between phases simple.

---

# 13. Request ID

This line:

```js
requestId: crypto.randomUUID()
```

generates a unique ID for the request.

For example:

```text
requestId:
550e8400-e29b-41d4-a716-446655440000
```

This is particularly useful for WAL records and tracing a request through Nexus.

---

# 14. Request Start Time

```js
startedAt: Date.now()
```

stores when the request started.

Later, Nexus can calculate:

```text
Duration = current time - startedAt
```

For example:

```text
Request started → 10:00:00.000
Request finished → 10:00:00.125

Duration → 125 ms
```

This is used by metrics and logging.

---

# 15. `onFinish()`

The function:

```js
function onFinish(ctx) {
```

runs when the response finishes.

It calculates:

```js
const durationMs = Date.now() - ctx.startedAt;
```

Then records the request:

```js
metrics.recordRequest({
  route: ctx.route,
  backend: ctx.backendPool,
  status: ctx.res.statusCode,
  durationMs
});
```

So Nexus can track things like:

```text
Route
Backend
HTTP status
Response time
```

---

# 16. Why `res.on('finish')` Matters

Later the code does:

```js
res.on('finish', () => onFinish(ctx));
```

This is important because requests can finish in many different ways.

For example:

```text
429 → rate limit
404 → route not found
401 → authentication failed
502 → backend unavailable
200 → successful request
```

Instead of manually recording metrics in every possible branch, Nexus waits for:

```text
response finished
       ↓
onFinish()
       ↓
record metrics
```

This prevents early returns from accidentally skipping metrics.

---

# 17. Logging

Inside `onFinish()`:

```js
if (typeof logger.logRequest === 'function') {
  logger.logRequest({
    method: ctx.method,
    path: ctx.pathname,
    status: ctx.res.statusCode,
    durationMs
  });
}
```

If the logger supports `logRequest()`, Nexus logs:

```text
Method
Path
Status
Duration
```

For example:

```text
GET /api/users → 200 → 43ms
```

---

# 18. `respondError()`

This helper creates JSON error responses.

```js
function respondError(ctx, statusCode, message, extraHeaders = {}) {
```

For example:

```js
respondError(ctx, 404, 'not found');
```

produces something like:

```json
{
  "error": "not found"
}
```

with HTTP status:

```text
404
```

---

# 19. Already-Sent Headers

The function first checks:

```js
if (ctx.res.headersSent) {
  ctx.res.end();
  return;
}
```

If the response has already started, Nexus doesn't try to modify the headers again.

This avoids errors caused by attempting to send headers after they have already been sent.

---

# 20. Rate Limit Phase

The first actual request-processing phase is:

```js
function rateLimitPhase(ctx) {
```

It calls:

```js
const result = rateLimiter.checkLimit(ctx.clientIp);
```

So Nexus asks:

```text
"Has this client exceeded the allowed request limit?"
```

---

# 21. Rate Limit Passed

If:

```text
result.allowed === true
```

the function returns:

```js
return false;
```

`false` means:

> This phase did not terminate the request. Continue to the next phase.

So:

```text
Rate limit
    ↓
Allowed
    ↓
Continue
```

---

# 22. Rate Limit Failed

If:

```text
result.allowed === false
```

Nexus sends:

```text
429 Too Many Requests
```

using:

```js
respondError(ctx, 429, 'rate limit exceeded', headers);
```

It may also include:

```text
Retry-After
```

to tell the client how many seconds to wait.

Then:

```js
return true;
```

`true` means:

> This phase handled the request. Stop the pipeline.

So:

```text
Rate limit exceeded
        ↓
      429
        ↓
     STOP
```

---

# 23. Route Matching Phase

Next:

```js
function routeMatchPhase(ctx) {
```

It calls the router from the previous file:

```js
const matched = router.match(ctx.pathname, ctx.host);
```

The router answers:

```text
Which route matches this request?
```

---

# 24. No Route

If there is no matching route:

```js
if (!matched) {
  respondError(ctx, 404, 'not found');
  return true;
}
```

Nexus returns:

```text
404 Not Found
```

and stops.

Importantly, authentication is **not** performed for an unmatched route.

The flow is:

```text
Request
   ↓
Rate limit
   ↓
Route match
   ↓
No route
   ↓
404
   ↓
STOP
```

---

# 25. Route Found

If the router finds a route:

```js
ctx.route = matched.path;
ctx.backendPool = matched.backend;
ctx.routeAuth = matched.auth;
```

The request context is updated.

For example:

```text
Request:

GET /api/users
```

Router returns:

```text
path: /api
backend: web
auth: ...
```

The context becomes:

```text
ctx.route       → /api
ctx.backendPool → web
ctx.routeAuth   → route authentication settings
```

Then:

```js
return false;
```

so the pipeline continues.

---

# 26. Authentication Phase

Next:

```js
function authPhase(ctx) {
```

The authenticator is called:

```js
const result = authenticator.authenticate(
  ctx.req.headers,
  ctx.routeAuth,
  ctx.route
);
```

It checks whether the request is authorized for the matched route.

---

# 27. Authentication Failed

If:

```text
result.authenticated === false
```

Nexus sends:

```text
401 Unauthorized
```

and stops:

```js
respondError(ctx, 401, 'unauthorized');
return true;
```

So:

```text
Request
   ↓
Rate limit ✓
   ↓
Route ✓
   ↓
Authentication ✗
   ↓
401
   ↓
STOP
```

The request never reaches the backend.

---

# 28. Authentication Passed

If authentication succeeds:

```js
return false;
```

and the request continues to backend selection.

---

# 29. Backend Selection Phase

Next:

```js
function backendPhase(ctx) {
```

The load balancer from the previous file is called:

```js
const backend = loadBalancer.pick(
  ctx.backendPool,
  { clientIp: ctx.clientIp }
);
```

For example:

```text
Pool: web

9001 → healthy
9002 → healthy
```

The load balancer might return:

```text
9002
```

Now Nexus knows the exact server to forward the request to.

---

# 30. No Healthy Backend

If:

```js
!backend
```

then there is no healthy backend.

Nexus returns:

```text
502 Bad Gateway
```

using:

```js
respondError(ctx, 502, 'no healthy backends available');
```

The request stops.

Notice that the WAL isn't involved here because Nexus never reached a backend.

---

# 31. Forwarding to the Backend

If a backend is available:

```js
forwardToBackend(ctx, backend);
return true;
```

The request is handed to:

```js
forwardToBackend()
```

This function actually performs the proxying.

---

# 32. Creating the Target URL

Inside:

```js
function forwardToBackend(ctx, backend) {
```

the code creates:

```js
targetUrl = new URL(ctx.req.url, backend.url);
```

Suppose:

```text
Incoming:

/api/users
```

and selected backend is:

```text
http://localhost:9001
```

The target becomes:

```text
http://localhost:9001/api/users
```

---

# 33. Choosing HTTP or HTTPS

The code checks:

```js
const client = targetUrl.protocol === 'https:' ? https : http;
```

So:

```text
Backend uses http:
      ↓
Node http module

Backend uses https:
      ↓
Node https module
```

This allows Nexus to proxy to both HTTP and HTTPS backends.

---

# 34. Tracking the Connection

Before forwarding:

```js
loadBalancer.recordConnectionStart(
  ctx.backendPool,
  backend.url
);
```

This increments the active request count.

Example:

```text
9001 → 3 active requests

New request
     ↓

9001 → 4 active requests
```

This is what the load balancer's `least-conn` strategy relies on.

---

# 35. WAL Start Record

If WAL is enabled:

```js
if (wal) {
  wal.recordStart(requestId, {
    method: ctx.method,
    path: ctx.pathname,
    backend: backend.url
  });
}
```

Nexus records that the request started.

Conceptually:

```text
Request started
      ↓
WAL
      ↓
request ID
method
path
backend
```

---

# 36. Forwarded Headers

The code creates:

```js
const outboundHeaders = {
  ...ctx.req.headers,
  host: targetUrl.host
};
```

So it forwards the incoming headers to the backend.

It also modifies/adds important proxy headers.

---

# 37. `X-Forwarded-For`

The code:

```js
const existingXff = ctx.req.headers['x-forwarded-for'];

outboundHeaders['x-forwarded-for'] =
  existingXff
    ? `${existingXff}, ${ctx.clientIp}`
    : ctx.clientIp;
```

preserves the client IP chain.

For example, if the client is:

```text
192.168.1.10
```

the backend receives:

```text
X-Forwarded-For: 192.168.1.10
```

If another proxy already added:

```text
10.0.0.5
```

then Nexus adds the current client IP:

```text
X-Forwarded-For: 10.0.0.5, 192.168.1.10
```

This allows the backend to understand the original request path through proxies.

---

# 38. `X-Forwarded-Proto`

The code:

```js
outboundHeaders['x-forwarded-proto'] =
  isEncrypted(ctx.req) ? 'https' : 'http';
```

tells the backend whether the original client connection used:

```text
HTTP
```

or:

```text
HTTPS
```

For example:

```text
Client
  │
  │ HTTPS
  ▼
Nexus
  │
  │ HTTP
  ▼
Backend
```

The backend can still know:

```text
X-Forwarded-Proto: https
```

---

# 39. Creating the Proxy Request

The actual outbound request is created here:

```js
const proxyReq = client.request(
  targetUrl,
  {
    method: ctx.method,
    headers: outboundHeaders
  },
  (backendRes) => {
    ...
  }
);
```

This is where Nexus actually acts as a **reverse proxy**.

Conceptually:

```text
Client
  │
  │ Request
  ▼
Nexus
  │
  │ New request
  ▼
Backend
```

---

# 40. Receiving the Backend Response

When the backend responds:

```js
(backendRes) => {
```

Nexus sends the backend's status and headers back to the client:

```js
ctx.res.writeHead(
  backendRes.statusCode,
  backendRes.headers
);
```

Then:

```js
backendRes.pipe(ctx.res);
```

streams the backend response directly to the client.

So the data path is:

```text
Backend
   │
   │ response stream
   ▼
Nexus
   │
   │ pipe
   ▼
Client
```

Nexus doesn't need to manually read the entire response into memory first.

---

# 41. When the Backend Response Ends

When:

```js
backendRes.on('end', () => {
```

Nexus records that the connection is finished:

```js
loadBalancer.recordConnectionEnd(
  ctx.backendPool,
  backend.url
);
```

So:

```text
Request starts
     ↓
inFlight +1

Request finishes
     ↓
inFlight -1
```

If WAL is enabled:

```js
wal.recordFinish(requestId, {
  status: backendRes.statusCode
});
```

records the completed request.

---

# 42. Backend Error Handling

The proxy request has an error listener:

```js
proxyReq.on('error', (err) => {
```

This handles situations such as:

```text
Backend unavailable
Connection refused
Network failure
Connection failure
```

First, the connection count is reduced:

```js
loadBalancer.recordConnectionEnd(
  ctx.backendPool,
  backend.url
);
```

---

# 43. Reporting Backend Failure

If the health checker exists:

```js
if (
  healthChecker &&
  typeof healthChecker.reportFailure === 'function'
) {
  healthChecker.reportFailure(
    ctx.backendPool,
    backend.url
  );
}
```

Nexus tells the health checker:

```text
"This backend just failed."
```

The health checker can then use that information to mark the backend unhealthy.

So the components work together:

```text
Proxy failure
     ↓
Health Checker
     ↓
Backend may become unhealthy
     ↓
Load Balancer stops selecting it
```

---

# 44. WAL Backend Error

The WAL also records the failure:

```js
wal.recordFinish(requestId, {
  status: 502,
  error: err.message
});
```

So the request history contains:

```text
Request ID
Backend
502
Error message
```

---

# 45. Returning 502

Finally:

```js
respondError(ctx, 502, 'bad gateway');
```

The client receives:

```json
{
  "error": "bad gateway"
}
```

with status:

```text
502
```

---

# 46. Client Request Errors

There is also:

```js
ctx.req.on('error', () => {
  proxyReq.destroy();
});
```

If the incoming client request itself encounters an error, Nexus destroys the outbound proxy request.

This prevents Nexus from continuing to send a request to the backend when the original client connection has already failed.

---

# 47. Streaming the Client Request

Finally:

```js
ctx.req.pipe(proxyReq);
```

This streams the incoming request body directly to the backend.

For example, with a POST request:

```text
Client
  │
  │ POST body
  ▼
Nexus
  │
  │ stream
  ▼
Backend
```

Nexus doesn't need to completely buffer the request body before sending it.

---

# 48. The `phases` Array

The pipeline defines:

```js
const phases = [
  rateLimitPhase,
  routeMatchPhase,
  authPhase,
  backendPhase
];
```

This array defines the **order of request processing**.

The order is extremely important.

It means:

```text
1. Rate limit
2. Route match
3. Authentication
4. Backend selection
5. Forward request
```

The backend phase handles forwarding, so there is no separate `proxyPhase` in this array.

---

# 49. Why Phase Order Matters

Consider a request to a non-existent route:

```text
GET /does-not-exist
```

The correct behavior is:

```text
Rate limit
    ↓
Route match
    ↓
No route
    ↓
404
```

Authentication should not happen after the route is known to be invalid.

Similarly, you don't want to select a backend before checking authentication.

The intended order is:

```text
Rate Limit
    ↓
Routing
    ↓
Authentication
    ↓
Backend Selection
    ↓
Proxy
```

---

# 50. `handleRequest()`

This is the function that Node's HTTP/HTTPS server will ultimately call:

```js
function handleRequest(req, res) {
```

This is effectively the **entry point for every incoming Nexus request**.

---

# 51. First Parse the URL

The first operation inside `handleRequest()` is:

```js
const parsedUrl = parseRequestUrl(req);
```

So Nexus first figures out:

```text
Host
Path
Query string
```

before processing the request.

---

# 52. Dashboard Check Happens First

Before creating the normal request context:

```js
if (
  dashboardEnabled &&
  dashboard.matches(parsedUrl.pathname)
) {
  dashboard.handleRequest(req, res);
  return;
}
```

This means dashboard requests are special.

For example:

```text
/nexus/dashboard
```

might be handled directly by the dashboard module.

They are:

```text
NOT proxied
NOT processed by normal routing
NOT counted in pipeline metrics
```

The dashboard completely owns the request.

---

# 53. Why Dashboard Comes First

The intended architecture is:

```text
Incoming request
       │
       ▼
Dashboard?
   ┌───┴───┐
  Yes      No
   │        │
   ▼        ▼
Dashboard  Normal Pipeline
```

This prevents dashboard traffic from accidentally being sent to application backends.

---

# 54. Creating the Context

For normal requests:

```js
const ctx = buildContext(req, res, parsedUrl);
```

Now Nexus has its shared request context.

---

# 55. Registering the Finish Listener

Next:

```js
res.on('finish', () => onFinish(ctx));
```

This means:

> Whenever the response finishes, record metrics and logging.

This applies to normal pipeline requests, including errors such as:

```text
429
404
401
502
```

---

# 56. Executing the Phases

Finally:

```js
for (const phase of phases) {
  const handled = phase(ctx);

  if (handled) return;
}
```

This is the heart of the pipeline.

Each phase receives:

```text
ctx
```

and returns either:

```text
false → continue
true  → stop
```

---

# 57. Understanding `true` and `false`

This is the key concept of the whole file.

### `false`

Means:

```text
"I didn't finish the request.
Continue to the next phase."
```

Example:

```text
Rate limit passed
     ↓
return false
     ↓
Route phase
```

### `true`

Means:

```text
"I handled the request.
Stop processing."
```

Example:

```text
Rate limit exceeded
     ↓
429 response
     ↓
return true
     ↓
STOP
```

---

# 58. Complete Pipeline Example: Successful Request

Suppose the client sends:

```text
GET /api/users
```

The full flow is:

```text
                    Client
                      │
                      │ GET /api/users
                      ▼
                   Nexus
                      │
                      ▼
              Parse request URL
                      │
                      ▼
              Dashboard check
                      │
                 Not dashboard
                      │
                      ▼
               Build context
                      │
                      ▼
                Rate limiter
                      │
                    Pass
                      │
                      ▼
                  Router
                      │
                 /api → web
                      │
                      ▼
              Authentication
                      │
                    Pass
                      │
                      ▼
              Load Balancer
                      │
                selects 9001
                      │
                      ▼
               Proxy request
                      │
                      ▼
          http://localhost:9001
                      │
                      ▼
              Backend response
                      │
                      ▼
                 Nexus
                      │
                      ▼
                   Client
                      │
                      ▼
              res 'finish'
                      │
              ┌───────┴────────┐
              ▼                ▼
           Metrics           Logger
```

---

# 59. Failed Request: Rate Limit

```text
Client
  ↓
Dashboard check
  ↓
Rate limiter
  ↓
Limit exceeded
  ↓
429
  ↓
STOP
```

The router, authentication, and backend are never called.

---

# 60. Failed Request: No Route

```text
Client
  ↓
Rate limiter ✓
  ↓
Router
  ↓
No matching route
  ↓
404
  ↓
STOP
```

The backend is never contacted.

---

# 61. Failed Request: Authentication

```text
Client
  ↓
Rate limiter ✓
  ↓
Router ✓
  ↓
Authentication ✗
  ↓
401
  ↓
STOP
```

The backend is never contacted.

---

# 62. Failed Request: No Healthy Backend

```text
Client
  ↓
Rate limiter ✓
  ↓
Router ✓
  ↓
Authentication ✓
  ↓
Load Balancer
  ↓
No healthy backend
  ↓
502
  ↓
STOP
```

---

# 63. Failed Request: Backend Connection Error

```text
Client
  ↓
Rate limiter ✓
  ↓
Router ✓
  ↓
Authentication ✓
  ↓
Load Balancer
  ↓
Backend selected
  ↓
Proxy
  ↓
Backend connection fails
  │
  ├── Connection count updated
  ├── Health checker notified
  ├── WAL updated
  └── 502 returned
```

---

# 64. How All the Files Connect

Based on the files you've shown, Nexus now looks like this:

```text
                    nexus.config.json
                           │
                           ▼
                    ┌─────────────┐
                    │ Config      │
                    │ Loader      │
                    └──────┬──────┘
                           │
                    Validated config
                           │
                           ▼
              ┌─────────────────────────┐
              │       PIPELINE          │
              │                         │
Request ─────►│  Rate Limiter           │
              │       ↓                 │
              │  Router                 │
              │       ↓                 │
              │  Authenticator          │
              │       ↓                 │
              │  Load Balancer          │
              │       ↓                 │
              │  HTTP/HTTPS Proxy       │
              └──────────┬──────────────┘
                         │
                         ▼
                  Backend Server
                  ┌────────────┐
                  │   :9001    │
                  ├────────────┤
                  │   :9002    │
                  └────────────┘
```

Supporting the pipeline:

```text
Health Checker
      │
      └── tells Load Balancer which backends are healthy

WAL
      │
      └── records request start/finish

Metrics
      │
      └── records status, route, backend, duration

Logger
      │
      └── records request information

Dashboard
      │
      └── handles dashboard requests separately
```

# 65. The Most Important Mental Model

Think of this file as the **traffic controller of Nexus**.

It doesn't decide all the individual rules itself.

Instead, it coordinates the other modules:

```text
                    INCOMING REQUEST
                           │
                           ▼
                     Dashboard?
                       /     \
                     Yes      No
                      │        │
                      ▼        ▼
                  Dashboard  Rate Limit
                              │
                              ▼
                           Router
                              │
                              ▼
                       Authentication
                              │
                              ▼
                        Load Balancer
                              │
                              ▼
                       Selected Backend
                              │
                              ▼
                           Proxy
                              │
                              ▼
                       Backend Response
                              │
                              ▼
                    Metrics + Logging
```

# 66. In One Sentence

**This file is Nexus's central request-processing pipeline: it receives every normal request, applies rate limiting, finds the route, authenticates the request, selects a healthy backend, proxies the request to it, handles failures, records WAL/metrics/logs, and returns the backend's response to the client.**
