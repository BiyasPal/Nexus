import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../routing/router.js';

function configWithRoutes(routes) {
    return { routes };
}

test('matches an exact path', () => {
    const router = createRouter(configWithRoutes([{ path: '/health', backend: 'web' }]));

    const result = router.match('/health');
    assert.equal(result.backend, 'web');
    assert.equal(result.path, '/health');
});

test('matches a prefix path (/api matches /api/users)', () => {
    const router = createRouter(configWithRoutes([{ path: '/api', backend: 'api-backend' }]));

    const result = router.match('/api/users');
    assert.ok(result);
    assert.equal(result.backend, 'api-backend');
});

test('does not treat a similarly-named path as a prefix match', () => {
    const router = createRouter(configWithRoutes([{ path: '/api', backend: 'api-backend' }]));

    assert.equal(router.match('/apiv2'), null);
    assert.equal(router.match('/apikey'), null);
});

test('longest-prefix-wins when routes overlap', () => {
    const router = createRouter(
        configWithRoutes([
            { path: '/', backend: 'web' },
            { path: '/api', backend: 'api-backend' },
            { path: '/api/admin', backend: 'admin-backend' }
        ])
    );

    assert.equal(router.match('/').backend, 'web');
    assert.equal(router.match('/anything').backend, 'web');
    assert.equal(router.match('/api/users').backend, 'api-backend');
    assert.equal(router.match('/api/admin/panel').backend, 'admin-backend');
});

test('returns null cleanly for an unmatched path', () => {
    const router = createRouter(configWithRoutes([{ path: '/api', backend: 'api-backend' }]));

    assert.equal(router.match('/nope'), null);
});

test('root route ("/") matches every path as the lowest-priority fallback', () => {
    const router = createRouter(
        configWithRoutes([
            { path: '/', backend: 'web' },
            { path: '/api', backend: 'api-backend' }
        ])
    );

    assert.equal(router.match('/whatever/deep/path').backend, 'web');
});

test('host-based routing: a host-specific route only matches its own host', () => {
    const router = createRouter(
        configWithRoutes([
            { path: '/', backend: 'default-site', host: 'default.example.com' },
            { path: '/', backend: 'admin-site', host: 'admin.example.com' }
        ])
    );

    assert.equal(router.match('/', 'admin.example.com').backend, 'admin-site');
    assert.equal(router.match('/', 'default.example.com').backend, 'default-site');
    assert.equal(router.match('/', 'unknown.example.com'), null);
});

test('host header port is ignored when matching', () => {
    const router = createRouter(
        configWithRoutes([{ path: '/', backend: 'web', host: 'example.com' }])
    );

    assert.equal(router.match('/', 'example.com:8080').backend, 'web');
});

test('host-specific route outranks a host-agnostic route for the same path', () => {
    const router = createRouter(
        configWithRoutes([
            { path: '/', backend: 'catch-all' },
            { path: '/', backend: 'admin-site', host: 'admin.example.com' }
        ])
    );

    assert.equal(router.match('/', 'admin.example.com').backend, 'admin-site');
    assert.equal(router.match('/', 'other.example.com').backend, 'catch-all');
});

test('(stretch) regex route matching', () => {
    const router = createRouter(
        configWithRoutes([{ path: '/files', regex: '^/files/.*\\.png$', backend: 'image-cdn' }])
    );

    assert.equal(router.match('/files/logo.png').backend, 'image-cdn');
    assert.equal(router.match('/files/logo.jpg'), null);
});

test('(stretch) route-level auth/rateLimit metadata passes through on the match result', () => {
    const router = createRouter(
        configWithRoutes([
            {
                path: '/admin',
                backend: 'admin-backend',
                auth: { required: true },
                rateLimit: { maxRequests: 10 }
            }
        ])
    );

    const result = router.match('/admin/users');
    assert.deepEqual(result.auth, { required: true });
    assert.deepEqual(result.rateLimit, { maxRequests: 10 });
});

test('match result carries null metadata when a route defines none', () => {
    const router = createRouter(configWithRoutes([{ path: '/', backend: 'web' }]));

    const result = router.match('/');
    assert.equal(result.auth, null);
    assert.equal(result.rateLimit, null);
    assert.equal(result.host, null);
});