# STDLIB.md — Nexus Zero-Dependency Log

Track: **C — Web & Network**
Runtime deps: **0**. Only `node:*` built-ins. Dev-only: `node:test` (built-in, no extra disclosure needed beyond this line).

Format per hackathon rule: `Normally: <package> → Instead: <stdlib>`

---

## Substitution Log (14 documented — clears STDLIB Log +3 bonus)

| # | Module | Normally | Instead (planned) | Actual detail |
|---|--------|----------|--------------------|--------------------------------------------------|
| 1 | `config.js` | `dotenv` / `convict` / `joi` | `node:fs.readFileSync` + `JSON.parse` + hand-rolled validator | _____ |
| 2 | `security/tls.js` | `mkcert` / `selfsigned` | `node:child_process.execSync('openssl ...')` + `node:https` | _____ |
| 3 | `observability/logger.js` | `winston` / `pino` | Hand-rolled leveled logger over `process.stdout.write` (+ `node:fs` for file target) | _____ |
| 4 | `observability/metrics.js` | `prom-client` | Plain in-memory counters (`Map`/object) + manual percentile calc | _____ |
| 5 | `routing/router.js` | `express` / `find-my-way` | Hand-rolled matcher over `node:url` | _____ |
| 6 | `routing/loadbalancer.js` | Cloud LB / `http-proxy` upstream logic | Hand-rolled round-robin index picker | _____ |
| 7 | `reliability/healthcheck.js` | `@godaddy/terminus` (or similar) | `node:http`/`node:https` GET on `setInterval` | _____ |
| 8 | `reliability/wal.js` | `level` / `sqlite3` | `node:fs.appendFile` + hand-rolled batching/rotation | _____ |
| 9 | `security/ratelimiter.js` | `express-rate-limit` | Hand-rolled token-bucket `Map` keyed by IP | _____ |
| 10 | `security/auth.js` | `jsonwebtoken` / `passport` | `node:crypto` HMAC sign/verify | _____ |
| 11 | `observability/dashboard.js` | `socket.io` | Raw SSE via `res.write` over `node:http` | _____ |
| 12 | `core/pipeline.js` | `express` / `koa` middleware chain | Hand-rolled ordered function-array executor | _____ |
| 13 | `core/server.js` | `pm2` / framework clustering | `node:http` + `node:https` + `node:cluster` | _____ |
| 14 | `cli.js` | `commander` / `yargs` | Hand-rolled `process.argv` parser | _____ |

> Fill "Actual detail" col right after finishing each file — real func/API name used, not just plan. Ex row 1: `validateConfig()` checks `listen`/`backends`/`routes`, throws named-missing-key error.

---

## Package Killer candidate (+3)

Pick ONE below to headline in README, delete other 3, write your own 2-3 line "why standalone-legit" blurb:

**Chosen module:** _____

**Blurb:** _____

Candidates (Claude's shortlist, pick from these):
- **`routing/router.js`** — mini `find-my-way`/`express.Router` (exact + prefix + longest-prefix-wins + optional regex).
- **`routing/loadbalancer.js`** — mini `http-proxy` upstream/LB logic (round-robin, weighted, health-aware).
- **`security/ratelimiter.js`** — mini `express-rate-limit` (token bucket, `Retry-After`, per-route override).
- **`security/auth.js`** — mini `jsonwebtoken`-lite (HMAC sign/verify + expiry, no full JWT claims).

## Dev-only tooling disclosure

- Test runner: `node:test` (built-in) — no external test framework added.
- CI: uses only what's already declared above; no dev dependency requiring disclosure beyond `node:test`.
- **Anything else added (coverage tool, linter, etc)?** Fill: _____

## Not implemented (Tier 3, explicitly out of scope)

Full list Claude wrote from checklist — **at final pass, delete any item you actually built as a stretch goal:**

OCSP stapling, mutual TLS, HTTP/2 via ALPN, full nginx directive/include grammar, distributed rate limiting, full PCRE regex, JWT claims/issuer/audience verification, OAuth2 delegated auth, zero-downtime binary upgrade, historical time-series persistence, log compaction, pluggable third-party middleware system.

**Anything else built that's not on either list?** Add here: _____