import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createPipeline } from '../../core/pipeline.js';

function fakeLogger() {
    const requests = [];
    return {
        requests,
        info: () => { },
        warn: () => { },
        error: () => { },
        debug: () => { },
        logRequest: (entry) => requests.push(entry)
    };
}

function fakeMetrics() {
    const calls = [];
    return {
        calls,
        recordRequest: (entry) => calls.push(entry)
    };
}

function fakeRouter(matchImpl) {
    return { match: matchImpl };
}

function fakeLoadBalancer(pickImpl) {
    const connectionEvents = [];
    return {
        connectionEvents,
        pick: pickImpl,
        recordConnectionStart: (pool, url) => connectionEvents.push(['start', pool, url]),
        recordConnectionEnd: (pool, url) => connectionEvents.push(['end', pool, url])
    };
}

function fakeRateLimiter(checkLimitImpl) {
    return {
        checkLimit: checkLimitImpl || (() => ({ allowed: true, remaining: 10, retryAfterSeconds: null }))
    };
}

function fakeAuthenticator(authenticateImpl) {
    return {
        authenticate: authenticateImpl || (() => ({ authenticated: true, reason: 'not_required' }))
    };
}

function fakeWal() {
    const events = [];
    return {
        events,
        recordStart: (id, meta) => events.push(['start', id, meta]),
        recordFinish: (id, meta) => events.push(['finish', id, meta])
    };
}

function fakeHealthChecker() {
    const failures = [];
    return {
        failures,
        reportFailure: (pool, url) => failures.push([pool, url])
    };
}

function fakeDashboard(matchPath) {
    const handled = [];
    return {
        handled,
        matches: (pathname) => pathname === matchPath,
        handleRequest: (req, res) => {
            handled.push(req.url);
            res.statusCode = 200;
            res.end('dashboard-ui');
        }
    };
}

function baseDeps(overrides = {}) {
    return {
        config: { dashboard: { enabled: false } },
        metrics: fakeMetrics(),
        router: fakeRouter(() => null),
        loadBalancer: fakeLoadBalancer(() => null),
        rateLimiter: fakeRateLimiter(),
        authenticator: fakeAuthenticator(),
        logger: fakeLogger(),
        ...overrides
    };
}

function startServer(pipeline) {
    return new Promise((resolve) => {
        const server = http.createServer(pipeline.handleRequest);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function startBackend(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function stopServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

function backendUrl(server) {
    return `http://127.0.0.1:${server.address().port}`;
}

function send(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const port = server.address().port;
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw }));
        });
        req.on('error', reject);
        if (body) {
            req.end(body);
        } else {
            req.end();
        }
    });
}

describe('createPipeline - constructor validation', () => {
    test('throws a clear error when a required dependency is missing', () => {
        const deps = baseDeps();
        delete deps.router;
        assert.throws(() => createPipeline(deps), /requires a "router" dependency/);
    });

    test('does not throw when optional dependencies (logger/wal/healthChecker/dashboard) are omitted', () => {
        const deps = baseDeps();
        delete deps.logger;
        assert.doesNotThrow(() => createPipeline(deps));
    });
});

describe('createPipeline - phase 0: static/dashboard bypass', () => {
    test('delegates fully to dashboard.handleRequest and is never counted in pipeline metrics', async () => {
        const dashboard = fakeDashboard('/nexus/dashboard');
        const metrics = fakeMetrics();
        const router = fakeRouter(() => {
            throw new Error('router.match should not run for a dashboard request');
        });
        const rateLimiter = fakeRateLimiter(() => {
            throw new Error('rateLimiter.checkLimit should not run for a dashboard request');
        });

        const pipeline = createPipeline(baseDeps({
            config: { dashboard: { enabled: true, path: '/nexus/dashboard' } },
            dashboard,
            metrics,
            router,
            rateLimiter
        }));

        const server = await startServer(pipeline);
        const res = await send(server, { path: '/nexus/dashboard' });
        await stopServer(server);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'dashboard-ui');
        assert.deepEqual(dashboard.handled, ['/nexus/dashboard']);
        assert.equal(metrics.calls.length, 0, 'dashboard requests must never pollute pipeline metrics');
    });

    test('falls through to the normal flow when the path does not belong to the dashboard', async () => {
        const dashboard = fakeDashboard('/nexus/dashboard');
        const pipeline = createPipeline(baseDeps({
            config: { dashboard: { enabled: true, path: '/nexus/dashboard' } },
            dashboard,
            router: fakeRouter(() => null)
        }));

        const server = await startServer(pipeline);
        const res = await send(server, { path: '/somewhere-else' });
        await stopServer(server);

        assert.equal(res.statusCode, 404);
        assert.deepEqual(dashboard.handled, []);
    });

    test('falls through to the normal flow when the dashboard is disabled in config', async () => {
        const dashboard = fakeDashboard('/nexus/dashboard');
        const pipeline = createPipeline(baseDeps({
            config: { dashboard: { enabled: false, path: '/nexus/dashboard' } },
            dashboard,
            router: fakeRouter(() => null)
        }));

        const server = await startServer(pipeline);
        const res = await send(server, { path: '/nexus/dashboard' });
        await stopServer(server);

        assert.equal(res.statusCode, 404);
        assert.deepEqual(dashboard.handled, []);
    });
});

describe('createPipeline - phase 1: rate limiting', () => {
    test('responds 429 with a Retry-After header when the client is over the limit', async () => {
        const metrics = fakeMetrics();
        const rateLimiter = fakeRateLimiter(() => ({ allowed: false, remaining: 0, retryAfterSeconds: 7 }));

        const pipeline = createPipeline(baseDeps({ rateLimiter, metrics }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/anything' });
        await stopServer(server);

        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['retry-after'], '7');
        assert.equal(metrics.calls.length, 1);
        assert.equal(metrics.calls[0].route, null);
        assert.equal(metrics.calls[0].backend, null);
        assert.equal(metrics.calls[0].status, 429);
    });

    test('rate limiting runs before route matching - a denied request never reaches the router', async () => {
        const rateLimiter = fakeRateLimiter(() => ({ allowed: false, remaining: 0, retryAfterSeconds: 1 }));
        const router = fakeRouter(() => {
            throw new Error('router.match should not run when the request was already rate limited');
        });

        const pipeline = createPipeline(baseDeps({ rateLimiter, router }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/anything' });
        await stopServer(server);

        assert.equal(res.statusCode, 429);
    });
});

describe('createPipeline - phase 2: route matching', () => {
    test('responds 404 for an unmatched path', async () => {
        const metrics = fakeMetrics();
        const pipeline = createPipeline(baseDeps({ router: fakeRouter(() => null), metrics }));

        const server = await startServer(pipeline);
        const res = await send(server, { path: '/nope' });
        await stopServer(server);

        assert.equal(res.statusCode, 404);
        assert.equal(metrics.calls[0].route, null);
        assert.equal(metrics.calls[0].backend, null);
    });

    test('an unmatched path is 404, never a 401, even when auth would have failed', async () => {
        const authenticator = fakeAuthenticator(() => {
            throw new Error('authenticate should not run for a route that was never matched');
        });

        const pipeline = createPipeline(baseDeps({ router: fakeRouter(() => null), authenticator }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/private' });
        await stopServer(server);

        assert.equal(res.statusCode, 404);
    });
});

describe('createPipeline - phase 3: auth check', () => {
    function matchedRoute(overrides = {}) {
        return { path: '/admin', backend: 'web', auth: { required: true }, rateLimit: null, host: null, ...overrides };
    }

    test('responds 401 when the authenticator rejects the request', async () => {
        const metrics = fakeMetrics();
        const router = fakeRouter(() => matchedRoute());
        const authenticator = fakeAuthenticator(() => ({ authenticated: false, reason: 'missing' }));

        const pipeline = createPipeline(baseDeps({ router, authenticator, metrics }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/admin' });
        await stopServer(server);

        assert.equal(res.statusCode, 401);
        assert.equal(metrics.calls[0].route, '/admin');
        assert.equal(metrics.calls[0].backend, 'web');
    });

    test('backend selection never runs after a failed auth check', async () => {
        const router = fakeRouter(() => matchedRoute());
        const authenticator = fakeAuthenticator(() => ({ authenticated: false, reason: 'missing' }));
        const loadBalancer = fakeLoadBalancer(() => {
            throw new Error('loadBalancer.pick should not run after auth fails');
        });

        const pipeline = createPipeline(baseDeps({ router, authenticator, loadBalancer }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/admin' });
        await stopServer(server);

        assert.equal(res.statusCode, 401);
    });

    test("passes the matched route's auth override and path label to the authenticator", async () => {
        let received;
        const router = fakeRouter(() => matchedRoute());
        const authenticator = fakeAuthenticator((headers, routeAuth, routeLabel) => {
            received = { routeAuth, routeLabel };
            return { authenticated: true, reason: 'api_key' };
        });
        const loadBalancer = fakeLoadBalancer(() => null); // stop right after auth, response becomes 502

        const pipeline = createPipeline(baseDeps({ router, authenticator, loadBalancer }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/admin' });
        await stopServer(server);

        assert.equal(res.statusCode, 502);
        assert.deepEqual(received, { routeAuth: { required: true }, routeLabel: '/admin' });
    });
});

describe('createPipeline - phase 4: backend selection', () => {
    test('responds 502 when the load balancer has no healthy backend, and never touches WAL', async () => {
        const metrics = fakeMetrics();
        const wal = fakeWal();
        const router = fakeRouter(() => ({ path: '/', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => null);

        const pipeline = createPipeline(baseDeps({ router, loadBalancer, metrics, wal }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/' });
        await stopServer(server);

        assert.equal(res.statusCode, 502);
        assert.equal(metrics.calls[0].route, '/');
        assert.equal(metrics.calls[0].backend, 'web');
        assert.equal(wal.events.length, 0, 'WAL must only wrap an actual forward call, never this branch');
    });
});

describe('createPipeline - phase 5: forwarding to a backend', () => {
    test('proxies a GET request through and returns the backend response verbatim', async () => {
        const backend = await startBackend((req, res) => {
            res.setHeader('X-From-Backend', 'yes');
            res.statusCode = 200;
            res.end(`echo ${req.method} ${req.url}`);
        });

        const router = fakeRouter(() => ({ path: '/api', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => ({ url: backendUrl(backend) }));
        const metrics = fakeMetrics();
        const logger = fakeLogger();
        const wal = fakeWal();

        const pipeline = createPipeline(baseDeps({ router, loadBalancer, metrics, logger, wal }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/api/users?x=1' });
        await stopServer(server);
        await stopServer(backend);

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['x-from-backend'], 'yes');
        assert.equal(res.body, 'echo GET /api/users?x=1');

        assert.equal(metrics.calls.length, 1);
        assert.equal(metrics.calls[0].route, '/api');
        assert.equal(metrics.calls[0].backend, 'web');
        assert.equal(metrics.calls[0].status, 200);
        assert.equal(typeof metrics.calls[0].durationMs, 'number');

        assert.equal(logger.requests.length, 1);
        assert.equal(logger.requests[0].status, 200);

        assert.deepEqual(wal.events.map((e) => e[0]), ['start', 'finish']);
        assert.equal(wal.events[0][1], wal.events[1][1], 'start/finish must share the same requestId');
    });

    test('forwards a POST body through to the backend unchanged', async () => {
        const backend = await startBackend((req, res) => {
            let received = '';
            req.on('data', (chunk) => { received += chunk; });
            req.on('end', () => {
                res.statusCode = 201;
                res.end(received);
            });
        });

        const router = fakeRouter(() => ({ path: '/api', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => ({ url: backendUrl(backend) }));

        const pipeline = createPipeline(baseDeps({ router, loadBalancer }));
        const server = await startServer(pipeline);
        const res = await send(server, {
            method: 'POST',
            path: '/api/items',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hello: 'world' })
        });
        await stopServer(server);
        await stopServer(backend);

        assert.equal(res.statusCode, 201);
        assert.equal(res.body, JSON.stringify({ hello: 'world' }));
    });

    test('adds an X-Forwarded-For header carrying the client IP', async () => {
        let receivedXff;
        const backend = await startBackend((req, res) => {
            receivedXff = req.headers['x-forwarded-for'];
            res.statusCode = 200;
            res.end('ok');
        });

        const router = fakeRouter(() => ({ path: '/', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => ({ url: backendUrl(backend) }));

        const pipeline = createPipeline(baseDeps({ router, loadBalancer }));
        const server = await startServer(pipeline);
        await send(server, { path: '/' });
        await stopServer(server);
        await stopServer(backend);

        assert.equal(receivedXff, '127.0.0.1');
    });

    test('tracks connection start/end on the load balancer around the forward call', async () => {
        const backend = await startBackend((req, res) => res.end('ok'));
        const router = fakeRouter(() => ({ path: '/', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => ({ url: backendUrl(backend) }));

        const pipeline = createPipeline(baseDeps({ router, loadBalancer }));
        const server = await startServer(pipeline);
        await send(server, { path: '/' });
        await stopServer(server);
        await stopServer(backend);

        assert.deepEqual(loadBalancer.connectionEvents.map((e) => e[0]), ['start', 'end']);
    });
});

describe('createPipeline - forward call fails (backend unreachable)', () => {
    test('responds 502, flushes WAL with the error, and reports the backend unhealthy', async () => {
        const deadServer = await startBackend((req, res) => res.end());
        const deadUrl = backendUrl(deadServer);
        await stopServer(deadServer); // nothing listens on this port now -> ECONNREFUSED

        const router = fakeRouter(() => ({ path: '/', backend: 'web', auth: null, rateLimit: null, host: null }));
        const loadBalancer = fakeLoadBalancer(() => ({ url: deadUrl }));
        const wal = fakeWal();
        const healthChecker = fakeHealthChecker();
        const metrics = fakeMetrics();

        const pipeline = createPipeline(baseDeps({ router, loadBalancer, wal, healthChecker, metrics }));
        const server = await startServer(pipeline);
        const res = await send(server, { path: '/' });
        await stopServer(server);

        assert.equal(res.statusCode, 502);
        assert.equal(wal.events[0][0], 'start');
        assert.equal(wal.events[1][0], 'finish');
        assert.equal(wal.events[1][2].status, 502);
        assert.deepEqual(healthChecker.failures, [['web', deadUrl]]);
        assert.equal(loadBalancer.connectionEvents.filter((e) => e[0] === 'end').length, 1);
        assert.equal(metrics.calls[0].status, 502);
    });
});

describe('createPipeline - metrics.recordRequest fires on every terminal branch', () => {
    test('429, 404, 401, 502 (no backend), and 200 (success) are each recorded exactly once', async () => {
        const backend = await startBackend((req, res) => res.end('ok'));
        const metrics = fakeMetrics();

        let allow = true;
        const rateLimiter = fakeRateLimiter(() => ({
            allowed: allow,
            remaining: allow ? 1 : 0,
            retryAfterSeconds: allow ? null : 1
        }));

        let matched = null;
        const router = fakeRouter(() => matched);

        let authOk = true;
        const authenticator = fakeAuthenticator(() => ({
            authenticated: authOk,
            reason: authOk ? 'not_required' : 'missing'
        }));

        let pickResult = null;
        const loadBalancer = fakeLoadBalancer(() => pickResult);

        const pipeline = createPipeline(baseDeps({ metrics, rateLimiter, router, authenticator, loadBalancer }));
        const server = await startServer(pipeline);

        allow = false;
        assert.equal((await send(server, { path: '/x' })).statusCode, 429);

        allow = true;
        matched = null;
        assert.equal((await send(server, { path: '/x' })).statusCode, 404);

        matched = { path: '/x', backend: 'web', auth: { required: true }, rateLimit: null, host: null };
        authOk = false;
        assert.equal((await send(server, { path: '/x' })).statusCode, 401);

        authOk = true;
        pickResult = null;
        assert.equal((await send(server, { path: '/x' })).statusCode, 502);

        pickResult = { url: backendUrl(backend) };
        assert.equal((await send(server, { path: '/x' })).statusCode, 200);

        await stopServer(server);
        await stopServer(backend);

        assert.deepEqual(metrics.calls.map((c) => c.status), [429, 404, 401, 502, 200]);
    });
});