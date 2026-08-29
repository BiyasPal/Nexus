import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const REQUIRED_DEPS = ['config', 'metrics', 'router', 'loadBalancer', 'rateLimiter', 'authenticator'];

function assertDeps(deps) {
    for (const key of REQUIRED_DEPS) {
        if (!deps[key]) {
            throw new Error(`createPipeline requires a "${key}" dependency`);
        }
    }
}

function extractClientIp(req) {
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function parseRequestUrl(req) {
    const hostHeader = req.headers.host || 'localhost';
    return new URL(req.url, `http://${hostHeader}`);
}

function isEncrypted(req) {
    return Boolean(req.socket && req.socket.encrypted);
}

/**
 * Wire every module (config/router/loadBalancer/healthChecker/wal/
 * ratelimiter/authenticator/metrics/logger/dashboard) into the actual
 * per-request handler.
 *
 * nginx equivalent: nginx's request-processing phase engine.
 * Zero-dep swap for express/koa's middleware chain: a hand-rolled ordered
 * function-array executor (see `phases` below) - each phase gets the same
 * per-request `ctx` object and returns `true` once it has fully handled
 * (terminated) the response, or a falsy value to fall through to the next
 * phase. See src/doc/features/12-pipeline.md for the required order.
 *
 * PHASE ORDER (do not reorder without re-reading the doc above - this is
 * the highest-risk file for ordering bugs):
 *   static/dashboard routes -> rate limit -> route match -> auth check
 *     -> backend selection -> forward to backend
 *
 * `deps.dashboard`, if provided, is expected to implement the contract
 * observability/dashboard.js owns:
 *   matches(pathname): boolean   - true if this request belongs to the
 *                                  dashboard (SSE feed, REST snapshot, the
 *                                  static page, ...) and should never be
 *                                  proxied or counted in pipeline metrics
 *   handleRequest(req, res): void - fully owns req/res from here on;
 *                                  pipeline does not touch it again
 * dashboard.js hasn't landed yet in this repo, so this phase is a no-op
 * (falls through to the normal proxy flow) until `deps.dashboard` and
 * `config.dashboard.enabled` are both present.
 */
export function createPipeline(deps) {
    assertDeps(deps);

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

    const dashboardEnabled = Boolean(dashboard && config.dashboard && config.dashboard.enabled);

    function buildContext(req, res, parsedUrl) {
        return {
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
        };
    }

    /**
     * Fires exactly once per non-dashboard request, however it ends -
     * 429/404/401/502/success all funnel through `res.end()` eventually,
     * which is what drives this. This is what guarantees
     * `metrics.recordRequest()` never gets skipped by an early return.
     */
    function onFinish(ctx) {
        const durationMs = Date.now() - ctx.startedAt;

        metrics.recordRequest({
            route: ctx.route,
            backend: ctx.backendPool,
            status: ctx.res.statusCode,
            durationMs
        });

        if (typeof logger.logRequest === 'function') {
            logger.logRequest({
                method: ctx.method,
                path: ctx.pathname,
                status: ctx.res.statusCode,
                durationMs
            });
        }
    }

    function respondError(ctx, statusCode, message, extraHeaders = {}) {
        if (ctx.res.headersSent) {
            ctx.res.end();
            return;
        }

        ctx.res.statusCode = statusCode;
        for (const [key, value] of Object.entries(extraHeaders)) {
            ctx.res.setHeader(key, value);
        }
        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify({ error: message }));
    }

    // --- phases ------------------------------------------------------------

    function rateLimitPhase(ctx) {
        const result = rateLimiter.checkLimit(ctx.clientIp);

        if (!result.allowed) {
            const headers = result.retryAfterSeconds != null
                ? { 'Retry-After': String(result.retryAfterSeconds) }
                : {};
            respondError(ctx, 429, 'rate limit exceeded', headers);
            return true;
        }

        return false;
    }

    function routeMatchPhase(ctx) {
        const matched = router.match(ctx.pathname, ctx.host);

        if (!matched) {
            // Unmatched path is 404, never proceeds to an auth check.
            respondError(ctx, 404, 'not found');
            return true;
        }

        ctx.route = matched.path;
        ctx.backendPool = matched.backend;
        ctx.routeAuth = matched.auth;
        return false;
    }

    function authPhase(ctx) {
        const result = authenticator.authenticate(ctx.req.headers, ctx.routeAuth, ctx.route);

        if (!result.authenticated) {
            respondError(ctx, 401, 'unauthorized');
            return true;
        }

        return false;
    }

    function backendPhase(ctx) {
        const backend = loadBalancer.pick(ctx.backendPool, { clientIp: ctx.clientIp });

        if (!backend) {
            // Never reached a backend, so WAL is deliberately not involved here.
            respondError(ctx, 502, 'no healthy backends available');
            return true;
        }

        forwardToBackend(ctx, backend);
        return true;
    }

    function forwardToBackend(ctx, backend) {
        let targetUrl;
        try {
            targetUrl = new URL(ctx.req.url, backend.url);
        } catch (err) {
            respondError(ctx, 502, 'bad gateway');
            return;
        }

        const client = targetUrl.protocol === 'https:' ? https : http;
        const requestId = ctx.requestId;

        loadBalancer.recordConnectionStart(ctx.backendPool, backend.url);
        if (wal) {
            wal.recordStart(requestId, { method: ctx.method, path: ctx.pathname, backend: backend.url });
        }

        const outboundHeaders = { ...ctx.req.headers, host: targetUrl.host };
        const existingXff = ctx.req.headers['x-forwarded-for'];
        outboundHeaders['x-forwarded-for'] = existingXff ? `${existingXff}, ${ctx.clientIp}` : ctx.clientIp;
        outboundHeaders['x-forwarded-proto'] = isEncrypted(ctx.req) ? 'https' : 'http';

        const proxyReq = client.request(targetUrl, { method: ctx.method, headers: outboundHeaders }, (backendRes) => {
            ctx.res.writeHead(backendRes.statusCode, backendRes.headers);
            backendRes.pipe(ctx.res);
            backendRes.on('end', () => {
                loadBalancer.recordConnectionEnd(ctx.backendPool, backend.url);
                if (wal) wal.recordFinish(requestId, { status: backendRes.statusCode });
            });
        });

        proxyReq.on('error', (err) => {
            loadBalancer.recordConnectionEnd(ctx.backendPool, backend.url);
            if (healthChecker && typeof healthChecker.reportFailure === 'function') {
                healthChecker.reportFailure(ctx.backendPool, backend.url);
            }
            if (wal) wal.recordFinish(requestId, { status: 502, error: err.message });
            respondError(ctx, 502, 'bad gateway');
        });

        ctx.req.on('error', () => {
            proxyReq.destroy();
        });

        ctx.req.pipe(proxyReq);
    }

    const phases = [rateLimitPhase, routeMatchPhase, authPhase, backendPhase];

    function handleRequest(req, res) {
        const parsedUrl = parseRequestUrl(req);

        // Phase 0: static/dashboard routes - served directly, never proxied,
        // and never counted in pipeline metrics (dashboard.js's own concern).
        // Runs before the ctx/finish-listener below is even set up, on purpose.
        if (dashboardEnabled && dashboard.matches(parsedUrl.pathname)) {
            dashboard.handleRequest(req, res);
            return;
        }

        const ctx = buildContext(req, res, parsedUrl);
        res.on('finish', () => onFinish(ctx));

        for (const phase of phases) {
            const handled = phase(ctx);
            if (handled) return;
        }
    }

    return { handleRequest };
}