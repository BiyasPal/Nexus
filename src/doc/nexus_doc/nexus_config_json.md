# Nexus Configuration File Explained

## 1. What does this file do?

This JSON file tells **Nexus how it should run**.

It defines:

* Which ports Nexus should listen on
* Which backend servers are available
* Where incoming requests should be routed
* How backend health should be checked
* How many requests a client can make
* How API-key authentication works
* HTTPS/TLS configuration
* Logging configuration
* Write-Ahead Log (WAL) configuration
* Nexus dashboard configuration

In simple terms:

```text
                    ┌──────────────────┐
                    │      Client      │
                    │ Browser / Mobile │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │      NEXUS       │
                    │ Reverse Proxy /  │
                    │   API Gateway    │
                    └────────┬─────────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼                     ▼
          ┌──────────────┐      ┌──────────────┐
          │ Backend :9001│      │ Backend :9002│
          └──────────────┘      └──────────────┘
```

Nexus sits between the user and the actual backend servers.

---

# 2. What does Nexus do FIRST?

When Nexus starts, this configuration tells it to first set up its **listening ports**:

```json
"listen": {
    "http": 8080,
    "https": 8443
}
```

So Nexus opens:

```text
HTTP  → port 8080
HTTPS → port 8443
```

For example:

```text
http://localhost:8080
https://localhost:8443
```

The client sends the request to Nexus rather than directly to port `9001` or `9002`.

---

# 3. Backend Servers

Next, Nexus knows that the `web` backend has two servers:

```json
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
```

There are two backend instances:

```text
Backend 1 → localhost:9001
Backend 2 → localhost:9002
```

The `weight` is:

```text
9001 → weight 1
9002 → weight 1
```

Since both have the same weight, Nexus can distribute traffic approximately equally between them.

Example:

```text
Request 1 → :9001
Request 2 → :9002
Request 3 → :9001
Request 4 → :9002
```

This is the basic idea of **load balancing**.

---

# 4. Request Routing

The `routes` section tells Nexus where requests should go:

```json
"routes": [
    {
        "path": "/",
        "backend": "web"
    },
    {
        "path": "/api",
        "backend": "web"
    }
]
```

Both `/` and `/api` use the `web` backend.

For example:

```text
GET /
    ↓
Nexus
    ↓
web backend
    ↓
9001 or 9002
```

And:

```text
GET /api/users
    ↓
Nexus
    ↓
web backend
    ↓
9001 or 9002
```

So the route does **not** mean `/api` runs on a separate server. Both routes currently point to the same backend pool.

---

# 5. Health Checking

Nexus periodically checks whether the backend servers are alive.

```json
"healthcheck": {
    "path": "/health",
    "intervalMs": 5000,
    "unhealthyThreshold": 3,
    "healthyThreshold": 2
}
```

### `path`

```text
/health
```

Nexus sends requests such as:

```text
http://localhost:9001/health
http://localhost:9002/health
```

### `intervalMs`

```text
5000 ms = 5 seconds
```

Nexus checks the servers every 5 seconds.

### `unhealthyThreshold`

```text
3
```

If a server fails the health check 3 consecutive times, Nexus considers it unhealthy.

Example:

```text
Check 1 → FAIL
Check 2 → FAIL
Check 3 → FAIL

        ↓

Server marked UNHEALTHY
```

Nexus can then stop sending normal traffic to that server.

### `healthyThreshold`

```text
2
```

After a failed server starts responding successfully 2 consecutive times, Nexus considers it healthy again.

```text
Check 1 → SUCCESS
Check 2 → SUCCESS

        ↓

Server marked HEALTHY
```

---

# 6. Rate Limiting

```json
"ratelimit": {
    "windowMs": 60000,
    "maxRequests": 100
}
```

This protects Nexus from too many requests.

```text
windowMs = 60000 ms = 1 minute
maxRequests = 100
```

So the configuration allows:

```text
Maximum: 100 requests
Time: 1 minute
```

Conceptually:

```text
Client
  │
  │  101 requests in 1 minute
  ▼
Nexus
  │
  ├── First 100 → allowed
  │
  └── 101st → rate limited
```

---

# 7. Authentication

```json
"auth": {
    "headerName": "X-API-Key",
    "keys": [
        "dev-key-123"
    ],
    "requiredByDefault": false
}
```

Nexus supports API-key authentication.

The client can send:

```http
X-API-Key: dev-key-123
```

The configured valid key is:

```text
dev-key-123
```

However:

```json
"requiredByDefault": false
```

means authentication is **not required for every request by default**.

So this configuration enables API-key authentication, but does not globally force every route to use it.

> `dev-key-123` is clearly a development/test key. It should not be used as a real production secret.

---

# 8. HTTPS / TLS

```json
"tls": {
    "certPath": "./certs/cert.pem",
    "keyPath": "./certs/key.pem"
}
```

These files are used to enable HTTPS.

```text
cert.pem → TLS certificate
key.pem  → private key
```

Nexus uses them for the HTTPS listener:

```text
HTTPS → port 8443
```

So:

```text
https://localhost:8443
```

can accept encrypted HTTPS connections.

---

# 9. Logging

```json
"logging": {
    "level": "info",
    "format": "combined"
}
```

Nexus will generate logs.

### Log level

```text
info
```

This generally means normal operational information is logged.

For example:

```text
Request received
Backend selected
Backend health changed
Request completed
```

### Format

```text
combined
```

This specifies the format used when writing the logs.

---

# 10. WAL: Write-Ahead Log

```json
"wal": {
    "enabled": true,
    "path": "./data/wal",
    "flushIntervalMs": 1000,
    "maxFileSizeBytes": 10485760,
    "retainFiles": 5
}
```

WAL means **Write-Ahead Log**.

It provides a durable record of important operations/events so Nexus can recover information after a crash or restart, depending on what the Nexus implementation writes to the WAL.

### Enabled

```text
true
```

WAL is enabled.

### Storage location

```text
./data/wal
```

### Flush interval

```text
1000 ms = 1 second
```

The WAL is flushed approximately every second.

### Maximum file size

```text
10485760 bytes
```

which is:

```text
10 MB
```

### Retained files

```text
5
```

Nexus keeps up to 5 WAL files according to the application's WAL implementation.

---

# 11. Dashboard

```json
"dashboard": {
    "enabled": true,
    "path": "/nexus/dashboard",
    "pushIntervalMs": 2000
}
```

Nexus has a built-in dashboard.

It is enabled because:

```text
enabled = true
```

The dashboard is available at:

```text
/nexus/dashboard
```

So, through the HTTP listener, it would be:

```text
http://localhost:8080/nexus/dashboard
```

The dashboard receives/pushes updates every:

```text
2000 ms = 2 seconds
```

This can be used to monitor things such as Nexus activity, backend status, requests, or other metrics exposed by the implementation.

---

# 12. Complete Request Flow

Suppose a user sends:

```text
GET /api/users
```

to:

```text
http://localhost:8080
```

The overall process is approximately:

```text
                 Client
                   │
                   │ GET /api/users
                   ▼
           ┌─────────────────┐
           │      Nexus      │
           │    :8080        │
           └────────┬────────┘
                    │
                    ▼
             Check the route
                    │
                    │ /api → web
                    ▼
             Rate-limit check
                    │
                    ▼
          Authentication check
          (if required by route)
                    │
                    ▼
           Check backend health
                    │
             ┌──────┴──────┐
             ▼             ▼
         :9001           :9002
          web             web
             │             │
             └──────┬──────┘
                    │
                    ▼
                 Response
                    │
                    ▼
                 Client
```

---

# 13. In One Sentence

This configuration turns Nexus into a **reverse proxy/API gateway with load balancing, health checking, rate limiting, optional API-key authentication, HTTPS, logging, WAL persistence, and a monitoring dashboard**.

---

# 14. Quick Reference

| Configuration | Purpose                                        |
| ------------- | ---------------------------------------------- |
| `listen`      | Ports where Nexus accepts requests             |
| `backends`    | Backend servers Nexus can forward requests to  |
| `weight`      | Controls traffic distribution between backends |
| `routes`      | Maps incoming paths to backend pools           |
| `healthcheck` | Detects healthy/unhealthy backend servers      |
| `ratelimit`   | Limits requests per time window                |
| `auth`        | Configures API-key authentication              |
| `tls`         | Configures HTTPS certificates                  |
| `logging`     | Controls application logging                   |
| `wal`         | Stores durable operation/event information     |
| `dashboard`   | Enables the Nexus monitoring dashboard         |

# 15. The Most Important Mental Model

Think of this file as the **instruction manual for Nexus**:

```text
"Listen here."
       ↓
"These are my backend servers."
       ↓
"Send these URLs to those backends."
       ↓
"Don't send traffic to unhealthy servers."
       ↓
"Don't allow excessive requests."
       ↓
"Use API keys when authentication is required."
       ↓
"Support HTTPS."
       ↓
"Log what is happening."
       ↓
"Persist important information through WAL."
       ↓
"Show the system status on the dashboard."
```

So the JSON itself does **not perform these operations**. It is configuration data. The **Nexus application reads this file at startup and uses these values to configure its actual code**.
