# Nexus Server Startup Module Explained

## 1. What does this file do?

This file is responsible for **starting and stopping the entire Nexus server**.

It connects all the major Nexus components:

```text
Config
  │
  ├── Logger
  ├── Metrics
  ├── Router
  ├── Health Checker
  ├── Load Balancer
  ├── Rate Limiter
  ├── Authenticator
  ├── WAL
  ├── Dashboard
  │
  └── Pipeline
          │
          ▼
     HTTP / HTTPS Server
```

In simple terms:

> **This is the file that assembles Nexus and makes it actually run.**

---

# 2. What does the code first do?

The first thing it does is import Node.js's HTTP and HTTPS modules:

```js
import http from 'node:http';
import https from 'node:https';
```

These are required to create:

```text
HTTP Server
HTTPS Server
```

Then it imports all the Nexus modules.

---

# 3. Modules Imported

### Pipeline

```js
import { createPipeline } from './pipeline.js';
```

The pipeline controls the order in which each request is processed.

For example:

```text
Request
   ↓
Rate Limit
   ↓
Route
   ↓
Authentication
   ↓
Load Balancer
   ↓
Backend
```

---

### HTTPS/TLS

```js
import { createHttpsServer } from '../security/tls.js';
```

This creates the HTTPS server and handles TLS certificates.

---

### Logger

```js
import { createLogger } from '../observability/logger.js';
```

Responsible for application logging.

---

### Metrics

```js
import { createMetrics } from '../observability/metrics.js';
```

Collects information such as request statistics and backend-related metrics.

---

### Router

```js
import { createRouter } from '../routing/router.js';
```

Determines which configured route matches an incoming request.

---

### Load Balancer

```js
import { createLoadBalancer } from '../routing/loadbalancer.js';
```

Chooses which backend server should receive the request.

---

### Health Checker

```js
import { createHealthChecker } from '../reliability/healthcheck.js';
```

Checks whether backend servers are healthy.

---

### WAL

```js
import { createWal } from '../reliability/wal.js';
```

Creates the Write-Ahead Log system when it is enabled.

---

### Rate Limiter

```js
import { createRateLimiter } from '../security/ratelimiter.js';
```

Controls how many requests a client can make within a given period.

---

### Authenticator

```js
import { createAuthenticator } from '../security/auth.js';
```

Handles API-key authentication.

---

### Dashboard

```js
import { createDashboard } from '../observability/dashboard.js';
```

Creates the Nexus monitoring dashboard.

---

# 4. Shutdown Configuration

The code defines:

```js
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
```

That means Nexus normally waits up to:

```text
10 seconds
```

for servers to close gracefully.

If something is still open after 10 seconds, the shutdown code can force-close the connections.

---

# 5. `running`

```js
let running = null;
```

This keeps track of whether Nexus is currently running.

Initially:

```text
running = null
```

means:

```text
Nexus is not running
```

After successful startup:

```text
running = {
    httpServer,
    httpsServer,
    healthChecker,
    wal
}
```

This allows `shutdownServer()` to know what needs to be stopped.

---

# 6. The `listen()` Helper

The function:

```js
function listen(server, port)
```

starts a server and returns a Promise.

Instead of simply doing:

```js
server.listen(port);
```

the function waits until the server actually reports:

```text
listening
```

or:

```text
error
```

---

# 7. Successful Server Startup

When the server emits:

```text
listening
```

the Promise resolves:

```js
resolve();
```

So this:

```js
await listen(httpServer, 8080);
```

means:

> Wait until the HTTP server is actually listening on port 8080.

---

# 8. Handling Listen Errors

If the server emits an error:

```js
server.once('error', onError);
```

the Promise rejects.

For example, if port `8080` is already being used:

```text
Port 8080
   ↓
Cannot bind
   ↓
error
   ↓
listen() rejects
```

The caller can then perform cleanup.

---

# 9. `closeWithTimeout()`

The next helper is:

```js
function closeWithTimeout(server, timeoutMs)
```

Its job is to safely shut down an HTTP or HTTPS server.

Normally:

```text
Stop accepting new connections
        ↓
Wait for existing connections
        ↓
Server closes
```

But sometimes a connection can remain open for too long.

Therefore, this function provides a timeout.

---

# 10. Graceful Shutdown

The normal path is:

```js
server.close(() => {
  ...
});
```

The callback executes when the server has successfully closed.

---

# 11. Forced Shutdown

A timer is created:

```js
const forceTimer = setTimeout(() => {
```

If the server hasn't closed before the timeout:

```text
10 seconds
   ↓
Still open?
   ↓
Force close connections
```

It uses:

```js
server.closeAllConnections();
```

when that method is available.

This prevents Nexus from hanging forever during shutdown.

---

# 12. Main Function: `startServer()`

The main function is:

```js
export async function startServer(
  config,
  logger = console,
  options = {}
)
```

This is the function that actually starts Nexus.

It receives:

```text
config
logger
options
```

The `config` is the validated Nexus configuration you showed earlier.

---

# 13. First Startup Check

The first thing inside `startServer()` is:

```js
if (running) {
  throw new Error(
    'startServer was already called - call shutdownServer() first'
  );
}
```

This prevents starting Nexus twice.

For example:

```text
startServer()
   ↓
Nexus running

startServer()
   ↓
ERROR
```

You must shut down the existing server first.

---

# 14. Shutdown Timeout

Next:

```js
const shutdownTimeoutMs =
  options.shutdownTimeoutMs ||
  DEFAULT_SHUTDOWN_TIMEOUT_MS;
```

By default:

```text
10 seconds
```

But the caller can provide another value.

---

# 15. Create the Logger

```js
const appLogger =
  createLogger(config.logging);
```

The logger is created from the configuration.

For example:

```json
{
  "logging": {
    "level": "info",
    "format": "combined"
  }
}
```

So the logger knows how Nexus should produce logs.

---

# 16. Create Metrics

```js
const metrics = createMetrics();
```

This creates the metrics system.

It will later be used by the pipeline and dashboard.

---

# 17. Create Router

```js
const router = createRouter(config);
```

The router receives the Nexus configuration and knows about:

```text
routes
backends
```

For example:

```text
/api
   ↓
web backend
```

---

# 18. Create Health Checker

```js
const healthChecker =
  createHealthChecker(
    config.backends,
    config.healthcheck,
    appLogger
  );
```

It receives:

```text
Backend configuration
Health-check configuration
Logger
```

It can then check whether:

```text
localhost:9001
localhost:9002
```

are healthy.

---

# 19. Create Load Balancer

```js
const loadBalancer =
  createLoadBalancer(
    config.backends,
    healthChecker,
    appLogger
  );
```

Notice that the load balancer receives the health checker.

This means:

```text
Health Checker
      │
      ▼
Healthy backends
      │
      ▼
Load Balancer
      │
      ▼
Choose backend
```

For example:

```text
9001 → healthy
9002 → unhealthy

        ↓

Load Balancer
        ↓
9001
```

---

# 20. Create Rate Limiter

```js
const rateLimiter =
  createRateLimiter(
    config.ratelimit,
    appLogger
  );
```

It uses the configured rate-limit settings.

For example:

```json
{
  "windowMs": 60000,
  "maxRequests": 100
}
```

means:

```text
100 requests
within 60 seconds
```

---

# 21. Create Authenticator

```js
const authenticator =
  createAuthenticator(
    config.auth,
    appLogger
  );
```

This handles API-key authentication.

For example:

```text
X-API-Key: dev-key-123
```

---

# 22. Create WAL

```js
const wal =
  config.wal.enabled
    ? createWal(config.wal, appLogger)
    : null;
```

This is conditional.

If:

```text
wal.enabled = true
```

then:

```text
Create WAL
```

Otherwise:

```text
wal = null
```

So Nexus doesn't create or run WAL when it is disabled.

---

# 23. Create Dashboard

Similarly:

```js
const dashboard =
  config.dashboard.enabled
    ? createDashboard(
        config.dashboard,
        metrics,
        appLogger
      )
    : null;
```

If the dashboard is enabled:

```text
Create Dashboard
```

Otherwise:

```text
dashboard = null
```

The dashboard receives the same `metrics` object created earlier.

Therefore:

```text
Metrics
   │
   ├── Pipeline
   │
   └── Dashboard
```

Both use the same metrics system.

---

# 24. Create the Pipeline

This is one of the most important parts:

```js
const pipeline = createPipeline({
  config,
  metrics,
  router,
  loadBalancer,
  rateLimiter,
  authenticator,
  logger: appLogger,
  healthChecker,
  wal,
  dashboard
});
```

This connects all the modules together.

Conceptually:

```text
                 Pipeline
                    │
      ┌─────────────┼─────────────┐
      │             │             │
      ▼             ▼             ▼
 Rate Limiter     Router       Authenticator
                    │
                    ▼
              Load Balancer
                    │
                    ▼
                 Backend

Additional:
Metrics
Health Checker
WAL
Dashboard
Logger
```

The pipeline becomes the central request handler.

---

# 25. Enable Keep-Alive

The code then does:

```js
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
```

This enables connection reuse for outbound HTTP/HTTPS requests.

Instead of repeatedly creating new TCP connections:

```text
Request 1 → new connection
Request 2 → new connection
Request 3 → new connection
```

connections can be reused:

```text
Connection
   │
   ├── Request 1
   ├── Request 2
   └── Request 3
```

This can reduce connection overhead when Nexus communicates with backends.

---

# 26. Start Health Checking

```js
healthChecker.start();
```

Now the health checker begins checking the configured backend servers.

For example:

```text
localhost:9001
localhost:9002
```

The load balancer can then avoid unhealthy servers.

---

# 27. Start WAL

```js
if (wal) wal.start();
```

WAL starts only when it was enabled in the configuration.

So:

```text
WAL enabled?
   │
   ├── Yes → start WAL
   │
   └── No  → do nothing
```

---

# 28. Prepare HTTP and HTTPS Servers

Initially:

```js
let httpServer = null;
let httpsServer = null;
```

This means neither server has been created yet.

---

# 29. Start HTTP Server

The code checks:

```js
if (config.listen.http != null)
```

If HTTP is configured:

```js
httpServer =
  http.createServer(
    pipeline.handleRequest
  );
```

This creates the HTTP server.

Most importantly, the server uses:

```text
pipeline.handleRequest
```

as its request handler.

So:

```text
HTTP Request
     ↓
HTTP Server
     ↓
pipeline.handleRequest()
     ↓
Nexus request processing
```

---

# 30. Start Listening

Then:

```js
await listen(
  httpServer,
  config.listen.http
);
```

If the config says:

```json
{
  "listen": {
    "http": 8080
  }
}
```

Nexus starts listening on:

```text
http://localhost:8080
```

---

# 31. Log HTTP Startup

After successful startup:

```js
logger.info(
  `Nexus HTTP listening on port ${config.listen.http}`
);
```

You get a log such as:

```text
Nexus HTTP listening on port 8080
```

---

# 32. Start HTTPS Server

The code then checks:

```js
if (config.listen.https != null)
```

If HTTPS is configured, it creates the HTTPS server:

```js
httpsServer =
  createHttpsServer(
    pipeline.handleRequest,
    config.tls.certPath,
    config.tls.keyPath,
    { sni: config.tls.sni }
  );
```

The important part is that HTTPS also uses:

```text
pipeline.handleRequest
```

So HTTP and HTTPS eventually use exactly the same request-processing pipeline.

---

# 33. HTTP and HTTPS Architecture

The overall flow is:

```text
                    Nexus
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
     HTTP Server             HTTPS Server
       :8080                    :8443
          │                       │
          └───────────┬───────────┘
                      ▼
                   Pipeline
                      │
                      ▼
              Request Processing
```

This avoids having separate application logic for HTTP and HTTPS.

---

# 34. Startup Failure Handling

The server creation is inside:

```js
try {
   ...
} catch (err) {
   ...
}
```

This is important.

Suppose:

```text
HTTP starts successfully
       ↓
HTTPS fails to start
```

Nexus must not leave HTTP running accidentally.

So the `catch` block cleans everything up.

---

# 35. Stop Health Checker on Failure

```js
healthChecker.stop();
```

This stops background health-check operations.

---

# 36. Stop WAL on Failure

```js
if (wal) await wal.stop();
```

If WAL was running, it is stopped.

---

# 37. Close HTTP Server on Failure

```js
if (httpServer)
  await closeWithTimeout(
    httpServer,
    shutdownTimeoutMs
  );
```

This safely closes HTTP.

---

# 38. Close HTTPS Server on Failure

Similarly:

```js
if (httpsServer)
  await closeWithTimeout(
    httpsServer,
    shutdownTimeoutMs
  );
```

So a failed startup doesn't leave half of Nexus running.

---

# 39. Save Running State

After everything successfully starts:

```js
running = {
  httpServer,
  httpsServer,
  healthChecker,
  wal,
  shutdownTimeoutMs
};
```

Now Nexus knows:

```text
Server is running
```

and stores the components required for shutdown.

---

# 40. What Does `startServer()` Return?

It returns:

```js
return {
  httpServer,
  httpsServer,
  pipeline,
  metrics,
  router,
  loadBalancer,
  rateLimiter,
  authenticator,
  healthChecker,
  wal,
  dashboard
};
```

This gives the caller access to the created Nexus components.

Conceptually:

```text
startServer()
     │
     ▼
Returns Nexus components
     │
     ├── HTTP server
     ├── HTTPS server
     ├── Pipeline
     ├── Metrics
     ├── Router
     ├── Load balancer
     ├── Rate limiter
     ├── Authenticator
     ├── Health checker
     ├── WAL
     └── Dashboard
```

This is also useful for tests because the test code can inspect individual components.

---

# 41. `shutdownServer()`

The second major exported function is:

```js
export async function shutdownServer()
```

Its job is to shut down the entire Nexus system.

---

# 42. If Nexus Isn't Running

First:

```js
if (!running) return;
```

If Nexus is already stopped:

```text
shutdownServer()
      ↓
Nothing running
      ↓
Return
```

No error is thrown.

---

# 43. Get Running Components

```js
const {
  httpServer,
  httpsServer,
  healthChecker,
  wal,
  shutdownTimeoutMs
} = running;
```

It retrieves the components saved by `startServer()`.

---

# 44. Mark Nexus as Stopped

Immediately:

```js
running = null;
```

This prevents another shutdown call from trying to shut down the same resources again.

---

# 45. Stop Health Checking

```js
healthChecker.stop();
```

Background health checks are stopped first.

---

# 46. Flush WAL

```js
if (wal) await wal.flush();
```

Before shutting down, Nexus makes sure pending WAL data is flushed.

Conceptually:

```text
Pending WAL data
       ↓
flush()
       ↓
Data written
       ↓
Continue shutdown
```

This reduces the chance of losing buffered WAL information.

---

# 47. Close HTTP and HTTPS

The code creates:

```js
const servers =
  [httpServer, httpsServer].filter(Boolean);
```

This removes `null` values.

For example, if only HTTP is configured:

```text
[
  httpServer,
  null
]
```

becomes:

```text
[
  httpServer
]
```

Then:

```js
await Promise.all(
  servers.map(
    (server) =>
      closeWithTimeout(
        server,
        shutdownTimeoutMs
      )
  )
);
```

Both servers can be closed concurrently.

---

# 48. Stop WAL Completely

Finally:

```js
if (wal) await wal.stop();
```

So the shutdown sequence is roughly:

```text
shutdownServer()
       │
       ▼
Stop health checks
       │
       ▼
Flush WAL
       │
       ▼
Close HTTP + HTTPS
       │
       ▼
Stop WAL
       │
       ▼
Nexus stopped
```

---

# 49. Complete Startup Flow

Putting everything together:

```text
                    startServer()
                         │
                         ▼
                 Already running?
                    /        \
                  YES         NO
                  │            │
                Error          ▼
                         Create Logger
                              │
                              ▼
                         Create Metrics
                              │
                              ▼
                         Create Router
                              │
                              ▼
                      Create Health Checker
                              │
                              ▼
                      Create Load Balancer
                              │
                              ▼
                      Create Rate Limiter
                              │
                              ▼
                      Create Authenticator
                              │
                       ┌──────┴──────┐
                       ▼             ▼
                   Create WAL    Create Dashboard
                       │             │
                       └──────┬──────┘
                              ▼
                       Create Pipeline
                              │
                              ▼
                    Enable Keep-Alive
                              │
                              ▼
                     Start Health Check
                              │
                              ▼
                         Start WAL
                              │
                              ▼
                     Create HTTP Server
                              │
                              ▼
                       Listen :8080
                              │
                              ▼
                    Create HTTPS Server
                              │
                              ▼
                       Listen :8443
                              │
                              ▼
                       Nexus Running
```

---

# 50. Complete Request Flow After Startup

Once Nexus is running:

```text
                    Client
                      │
             ┌────────┴────────┐
             │                 │
             ▼                 ▼
        HTTP :8080        HTTPS :8443
             │                 │
             └────────┬────────┘
                      ▼
                   Pipeline
                      │
                      ▼
               Dashboard check
                      │
              ┌───────┴────────┐
              │                │
          Dashboard         Normal
              │             request
              │                │
              │                ▼
              │           Rate Limiter
              │                │
              │                ▼
              │             Router
              │                │
              │                ▼
              │          Authentication
              │                │
              │                ▼
              │          Load Balancer
              │                │
              │                ▼
              │             Backend
              │
              ▼
          Dashboard
```

---

# 51. How the Major Modules Are Connected

The most important relationship is:

```text
                         startServer()
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
          Router       Health Checker     Rate Limiter
             │                │
             │                ▼
             │          Load Balancer
             │                │
             └───────┐        │
                     ▼        ▼
                   Pipeline
                     │
         ┌───────────┼────────────┐
         │           │            │
         ▼           ▼            ▼
      Metrics       WAL       Dashboard
         │
         ▼
    Observability
```

The startup module itself doesn't implement routing, authentication, load balancing, etc.

It **creates and connects the modules that implement them**.

---

# 52. Why This File Is Important

Without this file, the individual modules would exist separately:

```text
Router
Load Balancer
Rate Limiter
Auth
Health Checker
WAL
Dashboard
Metrics
```

but they would not form a working server.

This file turns them into:

```text
                  NEXUS
                    │
              ┌─────┴─────┐
              │  Pipeline │
              └─────┬─────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Router       Auth      Rate Limit
        │
        ▼
  Load Balancer
        │
        ▼
    Backends
```

---

# 53. Simplest Mental Model

Think of this file as the **main assembly line for Nexus**.

The individual modules are like components:

```text
Router        → decides where request goes
Load Balancer → decides which backend
Health Check  → checks backend health
Rate Limiter  → limits requests
Auth          → checks API key
WAL           → records request lifecycle
Metrics       → collects statistics
Dashboard     → displays statistics
Pipeline      → controls request order
```

This file takes all of them:

```text
        Components
            │
            ▼
       startServer()
            │
            ▼
      Connect everything
            │
            ▼
       Create pipeline
            │
            ▼
     Create HTTP/HTTPS
            │
            ▼
         Nexus runs
```

## In one sentence

**This file is Nexus's main server orchestrator: it creates every core module, wires them into the request pipeline, starts HTTP/HTTPS listeners and background services, handles startup failures safely, and provides a clean shutdown process that flushes and closes everything properly.**
