# Nexus Router Explained

## 1. What does this file do?

This file creates the **routing logic** for Nexus.

It receives information such as:

```text
Host     → example.com
Path     → /api/users
```

and compares it against the routes defined in:

```text
nexus.config.json
```

It then selects the **best matching route**.

For example, if the configuration contains:

```json
{
  "routes": [
    {
      "path": "/",
      "backend": "web"
    },
    {
      "path": "/api",
      "backend": "api"
    }
  ]
}
```

and the request is:

```text
GET /api/users
```

the router chooses:

```text
/api → api
```

instead of:

```text
/ → web
```

---

# 2. What does the code FIRST do?

The first function is:

```js
function stripPort(host) {
  return host ? host.split(':')[0].toLowerCase() : host;
}
```

Its job is to remove the **port number** from a hostname and convert the hostname to lowercase.

For example:

```text
localhost:8080
```

becomes:

```text
localhost
```

And:

```text
Example.COM:8443
```

becomes:

```text
example.com
```

This is useful because a route might specify:

```text
example.com
```

while the incoming request contains:

```text
example.com:8080
```

The router wants to compare only the hostname.

---

# 3. `hostMatches()`

```js
function hostMatches(route, host) {
  if (!route.host) return true;
  return stripPort(host) === route.host.toLowerCase();
}
```

This checks whether the request's hostname matches the route's hostname.

There are two cases.

### Case 1: Route doesn't specify a host

```json
{
  "path": "/api",
  "backend": "api"
}
```

There is no:

```text
host
```

So:

```js
if (!route.host) return true;
```

The route can match **any host**.

---

### Case 2: Route specifies a host

For example:

```json
{
  "host": "api.example.com",
  "path": "/users",
  "backend": "api"
}
```

A request to:

```text
api.example.com/users
```

matches.

But:

```text
www.example.com/users
```

does not match.

So this allows Nexus to support **host-based routing**.

---

# 4. `pathMatches()`

This function checks whether the incoming URL path matches a route.

```js
function pathMatches(route, pathname) {
```

It supports two types of matching:

```text
1. Regular expression matching
2. Normal path/prefix matching
```

---

# 5. Regex Routes

First:

```js
if (route.regex) {
```

If a route has a `regex` property, Nexus uses it.

For example:

```json
{
  "regex": "^/api/users/[0-9]+$",
  "backend": "api"
}
```

The code creates a JavaScript regular expression:

```js
new RegExp(route.regex)
```

and tests it against:

```text
pathname
```

For example:

```text
/api/users/123
```

could match.

---

## Invalid Regex

The code uses:

```js
try {
  return new RegExp(route.regex).test(pathname);
} catch {
  return false;
}
```

If someone writes an invalid regex, Nexus doesn't crash the router.

Instead:

```text
Invalid regex
     ↓
return false
     ↓
Route doesn't match
```

That's safer than allowing a bad route configuration to crash request processing.

---

# 6. Root Path

Next:

```js
if (route.path === '/') return true;
```

This means the root route:

```text
/
```

matches every pathname.

For example:

```text
/
 /about
 /api
 /api/users
 /products/123
```

can all match the `/` route.

This is useful as a **catch-all/default route**.

---

# 7. Exact Path Matching

Next:

```js
if (pathname === route.path) return true;
```

Suppose the route is:

```text
/api
```

and the request is:

```text
/api
```

Then it matches.

But the router doesn't stop there because `/api` can also represent a path prefix.

---

# 8. Path Prefix Matching

Finally:

```js
return pathname.startsWith(
  route.path.endsWith('/') ? route.path : `${route.path}/`
);
```

This allows a route such as:

```text
/api
```

to match:

```text
/api/users
/api/products
/api/orders/123
```

but not unrelated paths such as:

```text
/apixyz
```

That's important.

A simple:

```js
pathname.startsWith('/api')
```

would incorrectly match:

```text
/apixyz
```

The code instead checks:

```text
/api/
```

so the boundary is respected.

---

# 9. `specificity()`

This function decides which matching route is **more specific**.

```js
function specificity(route) {
```

This matters when multiple routes match the same request.

For example:

```text
/
 /api
 /api/users
```

A request to:

```text
/api/users/123
```

could technically match all three.

The router needs to choose:

```text
/api/users
```

because it is the most specific route.

---

# 10. Host-Specific Routes Get Priority

The code calculates:

```js
const hostBonus = route.host ? 1_000_000 : 0;
```

So:

```text
Route with host     → +1,000,000
Route without host  → +0
```

This means a host-specific route gets a huge priority advantage.

For example:

```text
Route A:
host = api.example.com
path = /

Route B:
host = none
path = /api
```

For a request to:

```text
api.example.com/api/users
```

the host-specific route can outrank the generic route because of the host bonus.

---

# 11. Longer Paths Get Higher Priority

The code also calculates:

```js
const pathLength = route.path ? route.path.length : 0;
```

So longer paths get a higher score.

For example:

```text
/              → length 1
/api           → length 4
/api/users     → length 10
/api/users/me  → length 13
```

Therefore:

```text
/api/users/me
```

is more specific than:

```text
/api/users
```

which is more specific than:

```text
/api
```

---

# 12. Final Specificity Score

The final score is:

```js
return hostBonus + pathLength;
```

So conceptually:

```text
Specificity =
    Host priority
    +
    Path length
```

The router then uses this score to choose the best route.

---

# 13. `createRouter()`

This is the main function exported by the file:

```js
export function createRouter(config) {
```

It receives the validated Nexus configuration.

It gets the routes:

```js
const routes = config.routes;
```

So if the configuration contains:

```json
"routes": [
  {
    "path": "/",
    "backend": "web"
  },
  {
    "path": "/api",
    "backend": "api"
  }
]
```

then the router stores these routes and uses them for matching.

---

# 14. The `match()` Function

Inside `createRouter()` we have:

```js
function match(pathname, host) {
```

This is the actual function that Nexus will call for every incoming request.

For example:

```js
router.match('/api/users', 'example.com:8080');
```

The router then tries to find the correct route.

---

# 15. Finding Candidate Routes

The first important operation is:

```js
const candidates = routes.filter(
  (route) => hostMatches(route, host) && pathMatches(route, pathname)
);
```

This means:

> Keep only routes where BOTH the host and path match.

Conceptually:

```text
All routes
    │
    ▼
Host matches?
    │
    ▼
Path matches?
    │
    ▼
Candidate routes
```

For example:

```text
Routes:

/                 → web
/api              → web
/api/users        → users
```

Request:

```text
/api/users/123
```

Potential matches:

```text
/          ✓
/api       ✓
/api/users ✓
```

So there are three candidates.

---

# 16. No Match

If there are no candidates:

```js
if (candidates.length === 0) return null;
```

The router returns:

```js
null
```

Important:

> The router itself does **not** send a 404 response.

Instead, another part of Nexus handles the `null` result and converts it into a 404 response.

So:

```text
Router
  │
  ├── Match found → return route
  │
  └── No match → return null
                         │
                         ▼
                  Request pipeline
                         │
                         ▼
                       404
```

This keeps the router focused only on routing.

---

# 17. Choosing the Winner

If multiple routes match:

```js
candidates.sort((a, b) => specificity(b) - specificity(a));
```

The candidates are sorted from:

```text
Most specific
      ↓
Least specific
```

Then:

```js
const winner = candidates[0];
```

takes the first one.

So the route with the highest specificity wins.

---

# 18. Example of Route Selection

Suppose Nexus has:

```json
[
  {
    "path": "/",
    "backend": "web"
  },
  {
    "path": "/api",
    "backend": "api"
  },
  {
    "path": "/api/users",
    "backend": "users"
  }
]
```

Request:

```text
GET /api/users/123
```

All three can match:

```text
/              → matches
/api            → matches
/api/users      → matches
```

Specificity:

```text
/              → 1
/api            → 4
/api/users      → 10
```

Winner:

```text
/api/users
```

Therefore Nexus knows:

```text
Backend → users
```

---

# 19. What Does the Router Return?

After finding the winner:

```js
return {
  path: winner.path,
  backend: winner.backend,
  host: winner.host || null,
  auth: winner.auth || null,
  rateLimit: winner.rateLimit || null
};
```

It returns a clean routing result.

For example:

```json
{
  "path": "/api/users",
  "backend": "users",
  "host": null,
  "auth": null,
  "rateLimit": null
}
```

This tells the next part of Nexus:

```text
Matched route:
    /api/users

Use backend:
    users

Authentication:
    none specified at route level

Rate limit:
    none specified at route level
```

---

# 20. Why Return `auth` and `rateLimit`?

The router itself doesn't perform authentication or rate limiting.

It only passes the route-specific configuration forward.

For example:

```json
{
  "path": "/admin",
  "backend": "admin",
  "auth": {
    "required": true
  }
}
```

The router can return:

```text
auth → { required: true }
```

Then another part of Nexus can perform the authentication.

Same idea for:

```text
rateLimit
```

So the architecture is separated:

```text
Router
  │
  ├── Finds route
  │
  ├── Finds backend
  │
  ├── Provides auth settings
  │
  └── Provides rate-limit settings
           │
           ▼
     Request Pipeline
           │
           ├── Authentication
           ├── Rate limiting
           └── Proxying
```

---

# 21. What Does `createRouter()` Return?

At the end:

```js
return { match };
```

So `createRouter()` returns an object containing the `match()` function.

Another part of Nexus can then do something like:

```js
const router = createRouter(config);

const route = router.match(
  request.url,
  request.headers.host
);
```

Then:

```text
route
  ↓
matched route information
```

---

# 22. Complete Flow of This File

The complete process is:

```text
                 Nexus receives request
                         │
                         ▼
                Host + pathname
                         │
                         ▼
                  router.match()
                         │
                         ▼
              ┌────────────────────┐
              │ Check every route  │
              └─────────┬──────────┘
                        │
                ┌───────┴────────┐
                ▼                ▼
          Host matches?     Path matches?
                │                │
                └───────┬────────┘
                        ▼
                  Matching routes
                        │
                        ▼
                Calculate specificity
                        │
                        ▼
                 Sort best → worst
                        │
                        ▼
                   Pick winner
                        │
                        ▼
              Return route information
                        │
                        ▼
               Request pipeline
```

---

# 23. Full Nexus Architecture So Far

With the files you've shown so far, the relationship is:

```text
                 nexus.config.json
                         │
                         ▼
                 ┌───────────────┐
                 │ config loader │
                 │  + validator  │
                 └───────┬───────┘
                         │
                         │ validated config
                         ▼
                 ┌───────────────┐
                 │     Router    │
                 └───────┬───────┘
                         │
                host + pathname
                         │
                         ▼
                 Find best route
                         │
                         ▼
                  Select backend
                         │
                         ▼
              ┌────────────────────┐
              │ Request Pipeline   │
              ├────────────────────┤
              │ Auth               │
              │ Rate Limiting      │
              │ Health Check       │
              │ Proxy              │
              │ Logging            │
              └─────────┬──────────┘
                        │
                        ▼
                 Backend Server
```

# 24. In One Sentence

**This file is Nexus's traffic decision-maker: for every incoming request, it checks the host and path, finds all matching routes, chooses the most specific one, and returns the backend plus any route-specific authentication or rate-limit settings.**
