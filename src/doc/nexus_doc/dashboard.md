# Nexus Dashboard Module Explained

## 1. What does this file do?

This file creates the **Nexus Dashboard service**.

It provides three things:

| Endpoint                      | Purpose                             |
| ----------------------------- | ----------------------------------- |
| `GET /nexus/dashboard`        | Serves the dashboard web page       |
| `GET /nexus/dashboard/events` | Sends live metrics using SSE        |
| `GET /nexus/metrics`          | Returns the current metrics as JSON |

The dashboard gets its data from the `metrics` module.

The important architecture is:

```text
                    Nexus
                      │
             ┌────────┴────────┐
             │                 │
       Normal requests      Dashboard
             │                 │
             ▼                 ▼
         Pipeline        Dashboard Module
             │          ┌──────┼──────┐
             ▼          │      │      │
         Backends       HTML   SSE   REST
```

Dashboard requests are handled directly by this module and **never go to the application backends**.

---

# 2. What does the code first do?

The first thing it does is import Node.js modules:

```js
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
```

These are used for:

* Reading the dashboard HTML file
* Working with filesystem paths
* Converting the module URL into a filesystem path
* Parsing request URLs

---

# 3. Finding the Current Directory

Next:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

This determines the directory where the current JavaScript file is located.

This is useful because the dashboard HTML file is located relative to this module.

For example:

```text
src/
├── observability/
│   └── dashboard.js
│
└── public/
    └── index.html
```

The code can calculate the absolute path to:

```text
public/index.html
```

instead of depending on where the application was started from.

---

# 4. Default Dashboard Configuration

The file then defines:

```js
const DEFAULT_BASE_PATH = '/nexus/dashboard';
const DEFAULT_PUSH_INTERVAL_MS = 2000;
const DEFAULT_INDEX_PATH =
  path.resolve(__dirname, '../public/index.html');
```

These are fallback values.

### Dashboard path

```text
/nexus/dashboard
```

This is the main dashboard URL.

### Push interval

```text
2000 ms
```

which means:

```text
2 seconds
```

The dashboard can receive updated metrics every 2 seconds.

### Dashboard HTML

By default, Nexus looks for:

```text
../public/index.html
```

relative to this JavaScript module.

---

# 5. Events Endpoint

Next:

```js
const EVENTS_SUFFIX = '/events';
```

This creates the SSE endpoint.

If the dashboard path is:

```text
/nexus/dashboard
```

then the events endpoint becomes:

```text
/nexus/dashboard/events
```

So:

```text
/nexus/dashboard
          +
/events
          =
/nexus/dashboard/events
```

---

# 6. REST Metrics Endpoint

The code defines:

```js
const REST_METRICS_PATH = '/nexus/metrics';
```

This endpoint is intentionally fixed.

It provides the current metrics as normal JSON instead of using SSE.

So:

```text
/nexus/dashboard/events
```

is for:

```text
LIVE STREAM
```

while:

```text
/nexus/metrics
```

is for:

```text
ONE-TIME SNAPSHOT
```

---

# 7. `diffSnapshot()`

One of the most important functions in this file is:

```js
export function diffSnapshot(prev, next)
```

Its job is to compare two metrics snapshots.

For example, imagine the previous snapshot is:

```json
{
  "requests": 100,
  "errors": 5
}
```

and the new snapshot is:

```json
{
  "requests": 105,
  "errors": 5
}
```

The difference is:

```json
{
  "requests": 105
}
```

Only the changed part needs to be sent.

---

# 8. Why Does the Dashboard Need a Diff?

Without diffing, every SSE update could send the entire metrics object:

```text
Full snapshot
Full snapshot
Full snapshot
Full snapshot
...
```

That can waste bandwidth when only a small value changes.

Instead:

```text
First update
    ↓
Full snapshot

Next update
    ↓
Only changed values
```

For example:

```text
First:

{
  requests: 100,
  errors: 5,
  latency: 30
}
```

Next:

```text
{
  requests: 101,
  errors: 5,
  latency: 30
}
```

The dashboard only receives:

```json
{
  "requests": 101
}
```

---

# 9. What Happens If Nothing Changed?

`diffSnapshot()` returns:

```js
undefined
```

when there are no changes.

For example:

```text
Previous:
requests = 100

Current:
requests = 100

          ↓

No difference
          ↓
undefined
```

This becomes important for SSE because the server can completely skip sending that update.

---

# 10. Handling Removed Keys

The function also detects when something existed before but no longer exists.

For example:

```json
Previous:
{
  "requests": 100,
  "errors": 5
}
```

New:

```json
{
  "requests": 100
}
```

The diff becomes:

```json
{
  "errors": null
}
```

`null` tells the dashboard that the key was removed.

---

# 11. `sseFrame()`

Next:

```js
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

This creates a properly formatted **Server-Sent Events (SSE)** message.

For example:

```text
event: snapshot
data: {"type":"full","snapshot":{...}}
```

The browser can listen to these events using JavaScript's:

```text
EventSource
```

Conceptually:

```text
Browser
   │
   │ opens connection
   ▼
/nexus/dashboard/events
   │
   │ SSE stream
   ▼
Metrics updates
```

---

# 12. `pathnameOf()`

```js
function pathnameOf(req) {
  return new URL(req.url, 'http://placeholder').pathname;
}
```

This extracts only the pathname from the request.

For example:

```text
/nexus/dashboard?theme=dark
```

becomes:

```text
/nexus/dashboard
```

The query string is ignored when deciding which dashboard endpoint to serve.

---

# 13. `createDashboard()`

The main function is:

```js
export function createDashboard(
  dashboardConfig = {},
  metrics,
  logger = console
)
```

It creates the dashboard service.

It receives:

```text
dashboardConfig
metrics
logger
```

### `dashboardConfig`

Contains dashboard settings such as:

```json
{
  "enabled": true,
  "path": "/nexus/dashboard",
  "pushIntervalMs": 2000
}
```

### `metrics`

Provides:

```js
metrics.snapshot()
```

which gives the current Nexus metrics.

### `logger`

Used for reporting dashboard errors.

---

# 14. Determine Dashboard Paths

Inside `createDashboard()`:

```js
const basePath =
  dashboardConfig.path || DEFAULT_BASE_PATH;
```

If the config says:

```text
/nexus/dashboard
```

that becomes the dashboard base path.

Then:

```js
const eventsPath =
  `${basePath}${EVENTS_SUFFIX}`;
```

becomes:

```text
/nexus/dashboard/events
```

---

# 15. Determine Push Interval

```js
const pushIntervalMs =
  dashboardConfig.pushIntervalMs ||
  DEFAULT_PUSH_INTERVAL_MS;
```

If the config specifies:

```text
2000
```

the dashboard sends updates every:

```text
2 seconds
```

If no value is provided, it defaults to 2000 ms.

---

# 16. Determine HTML File

```js
const indexPath =
  dashboardConfig.indexPath ||
  DEFAULT_INDEX_PATH;
```

Normally the dashboard uses:

```text
public/index.html
```

The `indexPath` option allows tests or unusual deployments to provide a different HTML file.

---

# 17. `isEnabled()`

```js
function isEnabled() {
  return Boolean(dashboardConfig.enabled);
}
```

This simply checks whether the dashboard is enabled.

For example:

```json
{
  "enabled": true
}
```

means:

```text
Dashboard enabled
```

while:

```json
{
  "enabled": false
}
```

means:

```text
Dashboard disabled
```

---

# 18. `matches()`

This function determines whether a request belongs to the dashboard:

```js
function matches(pathname) {
  if (!isEnabled()) return false;

  return (
    pathname === basePath ||
    pathname === eventsPath ||
    pathname === REST_METRICS_PATH
  );
}
```

For the default configuration:

```text
/nexus/dashboard
/nexus/dashboard/events
/nexus/metrics
```

return:

```text
true
```

Everything else returns:

```text
false
```

---

# 19. Why `matches()` Is Important

Remember the pipeline file you showed earlier.

The pipeline does:

```text
Incoming request
       ↓
Dashboard?
       ↓
dashboard.matches()
```

If it returns `true`:

```text
Dashboard handles request
       ↓
STOP
```

The request never reaches:

```text
Rate limiter
Router
Authenticator
Load balancer
Backend
```

So the dashboard is separated from normal application traffic.

---

# 20. Serving the Dashboard HTML

The function:

```js
function serveStaticPage(res)
```

loads the dashboard's HTML file.

It uses:

```js
fs.readFile(indexPath, 'utf8', ...)
```

to read:

```text
public/index.html
```

from disk.

---

# 21. If Reading the HTML Fails

If the file cannot be read:

```js
if (err) {
```

the error is logged:

```js
logger.error(
  `dashboard: failed to read ${indexPath}: ${err.message}`
);
```

Then Nexus returns:

```text
500 Internal Server Error
```

with:

```text
dashboard UI unavailable
```

---

# 22. Successful Dashboard Response

If the file is successfully read:

```js
res.statusCode = 200;
res.setHeader(
  'Content-Type',
  'text/html; charset=utf-8'
);
res.end(html);
```

The browser receives the dashboard HTML.

So:

```text
GET /nexus/dashboard
        ↓
Read index.html
        ↓
HTTP 200
        ↓
Browser renders dashboard
```

---

# 23. Serving Metrics Snapshot

The REST endpoint uses:

```js
function serveMetricsSnapshot(res) {
```

It calls:

```js
metrics.snapshot()
```

and sends the result as JSON:

```js
res.end(JSON.stringify(metrics.snapshot()));
```

So:

```text
GET /nexus/metrics
        ↓
metrics.snapshot()
        ↓
JSON
        ↓
Client
```

This is a normal request-response model.

---

# 24. REST Example

A client could request:

```text
GET /nexus/metrics
```

and receive something conceptually like:

```json
{
  "requests": 1500,
  "errors": 20,
  "latency": {
    "avg": 42
  }
}
```

The exact fields depend on what the `metrics` module provides.

---

# 25. The SSE Endpoint

The most interesting part is:

```js
function serveEvents(req, res)
```

This creates a **persistent connection** between the browser and Nexus.

Instead of:

```text
Browser → request
Nexus   → response
Connection closes
```

SSE works like:

```text
Browser → connect
             │
             │
             │ persistent connection
             │
             ▼
          Nexus
             │
             ├── metrics update
             ├── metrics update
             ├── metrics update
             └── ...
```

---

# 26. SSE Headers

The function sets:

```js
res.setHeader(
  'Content-Type',
  'text/event-stream'
);
```

This tells the browser:

> This response is an SSE stream.

It also sets:

```js
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
```

These are used to keep the connection open and prevent caching.

---

# 27. Flushing Headers

```js
if (typeof res.flushHeaders === 'function') {
  res.flushHeaders();
}
```

This sends the headers immediately instead of waiting for more response data.

That helps establish the SSE connection quickly.

---

# 28. Tracking the Last Snapshot

```js
let lastSent = null;
```

The server needs to remember what it last sent to this particular dashboard connection.

Initially:

```text
lastSent = null
```

meaning:

```text
No snapshot has been sent yet.
```

---

# 29. `push()`

The `push()` function generates each dashboard update.

First:

```js
const snapshot = metrics.snapshot();
```

It takes the current metrics.

---

# 30. First SSE Message

If:

```js
lastSent === null
```

the server sends the complete snapshot:

```js
res.write(
  sseFrame('snapshot', {
    type: 'full',
    snapshot
  })
);
```

So the first message looks conceptually like:

```json
{
  "type": "full",
  "snapshot": {
    "...": "..."
  }
}
```

This is important because a newly connected dashboard needs the complete current state.

---

# 31. Later SSE Messages

For subsequent updates:

```js
const changes =
  diffSnapshot(lastSent, snapshot);
```

The server compares:

```text
Previous snapshot
        VS
Current snapshot
```

---

# 32. Nothing Changed

If:

```js
changes === undefined
```

the function does:

```js
return;
```

No SSE message is sent.

So if metrics didn't change:

```text
2 seconds later
     ↓
Compare snapshots
     ↓
No changes
     ↓
Send nothing
```

This reduces unnecessary network traffic.

---

# 33. Something Changed

If there are changes:

```js
res.write(
  sseFrame('snapshot', {
    type: 'diff',
    changes
  })
);
```

The server sends only the changed portion.

So the dashboard receives:

```json
{
  "type": "diff",
  "changes": {
    "requests": 1501
  }
}
```

instead of the entire metrics object.

---

# 34. Updating `lastSent`

After successfully sending a snapshot or diff:

```js
lastSent = snapshot;
```

This is important.

The next comparison is always:

```text
Last snapshot actually sent
              VS
Current snapshot
```

not simply the previous timer tick.

This is why the comment says:

> "diffs against the last one this connection actually received"

---

# 35. First Push Happens Immediately

After defining `push()`:

```js
push();
```

is called immediately.

This means the dashboard doesn't have to wait 2 seconds for its first update.

Without this:

```text
Connection
   ↓
Wait 2 seconds
   ↓
First metrics
```

With this:

```text
Connection
   ↓
Immediate full snapshot
   ↓
Wait 2 seconds
   ↓
Next update
```

---

# 36. Repeating Updates

Then:

```js
const timer = setInterval(
  push,
  pushIntervalMs
);
```

With:

```text
pushIntervalMs = 2000
```

the flow is:

```text
Immediately → Full snapshot

After 2 sec → Diff/no update
After 2 sec → Diff/no update
After 2 sec → Diff/no update
...
```

---

# 37. `timer.unref()`

```js
if (timer.unref) timer.unref();
```

This prevents the timer from unnecessarily keeping the Node.js process alive.

It is a Node.js lifecycle optimization.

---

# 38. Cleaning Up the Timer

The code defines:

```js
function cleanup() {
  clearInterval(timer);
}
```

When the dashboard connection closes, the timer must be stopped.

Otherwise Nexus could keep running an unnecessary timer for a client that no longer exists.

---

# 39. Handling Connection Close

Two events are monitored:

```js
req.on('close', cleanup);
res.on('close', cleanup);
```

Either one can trigger cleanup.

So:

```text
Browser disconnects
       ↓
Connection closes
       ↓
cleanup()
       ↓
clearInterval(timer)
```

This prevents resource leaks.

---

# 40. `handleRequest()`

This function is the main entry point for dashboard requests:

```js
function handleRequest(req, res) {
```

It first extracts the path:

```js
const pathname = pathnameOf(req);
```

Then it checks which dashboard endpoint was requested.

---

# 41. Events Endpoint

First:

```js
if (pathname === eventsPath) {
  serveEvents(req, res);
  return;
}
```

For:

```text
/nexus/dashboard/events
```

Nexus starts the SSE connection.

---

# 42. REST Metrics Endpoint

Next:

```js
if (pathname === REST_METRICS_PATH) {
  serveMetricsSnapshot(res);
  return;
}
```

For:

```text
/nexus/metrics
```

Nexus returns a one-time JSON snapshot.

---

# 43. Dashboard Page

Then:

```js
if (pathname === basePath) {
  serveStaticPage(res);
  return;
}
```

For:

```text
/nexus/dashboard
```

Nexus serves:

```text
public/index.html
```

---

# 44. Defensive 404

Finally:

```js
res.statusCode = 404;
res.end();
```

This should normally never happen because the pipeline first calls:

```text
dashboard.matches()
```

and only calls:

```text
dashboard.handleRequest()
```

for a matching dashboard path.

So this 404 is a safety check.

---

# 45. What Does the Module Return?

At the end:

```js
return {
  matches,
  handleRequest
};
```

The dashboard exposes exactly two functions to the pipeline:

```text
matches()
handleRequest()
```

This matches the contract expected by the pipeline file you showed earlier.

---

# 46. How This Connects to Your Pipeline File

Your previous pipeline contains:

```js
if (dashboardEnabled && dashboard.matches(parsedUrl.pathname)) {
  dashboard.handleRequest(req, res);
  return;
}
```

Now we can see exactly how the two files work together.

```text
                    Incoming Request
                           │
                           ▼
                    createPipeline()
                           │
                           ▼
                   dashboard.matches()
                           │
                 ┌─────────┴─────────┐
                 │                   │
                true                false
                 │                   │
                 ▼                   ▼
        dashboard.handleRequest()   Normal pipeline
                 │                   │
       ┌─────────┼─────────┐         ▼
       │         │         │      Rate Limit
       ▼         ▼         ▼         ↓
    Dashboard  SSE       REST      Router
      HTML     Events   Metrics      ↓
                                   Auth
                                     ↓
                                Load Balancer
                                     ↓
                                  Backend
```

This means the dashboard is essentially **outside the normal application proxy flow**.

---

# 47. Complete Dashboard Flow

Suppose a user opens:

```text
http://localhost:8080/nexus/dashboard
```

The flow is:

```text
Browser
   │
   ▼
Nexus HTTP Server
   │
   ▼
Pipeline
   │
   ▼
dashboard.matches("/nexus/dashboard")
   │
   │ true
   ▼
dashboard.handleRequest()
   │
   ▼
serveStaticPage()
   │
   ▼
Read public/index.html
   │
   ▼
HTTP 200
   │
   ▼
Browser displays dashboard
```

---

# 48. Live Metrics Flow

The dashboard can then open:

```text
/nexus/dashboard/events
```

The flow becomes:

```text
Browser
   │
   ▼
SSE connection
   │
   ▼
Nexus
   │
   ▼
metrics.snapshot()
   │
   ▼
Full snapshot
   │
   ▼
Browser
   │
   │
   │ every 2 seconds
   ▼
metrics.snapshot()
   │
   ▼
diffSnapshot()
   │
   ├── Nothing changed → send nothing
   │
   └── Changed → send diff
```

---

# 49. REST Metrics Flow

For:

```text
GET /nexus/metrics
```

the flow is simpler:

```text
Client
   │
   ▼
Nexus
   │
   ▼
dashboard.matches()
   │
   ▼
dashboard.handleRequest()
   │
   ▼
serveMetricsSnapshot()
   │
   ▼
metrics.snapshot()
   │
   ▼
JSON response
```

---

# 50. Main Responsibilities of This File

| Responsibility        | What it does                                 |
| --------------------- | -------------------------------------------- |
| Dashboard UI          | Serves `index.html`                          |
| Live metrics          | Provides SSE stream                          |
| REST metrics          | Provides JSON snapshot                       |
| Snapshot diffing      | Sends only changed metrics                   |
| Connection management | Cleans up SSE timers                         |
| Dashboard routing     | Identifies dashboard requests                |
| Metrics integration   | Reads data from `metrics.snapshot()`         |
| Error handling        | Returns 500 if dashboard HTML cannot be read |

---

# 51. What This File Does NOT Do

This file does **not**:

* Select backend servers
* Perform load balancing
* Route application requests
* Authenticate normal API requests
* Proxy requests to `localhost:9001` or `localhost:9002`
* Perform health checks
* Apply rate limits

Those responsibilities belong to other Nexus modules.

This file is specifically responsible for the **Nexus monitoring dashboard and its metrics endpoints**.

---

# 52. The Simplest Mental Model

Think of this file as:

```text
                 Nexus Dashboard
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
     Web Page       Live Data      JSON Data
        │              │              │
        ▼              ▼              ▼
 index.html           SSE       /nexus/metrics
                       │
                       ▼
                metrics.snapshot()
```

And its relationship with the pipeline is:

```text
                    REQUEST
                       │
                       ▼
                 Nexus Pipeline
                       │
                 Dashboard?
                  /        \
                YES         NO
                 │           │
                 ▼           ▼
             Dashboard    Normal Flow
                           │
                     Rate Limiting
                           │
                         Router
                           │
                          Auth
                           │
                    Load Balancer
                           │
                        Backend
```

## In one sentence

**This file creates Nexus's dashboard service: it serves the dashboard UI, exposes current metrics through REST, streams live metric updates through SSE using efficient snapshot diffs, and integrates with the pipeline so dashboard requests bypass the normal backend proxy flow.**
