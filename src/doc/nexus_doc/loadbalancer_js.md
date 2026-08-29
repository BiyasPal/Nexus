# Nexus Load Balancer Explained

## 1. What does this file do?

This file implements the **backend selection logic** for Nexus.

When Nexus has multiple backend servers inside a pool, this file chooses which backend should handle a particular request.

For example:

```text
web backend pool

├── http://localhost:9001
└── http://localhost:9002
```

The load balancer decides whether the request goes to:

```text
9001
```

or:

```text
9002
```

It supports three main strategies:

```text
1. Round-robin / weighted
2. Least connections
3. IP hash
```

It also keeps track of how many requests are currently running on each backend.

---

# 2. What does the code FIRST do?

The first function is:

```js
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
```

This function converts a string into a number.

It is mainly used by the **IP-hash load-balancing strategy**.

For example:

```text
Client IP
    ↓
"192.168.1.10"
    ↓
hashString()
    ↓
some number
    ↓
select backend
```

The important idea is:

> The same IP will produce the same hash, so it can consistently select the same backend while the candidate list remains the same.

---

# 3. How `hashString()` works

It starts with:

```js
let hash = 0;
```

Then it goes through every character:

```js
for (let i = 0; i < str.length; i += 1)
```

For every character, it calculates:

```js
hash = (hash * 31 + str.charCodeAt(i)) | 0;
```

`charCodeAt()` converts a character into a number.

For example:

```text
"a" → 97
"b" → 98
```

The `31` is used to mix the characters together and produce a distributed hash value.

Finally:

```js
return Math.abs(hash);
```

makes sure the result is positive.

This is **not a cryptographic hash**. It is simply a lightweight deterministic hash used for backend selection.

---

# 4. `createLoadBalancer()`

The main function is:

```js
export function createLoadBalancer(backends, healthChecker, logger) {
```

It creates a load balancer using:

```text
backends
healthChecker
logger
```

### `backends`

This comes from:

```text
config.backends
```

For example:

```js
{
  web: [
    {
      url: 'http://localhost:9001',
      weight: 1
    },
    {
      url: 'http://localhost:9002',
      weight: 1
    }
  ]
}
```

### `healthChecker`

This is the health-checking component.

It tells the load balancer:

```text
Which backend servers are currently healthy?
```

### `logger`

Used to log events such as:

```text
No healthy backends available
```

---

# 5. Logger Setup

The first thing inside `createLoadBalancer()` is:

```js
const log = logger || console;
```

This means:

```text
If a logger was provided
        ↓
use it

Otherwise
        ↓
use console
```

So the code can safely do:

```js
log.warn(...)
```

even when no custom logger was supplied.

---

# 6. Weighted Round-Robin State

Next:

```js
const weightedState = new Map();
```

This stores the current state of the **weighted round-robin algorithm**.

It is organized conceptually like:

```text
Pool
 │
 ├── Backend URL → current weight
 ├── Backend URL → current weight
 └── ...
```

Why is this needed?

Because weighted round-robin needs to remember previous selections so that traffic is distributed according to backend weights over time.

---

# 7. In-Flight Request Tracking

Next:

```js
const inFlight = new Map();
```

This tracks how many requests are currently active on each backend.

For example:

```text
web

9001 → 3 active requests
9002 → 1 active request
```

This information is needed for:

```text
least-conn
```

and is also exposed to the dashboard.

---

# 8. `poolBackends()`

```js
function poolBackends(poolName) {
  return backends[poolName] || [];
}
```

This retrieves the backend servers belonging to a pool.

For example:

```js
poolBackends('web')
```

returns:

```text
[
  :9001,
  :9002
]
```

If the pool doesn't exist:

```js
backends[poolName]
```

will be undefined.

The function safely returns:

```text
[]
```

instead.

---

# 9. `healthyCandidates()`

```js
function healthyCandidates(poolName) {
  if (healthChecker) {
    return healthChecker.getHealthyBackends(poolName);
  }
  return poolBackends(poolName);
}
```

This is very important.

The load balancer should normally only send traffic to **healthy servers**.

If a health checker exists:

```text
Health Checker
      ↓
Healthy backends
      ↓
Load Balancer
```

For example:

```text
Configured:

9001 → healthy
9002 → unhealthy

        ↓

Candidates:

9001 only
```

If no health checker is provided, the code assumes all configured backends are healthy.

This is useful for testing or when health checking has not been connected yet.

---

# 10. `inFlightMapFor()`

```js
function inFlightMapFor(poolName) {
  let map = inFlight.get(poolName);

  if (!map) {
    map = new Map();
    inFlight.set(poolName, map);
  }

  return map;
}
```

This gets the request-count map for a particular pool.

For example:

```text
web
 │
 ├── :9001 → 4
 └── :9002 → 2
```

If the pool doesn't have a map yet, it creates one.

---

# 11. `connectionCount()`

```js
function connectionCount(poolName, url) {
  return inFlightMapFor(poolName).get(url) || 0;
}
```

This tells us how many requests are currently in progress for a backend.

Example:

```js
connectionCount('web', 'http://localhost:9001')
```

could return:

```text
4
```

meaning 4 requests are currently in flight.

---

# 12. Round-Robin Load Balancing

The function:

```js
function pickRoundRobin(poolName, candidates) {
```

selects a backend using **smooth weighted round-robin**.

Suppose:

```text
9001 → weight 1
9002 → weight 1
```

The traffic will be approximately:

```text
9001
9002
9001
9002
...
```

If instead:

```text
9001 → weight 3
9002 → weight 1
```

then over many requests, approximately:

```text
9001 → 75%
9002 → 25%
```

The weights don't have to be percentages. They define the relative share.

---

# 13. Calculating Total Weight

Inside the function:

```js
const totalWeight = candidates.reduce(
  (sum, b) => sum + (b.weight || 1),
  0
);
```

This adds all backend weights.

For:

```text
9001 → 3
9002 → 1
```

the total is:

```text
3 + 1 = 4
```

---

# 14. Selecting the Winner

For each backend:

```js
const weight = backend.weight || 1;
const current = (currentWeights.get(backend.url) || 0) + weight;
```

The current weight is increased by the backend's configured weight.

Then the backend with the highest current value becomes the winner:

```js
if (current > winnerWeight) {
  winnerWeight = current;
  winner = backend;
}
```

After selecting the winner:

```js
currentWeights.set(
  winner.url,
  winnerWeight - totalWeight
);
```

The winner's current weight is reduced by the total weight.

This creates the **smooth weighted round-robin** behavior.

---

# 15. Why "Smooth" Round-Robin?

A normal weighted algorithm might produce traffic in large groups.

For example:

```text
9001
9001
9001
9002
```

Smooth weighted round-robin tries to distribute the requests more evenly over time.

For:

```text
9001 → weight 3
9002 → weight 1
```

you might see a pattern closer to:

```text
9001
9001
9002
9001
9001
9002
...
```

The exact sequence depends on the algorithm's state.

The important point is:

> Higher-weight backends receive more traffic, while the distribution remains relatively smooth.

---

# 16. Least-Connections Strategy

The next strategy is:

```js
function pickLeastConnections(poolName, candidates) {
```

Instead of looking at weights, it looks at how many requests each backend is currently handling.

Suppose:

```text
9001 → 8 active requests
9002 → 3 active requests
```

The load balancer chooses:

```text
9002
```

because it currently has fewer connections.

The code starts with:

```js
let winner = candidates[0];
let winnerCount = connectionCount(poolName, winner.url);
```

Then checks the remaining candidates:

```js
for (const backend of candidates.slice(1)) {
```

If another backend has fewer connections:

```js
if (count < winnerCount) {
  winner = backend;
  winnerCount = count;
}
```

it becomes the new winner.

---

# 17. Why Least Connections is Useful

Imagine two servers:

```text
Server A → 10 active requests
Server B → 2 active requests
```

A new request comes in.

Round-robin might choose:

```text
Server A
```

But least-connections chooses:

```text
Server B
```

because it has less current work.

This can be useful when requests have very different processing times.

---

# 18. IP Hash Strategy

The function:

```js
function pickIpHash(candidates, clientIp) {
```

uses the client's IP address to select a backend.

First:

```js
if (!clientIp) return candidates[0];
```

If there is no IP address, it simply uses the first candidate.

Otherwise:

```js
const index = hashString(clientIp) % candidates.length;
```

The IP is converted into a number and then mapped to one of the available backend indexes.

For example:

```text
Client IP
192.168.1.10
       ↓
hashString()
       ↓
123456
       ↓
123456 % 2
       ↓
0
       ↓
Backend 9001
```

Another IP might produce:

```text
1
↓
Backend 9002
```

---

# 19. Why Use IP Hash?

The main idea is **consistent backend selection**.

For example:

```text
Client A
IP: 10.0.0.5

       ↓

9001
```

Repeated requests from that client can continue selecting the same backend as long as the candidate list/order remains unchanged.

This can be useful when an application benefits from a client repeatedly reaching the same backend.

---

# 20. The Main `pick()` Function

This is the most important function in the file:

```js
function pick(poolName, options = {}) {
```

This is what the rest of Nexus calls when it needs a backend.

For example:

```js
loadBalancer.pick('web');
```

By default:

```js
strategy = 'round-robin'
```

So if no strategy is specified, round-robin is used.

---

# 21. Getting Healthy Backends

The first major operation inside `pick()` is:

```js
const candidates = healthyCandidates(poolName);
```

So the process is:

```text
Backend Pool
     ↓
Health Checker
     ↓
Healthy Backends
     ↓
Load Balancer
```

This prevents Nexus from deliberately sending traffic to a backend that has been marked unhealthy.

---

# 22. No Healthy Backend

The code checks:

```js
if (candidates.length === 0) {
  log.warn(`no healthy backends available for pool "${poolName}"`);
  return null;
}
```

If every backend is unhealthy:

```text
9001 → unhealthy
9002 → unhealthy
```

then:

```text
pick()
   ↓
null
```

The load balancer does **not** create the HTTP error response itself.

The request pipeline handles the `null` result and can turn it into a:

```text
502 Bad Gateway
```

---

# 23. Selecting the Strategy

The code then uses:

```js
switch (strategy) {
```

There are three supported strategies.

### Round-robin

```js
case 'round-robin':
case 'weighted':
  return pickRoundRobin(poolName, candidates);
```

Both names currently use the same smooth weighted round-robin implementation.

---

### Least connections

```js
case 'least-conn':
  return pickLeastConnections(poolName, candidates);
```

Chooses the backend with the fewest active connections.

---

### IP hash

```js
case 'ip-hash':
  return pickIpHash(candidates, clientIp);
```

Uses the client IP to select a backend.

---

# 24. Unknown Strategy

If someone writes:

```text
strategy = "random"
```

the code reaches:

```js
default:
  throw new Error(
    `Unknown load balancer strategy: "${strategy}"`
  );
```

So Nexus doesn't silently use a wrong strategy.

It reports the configuration/programming error.

---

# 25. Recording a Connection Start

After a backend is selected and the request begins:

```js
recordConnectionStart(poolName, url)
```

can be called.

The function:

```js
function recordConnectionStart(poolName, url) {
```

increments the backend's active request count.

For example:

```text
Before:

9001 → 3
```

A new request starts:

```text
After:

9001 → 4
```

This information is important for the least-connection strategy.

---

# 26. Recording a Connection End

When the request finishes:

```js
recordConnectionEnd(poolName, url)
```

is called.

Suppose:

```text
9001 → 4 active requests
```

One request finishes:

```text
9001 → 3 active requests
```

The code also prevents the count from becoming negative:

```js
map.set(url, next < 0 ? 0 : next);
```

So:

```text
0 - 1
```

doesn't become:

```text
-1
```

It stays:

```text
0
```

---

# 27. Getting Connection Counts

The dashboard or other parts of Nexus can call:

```js
getConnectionCounts(poolName)
```

The function returns information like:

```json
[
  {
    "url": "http://localhost:9001",
    "inFlight": 4
  },
  {
    "url": "http://localhost:9002",
    "inFlight": 2
  }
]
```

This can be displayed in the dashboard as:

```text
Backend             Active Requests

localhost:9001      4
localhost:9002      2
```

---

# 28. What Does the File Finally Return?

At the end:

```js
return {
  pick,
  recordConnectionStart,
  recordConnectionEnd,
  getConnectionCounts
};
```

So other Nexus modules receive these four functions:

```text
pick()
recordConnectionStart()
recordConnectionEnd()
getConnectionCounts()
```

The internal helper functions remain private to this module.

---

# 29. Complete Request Flow

Suppose the router has already decided:

```text
/api/users → web
```

and the `web` pool contains:

```text
9001
9002
```

The flow becomes:

```text
                    Client Request
                          │
                          ▼
                       Router
                          │
                          ▼
                  Backend pool: web
                          │
                          ▼
                    Load Balancer
                          │
                    Check health
                          │
                 ┌────────┴────────┐
                 │                 │
              Healthy           Unhealthy
                 │                 │
                 ▼                 X
             Candidates
                 │
                 ▼
          Select strategy
                 │
       ┌─────────┼─────────┐
       │         │         │
       ▼         ▼         ▼
  Round-robin Least-conn IP-hash
       │         │         │
       └─────────┼─────────┘
                 │
                 ▼
          Selected backend
                 │
                 ▼
              Proxy
                 │
                 ▼
           Backend server
```

---

# 30. How It Connects With the Router

The router and load balancer have different responsibilities.

### Router

Answers:

```text
"Which backend pool should handle this request?"
```

Example:

```text
/api/users
     ↓
web
```

### Load Balancer

Answers:

```text
"Which server inside that pool should handle it?"
```

Example:

```text
web
 ↓
9002
```

Together:

```text
Request: /api/users
          │
          ▼
       Router
          │
          │ backend = web
          ▼
    Load Balancer
          │
          │ selected = 9002
          ▼
 http://localhost:9002
```

---

# 31. How Health Checking Connects

The load balancer also works with the health checker.

Suppose:

```text
9001 → healthy
9002 → unhealthy
```

The health checker reports:

```text
healthyCandidates()
       ↓
9001
```

The load balancer then has only one candidate:

```text
9001
```

Therefore:

```text
Request
   ↓
Load Balancer
   ↓
9001
```

When `9002` becomes healthy again:

```text
9001 → healthy
9002 → healthy
```

both become candidates again.

---

# 32. Simple Example

Suppose the configuration contains:

```json
{
  "backends": {
    "web": [
      {
        "url": "http://localhost:9001",
        "weight": 1
      },
      {
        "url": "http://localhost:9002",
        "weight": 1
      }
    ]
  }
}
```

And Nexus receives four requests.

With round-robin:

```text
Request 1 → 9001
Request 2 → 9002
Request 3 → 9001
Request 4 → 9002
```

With least connections, the result depends on the current active requests:

```text
9001 → 5 active
9002 → 2 active

New request
     ↓
9002
```

With IP hash:

```text
Client A → 9001
Client A → 9001
Client A → 9001

Client B → 9002
Client B → 9002
```

The exact IP-to-backend mapping depends on the hash and current candidate list.

---

# 33. The Most Important Mental Model

Think of the load balancer as a **traffic distributor**.

```text
             Backend Pool: web
                    │
          ┌─────────┴─────────┐
          │                   │
       Server 1            Server 2
        :9001                :9002
          ▲                   ▲
          │                   │
          └─────────┬─────────┘
                    │
              Load Balancer
                    ▲
                    │
                 Request
```

The load balancer decides **which server gets the request**.

It can make that decision based on:

```text
Round-robin
      ↓
Distribute requests according to weights

Least-connections
      ↓
Send to the server handling fewer requests

IP-hash
      ↓
Use client IP to select a consistent server
```

# 34. In One Sentence

**This file is Nexus's backend traffic distributor: it takes a backend pool, removes unhealthy servers, chooses a healthy server using round-robin, least-connections, or IP-hash, tracks active requests, and exposes those connection counts to the rest of Nexus and the dashboard.**
