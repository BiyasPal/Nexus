# Nexus Config Loader and Validator

## 1. What does this file do?

This file is responsible for:

1. Finding the Nexus configuration file.
2. Reading it from disk.
3. Parsing the JSON.
4. Checking that required configuration exists.
5. Validating important sections such as `listen`, `backends`, and `routes`.
6. Adding default values for optional sections.
7. Returning a complete configuration object to the rest of the Nexus application.

The basic flow is:

```text
nexus.config.json
       │
       ▼
   loadConfig()
       │
       ▼
 Read file from disk
       │
       ▼
   JSON.parse()
       │
       ▼
 validateConfig()
       │
       ├── Check required keys
       ├── Check listen
       ├── Check backends
       ├── Check routes
       └── Add default values
       │
       ▼
 Validated Nexus Config
       │
       ▼
 Rest of Nexus application
```

---

# 2. What does the code FIRST do?

The first line is:

```js
import fs from 'node:fs';
```

This imports Node.js's built-in **File System (`fs`) module**.

Nexus needs this because the configuration is stored in a file:

```text
nexus.config.json
```

The `fs` module allows the code to read that file from disk.

For example:

```js
fs.readFileSync(...)
```

is later used to read the configuration.

---

# 3. Default Configuration Path

```js
export const DEFAULT_CONFIG_PATH = './nexus.config.json';
```

This defines where Nexus expects its configuration file by default.

So if we simply call:

```js
loadConfig();
```

Nexus will try to read:

```text
./nexus.config.json
```

The `export` means other files can use this value too.

For example:

```js
import { DEFAULT_CONFIG_PATH } from './config.js';
```

---

# 4. Required Configuration

```js
const REQUIRED_KEYS = ['listen', 'backends', 'routes'];
```

These are the three sections that **must exist** in the configuration.

Therefore, this is valid:

```json
{
  "listen": {},
  "backends": {},
  "routes": []
}
```

At least the keys exist, although later validation will make sure their contents are also valid.

But this is invalid:

```json
{
  "listen": {}
}
```

because:

```text
backends → missing
routes   → missing
```

---

# 5. Default Values

The `DEFAULTS` object contains fallback values for optional configuration sections.

For example:

```js
healthcheck: {
  path: '/health',
  intervalMs: 5000,
  unhealthyThreshold: 3,
  healthyThreshold: 2
}
```

If the user doesn't provide a health-check configuration, Nexus uses these values.

The same idea applies to:

```text
healthcheck
ratelimit
auth
tls
logging
wal
dashboard
```

Important difference:

```text
Required:
listen
backends
routes

Optional:
healthcheck
ratelimit
auth
tls
logging
wal
dashboard
```

---

# 6. Why are Defaults Needed?

Suppose the user writes:

```json
{
  "listen": {
    "http": 8080
  },
  "backends": {
    "web": [
      {
        "url": "http://localhost:9001"
      }
    ]
  },
  "routes": [
    {
      "path": "/",
      "backend": "web"
    }
  ]
}
```

They didn't specify:

```text
healthcheck
ratelimit
auth
tls
logging
wal
dashboard
```

Instead of making every other Nexus module do this:

```js
if (config.healthcheck) {
   ...
}
```

this file creates those sections automatically.

So after validation, the configuration will contain:

```text
config.healthcheck
config.ratelimit
config.auth
config.tls
config.logging
config.wal
config.dashboard
```

even if the user didn't provide them.

This makes the rest of the application simpler.

---

# 7. `mergeSection()`

```js
function mergeSection(userSection, defaultSection) {
  return { ...defaultSection, ...(userSection || {}) };
}
```

This function combines:

```text
Default configuration
        +
User configuration
        =
Final configuration
```

For example, suppose the default is:

```js
{
  windowMs: 60000,
  maxRequests: 100,
  burst: 0
}
```

and the user provides:

```js
{
  maxRequests: 200
}
```

The result becomes:

```js
{
  windowMs: 60000,
  maxRequests: 200,
  burst: 0
}
```

So the user only needs to specify what they want to change.

---

# 8. `assertRequiredKeys()`

```js
function assertRequiredKeys(raw) {
  for (const key of REQUIRED_KEYS) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new Error(`Invalid nexus config: missing required key "${key}"`);
    }
  }
}
```

This checks whether:

```text
listen
backends
routes
```

exist.

It loops through:

```js
REQUIRED_KEYS
```

and checks each key.

If something is missing, Nexus immediately throws an error.

For example:

```text
Invalid nexus config: missing required key "backends"
```

This is called **validation**.

---

# 9. `assertListen()`

```js
function assertListen(listen) {
  if (typeof listen !== 'object' || (!listen.http && !listen.https)) {
    throw new Error(
      'Invalid nexus config: "listen" must define an "http" and/or "https" port'
    );
  }
}
```

This checks the `listen` configuration.

Nexus requires at least one of:

```text
http
https
```

For example:

```json
"listen": {
  "http": 8080
}
```

is valid.

Also:

```json
"listen": {
  "https": 8443
}
```

is valid.

And:

```json
"listen": {
  "http": 8080,
  "https": 8443
}
```

is valid.

But:

```json
"listen": {}
```

is invalid.

---

# 10. `assertBackends()`

```js
function assertBackends(backends) {
```

This validates the backend configuration.

The expected structure is:

```text
backends
   │
   └── backend name
          │
          └── array of servers
```

For example:

```json
"backends": {
  "web": [
    {
      "url": "http://localhost:9001"
    },
    {
      "url": "http://localhost:9002"
    }
  ]
}
```

The function checks three important things.

### Check 1: Backends must be an object

```js
if (typeof backends !== 'object' || Array.isArray(backends))
```

This prevents something like:

```json
"backends": []
```

or:

```json
"backends": "hello"
```

---

### Check 2: Every backend must contain at least one server

```js
if (!Array.isArray(pool) || pool.length === 0)
```

This would be invalid:

```json
"backends": {
  "web": []
}
```

because Nexus has no server to forward traffic to.

---

### Check 3: Every server must have a URL

```js
if (!entry || typeof entry.url !== 'string')
```

This is valid:

```json
{
  "url": "http://localhost:9001"
}
```

This is invalid:

```json
{
  "port": 9001
}
```

because there is no `url`.

---

# 11. `assertRoutes()`

```js
function assertRoutes(routes, backends) {
```

This validates the routing configuration.

For example:

```json
"routes": [
  {
    "path": "/api",
    "backend": "web"
  }
]
```

The function checks:

### Check 1: Routes must be an array

```js
if (!Array.isArray(routes) || routes.length === 0)
```

There must be at least one route.

---

### Check 2: Every route needs a path

```js
if (!route || typeof route.path !== 'string')
```

For example:

```json
{
  "path": "/api",
  "backend": "web"
}
```

is valid.

---

### Check 3: The backend must actually exist

This is very important:

```js
if (typeof route.backend !== 'string' || !(route.backend in backends))
```

Suppose the configuration contains:

```json
"backends": {
  "web": [...]
}
```

but the route says:

```json
{
  "path": "/api",
  "backend": "api-server"
}
```

There is no:

```text
api-server
```

backend.

Therefore Nexus throws an error.

This prevents a route from pointing to a backend that doesn't exist.

---

# 12. `validateConfig()`

This is the main validation function:

```js
export function validateConfig(raw) {
```

It receives the raw JSON object and validates everything.

First:

```js
if (!raw || typeof raw !== 'object') {
  throw new Error('Invalid nexus config: root must be a JSON object');
}
```

So the root of the configuration must be an object.

Then it performs validation in this order:

```js
assertRequiredKeys(raw);
assertListen(raw.listen);
assertBackends(raw.backends);
assertRoutes(raw.routes, raw.backends);
```

So:

```text
1. Check root
       ↓
2. Check required keys
       ↓
3. Check listen
       ↓
4. Check backends
       ↓
5. Check routes
```

After everything is valid, it creates the final configuration.

---

# 13. Creating the Final Configuration

The function returns:

```js
return {
  listen: { ...raw.listen },
  backends: raw.backends,
  routes: raw.routes,
  healthcheck: mergeSection(raw.healthcheck, DEFAULTS.healthcheck),
  ratelimit: mergeSection(raw.ratelimit, DEFAULTS.ratelimit),
  auth: mergeSection(raw.auth, DEFAULTS.auth),
  tls: mergeSection(raw.tls, DEFAULTS.tls),
  logging: mergeSection(raw.logging, DEFAULTS.logging),
  wal: mergeSection(raw.wal, DEFAULTS.wal),
  dashboard: mergeSection(raw.dashboard, DEFAULTS.dashboard)
};
```

This is where the **complete configuration object** is created.

Required sections come from the user's config.

Optional sections are merged with defaults.

---

# 14. `loadConfig()`

This is the function that actually loads the configuration file:

```js
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
```

If no path is provided:

```text
./nexus.config.json
```

is used.

---

# 15. Reading the File

First:

```js
contents = fs.readFileSync(configPath, 'utf8');
```

This reads the JSON file from disk.

For example:

```text
nexus.config.json
       │
       ▼
fs.readFileSync()
       │
       ▼
JSON text
```

---

# 16. Missing File Handling

If the file doesn't exist:

```js
if (err.code === 'ENOENT') {
  throw new Error(`Config file not found: ${configPath}`);
}
```

Instead of producing a confusing Node.js error, Nexus gives a clear message:

```text
Config file not found: ./nexus.config.json
```

This is called **fail fast**.

Nexus doesn't continue running with an unknown configuration.

---

# 17. Parsing JSON

After reading the file:

```js
raw = JSON.parse(contents);
```

This converts:

```text
JSON text
   ↓
JavaScript object
```

For example:

```json
{
  "listen": {
    "http": 8080
  }
}
```

becomes a JavaScript object that the application can work with.

---

# 18. Invalid JSON Handling

If the JSON contains a syntax error:

```js
try {
  raw = JSON.parse(contents);
} catch (err) {
  throw new Error(`Invalid JSON in config file ${configPath}: ${err.message}`);
}
```

Nexus reports something like:

```text
Invalid JSON in config file ./nexus.config.json: ...
```

So again, the error is easier to understand.

---

# 19. Final Step

Finally:

```js
return validateConfig(raw);
```

The parsed configuration is passed to:

```text
validateConfig()
```

which checks everything and adds defaults.

Therefore:

```text
loadConfig()
     │
     ├── Read file
     │
     ├── Parse JSON
     │
     └── validateConfig()
             │
             ├── Validate
             └── Add defaults
                    │
                    ▼
             Final Config
```

---

# 20. Complete Nexus Startup Flow

When another part of Nexus does:

```js
const config = loadConfig();
```

the complete process is:

```text
                Nexus starts
                     │
                     ▼
              loadConfig()
                     │
                     ▼
        Find nexus.config.json
                     │
                     ▼
              Read the file
                     │
                     ▼
              Parse JSON
                     │
                     ▼
            validateConfig()
                     │
          ┌──────────┴───────────┐
          │                      │
          ▼                      ▼
     Validate required       Add defaults
       configuration
          │                      │
          └──────────┬───────────┘
                     ▼
            Validated Config
                     │
                     ▼
             Nexus Components
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
    Proxy        Rate Limit     Dashboard
       │
       ▼
   Backends
```

---

# 21. The Most Important Concept

There are **two different things** here:

### `nexus.config.json`

This contains the **configuration/data**:

```text
"listen": 8080
"backends": ...
"routes": ...
```

### This JavaScript file

This contains the **logic that processes that configuration**:

```text
Read
 ↓
Parse
 ↓
Validate
 ↓
Fill defaults
 ↓
Return clean config
```

So the relationship is:

```text
nexus.config.json
       │
       │ configuration data
       ▼
config.js
       │
       │ reads + validates + defaults
       ▼
Validated Config Object
       │
       ▼
Nexus Application
```

# 22. In One Sentence

**This file is the gatekeeper for Nexus configuration: it reads `nexus.config.json`, makes sure the configuration is valid, fills in missing optional settings with defaults, and returns a safe, complete configuration object for the rest of Nexus to use.**
