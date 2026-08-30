import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDashboard, diffSnapshot } from '../../observability/dashboard.js';
import { createMetrics } from '../../observability/metrics.js';

function fakeReq(url) {
    const req = new EventEmitter();
    req.url = url;
    req.headers = {};
    return req;
}

function fakeRes() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.chunks = [];
    res.ended = false;
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.getHeader = (key) => res.headers[key];
    res.flushHeaders = () => { };
    res.write = (chunk) => { res.chunks.push(chunk); return true; };
    res.end = (chunk) => {
        if (chunk !== undefined) res.chunks.push(chunk);
        res.ended = true;
        res.emit('finish');
    };
    return res;
}

function frames(res) {
    return res.chunks.join('');
}

function makeIndexFile(html) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dashboard-'));
    const indexPath = path.join(dir, 'index.html');
    fs.writeFileSync(indexPath, html);
    return indexPath;
}

function enabledConfig(overrides = {}) {
    return { enabled: true, path: '/nexus/dashboard', pushIntervalMs: 1000, ...overrides };
}

describe('createDashboard - matches()', () => {
    test('matches the page path, the events path, and the fixed REST metrics path', () => {
        const dashboard = createDashboard(enabledConfig(), createMetrics());
        assert.equal(dashboard.matches('/nexus/dashboard'), true);
        assert.equal(dashboard.matches('/nexus/dashboard/events'), true);
        assert.equal(dashboard.matches('/nexus/metrics'), true);
    });

    test('does not match unrelated paths', () => {
        const dashboard = createDashboard(enabledConfig(), createMetrics());
        assert.equal(dashboard.matches('/'), false);
        assert.equal(dashboard.matches('/api'), false);
        assert.equal(dashboard.matches('/nexus/dashboard/other'), false);
    });

    test('matches nothing when the dashboard is disabled', () => {
        const dashboard = createDashboard(enabledConfig({ enabled: false }), createMetrics());
        assert.equal(dashboard.matches('/nexus/dashboard'), false);
        assert.equal(dashboard.matches('/nexus/dashboard/events'), false);
        assert.equal(dashboard.matches('/nexus/metrics'), false);
    });

    test('respects a custom configured base path', () => {
        const dashboard = createDashboard(enabledConfig({ path: '/status' }), createMetrics());
        assert.equal(dashboard.matches('/status'), true);
        assert.equal(dashboard.matches('/status/events'), true);
        assert.equal(dashboard.matches('/nexus/dashboard'), false);
    });
});

describe('createDashboard - static page (GET {path})', () => {
    test('serves the built index.html with a 200 and an html content-type', async () => {
        const indexPath = makeIndexFile('<html><body>nexus dashboard</body></html>');
        const dashboard = createDashboard(enabledConfig({ indexPath }), createMetrics());
        const res = fakeRes();

        await new Promise((resolve) => {
            res.on('finish', resolve);
            dashboard.handleRequest(fakeReq('/nexus/dashboard'), res);
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.equal(frames(res), '<html><body>nexus dashboard</body></html>');
    });

    test('serves a 500 with a clear message when the index file is missing', async () => {
        const dashboard = createDashboard(
            enabledConfig({ indexPath: '/definitely/not/a/real/path.html' }),
            createMetrics()
        );
        const res = fakeRes();

        await new Promise((resolve) => {
            res.on('finish', resolve);
            dashboard.handleRequest(fakeReq('/nexus/dashboard'), res);
        });

        assert.equal(res.statusCode, 500);
        assert.match(frames(res), /unavailable/);
    });
});

describe('createDashboard - REST snapshot endpoint (GET /nexus/metrics)', () => {
    test('returns the current metrics snapshot as JSON', () => {
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/api', backend: 'web', status: 200, durationMs: 12 });
        const dashboard = createDashboard(enabledConfig(), metrics);
        const res = fakeRes();

        dashboard.handleRequest(fakeReq('/nexus/metrics'), res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(frames(res)), metrics.snapshot());
    });
});

describe('createDashboard - SSE endpoint (GET {path}/events)', () => {
    test('sends a full snapshot immediately on connect, with SSE headers, before any interval tick', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const dashboard = createDashboard(enabledConfig(), createMetrics());
        const res = fakeRes();

        dashboard.handleRequest(fakeReq('/nexus/dashboard/events'), res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/event-stream');
        assert.equal(res.chunks.length, 1);
        assert.match(frames(res), /^event: snapshot\ndata: /);
        assert.equal(JSON.parse(frames(res).split('data: ')[1]).type, 'full');
    });

    test('sends only a diff on the next tick when metrics changed in between', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const metrics = createMetrics();
        const dashboard = createDashboard(enabledConfig({ pushIntervalMs: 500 }), metrics);
        const res = fakeRes();

        dashboard.handleRequest(fakeReq('/nexus/dashboard/events'), res);
        metrics.recordRequest({ route: '/api', backend: 'web', status: 200, durationMs: 5 });
        t.mock.timers.tick(500);

        assert.equal(res.chunks.length, 2);
        const second = JSON.parse(frames(res).split('data: ')[2]);
        assert.equal(second.type, 'diff');
        assert.equal(second.changes.totals.requests, 1);
        assert.equal(second.changes.routes['/api'].count, 1);
    });

    test('sends nothing on a tick where metrics did not change', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const dashboard = createDashboard(enabledConfig({ pushIntervalMs: 500 }), createMetrics());
        const res = fakeRes();

        dashboard.handleRequest(fakeReq('/nexus/dashboard/events'), res);
        t.mock.timers.tick(500);
        t.mock.timers.tick(500);

        assert.equal(res.chunks.length, 1, 'only the initial full snapshot, no empty diff frames');
    });

    test('stops pushing once the client disconnects', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const metrics = createMetrics();
        const dashboard = createDashboard(enabledConfig({ pushIntervalMs: 500 }), metrics);
        const req = fakeReq('/nexus/dashboard/events');
        const res = fakeRes();

        dashboard.handleRequest(req, res);
        req.emit('close');

        metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 1 });
        t.mock.timers.tick(500);
        t.mock.timers.tick(500);

        assert.equal(res.chunks.length, 1, 'interval was cleared on disconnect');
    });
});

describe('createDashboard - never counted in its own metrics', () => {
    test('an SSE connection never calls metrics.recordRequest, even across multiple pushes', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const metrics = createMetrics();
        metrics.recordRequest({ route: '/', backend: 'web', status: 200, durationMs: 1 });
        const requestsBefore = metrics.snapshot().totals.requests;

        const dashboard = createDashboard(enabledConfig({ pushIntervalMs: 500 }), metrics);
        dashboard.handleRequest(fakeReq('/nexus/dashboard/events'), fakeRes());
        t.mock.timers.tick(500);
        t.mock.timers.tick(500);

        assert.equal(metrics.snapshot().totals.requests, requestsBefore);
    });
});

describe('diffSnapshot', () => {
    test('returns undefined for two structurally identical snapshots', () => {
        const a = { totals: { requests: 1 }, routes: {} };
        const b = { totals: { requests: 1 }, routes: {} };
        assert.equal(diffSnapshot(a, b), undefined);
    });

    test('returns only the changed leaf value, not the whole subtree', () => {
        const prev = { totals: { requests: 1, errors: 0 } };
        const next = { totals: { requests: 2, errors: 0 } };
        assert.deepEqual(diffSnapshot(prev, next), { totals: { requests: 2 } });
    });

    test('includes a brand-new nested key wholesale', () => {
        const prev = { routes: {} };
        const next = { routes: { '/api': { count: 1, errors: 0, avgLatencyMs: 5 } } };
        assert.deepEqual(diffSnapshot(prev, next), {
            routes: { '/api': { count: 1, errors: 0, avgLatencyMs: 5 } }
        });
    });

    test('marks a key that disappeared between snapshots as null', () => {
        const prev = { routes: { '/old': { count: 1 } } };
        const next = { routes: {} };
        assert.deepEqual(diffSnapshot(prev, next), { routes: { '/old': null } });
    });

    test('returns the new value outright when comparing differing primitives', () => {
        assert.equal(diffSnapshot(1, 2), 2);
        assert.equal(diffSnapshot('a', 'b'), 'b');
        assert.equal(diffSnapshot(1, 1), undefined);
    });
});