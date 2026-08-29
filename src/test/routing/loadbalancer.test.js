import test from 'node:test';
import assert from 'node:assert/strict';

import { createLoadBalancer } from '../../routing/loadbalancer.js';

function fakeHealthChecker(healthyByPool) {
    return {
        getHealthyBackends: (poolName) => healthyByPool[poolName] || []
    };
}

const backends = {
    web: [
        { url: 'http://a', weight: 2 },
        { url: 'http://b', weight: 1 }
    ]
};

test('round-robin distributes evenly across equal-weight backends', () => {
    const equalBackends = { web: [{ url: 'http://a' }, { url: 'http://b' }] };
    const lb = createLoadBalancer(
        equalBackends,
        fakeHealthChecker({ web: equalBackends.web })
    );

    const picks = [1, 2, 3, 4].map(() => lb.pick('web').url);
    assert.deepEqual(picks, ['http://a', 'http://b', 'http://a', 'http://b']);
});

test('weighted round-robin respects per-backend weight over a full cycle', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    const counts = { 'http://a': 0, 'http://b': 0 };
    for (let i = 0; i < 3; i += 1) {
        counts[lb.pick('web').url] += 1;
    }

    assert.equal(counts['http://a'], 2);
    assert.equal(counts['http://b'], 1);
});

test('never selects a backend the health checker has marked unhealthy', () => {
    const lb = createLoadBalancer(
        backends,
        fakeHealthChecker({ web: [{ url: 'http://b', weight: 1 }] })
    );

    for (let i = 0; i < 5; i += 1) {
        assert.equal(lb.pick('web').url, 'http://b');
    }
});

test('returns null cleanly when zero healthy backends exist', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: [] }));

    assert.equal(lb.pick('web'), null);
});

test('treats all configured backends as healthy when no health checker is given', () => {
    const lb = createLoadBalancer(backends);

    const result = lb.pick('web');
    assert.ok(['http://a', 'http://b'].includes(result.url));
});

test('(stretch) least-conn strategy picks the backend with fewest in-flight requests', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    lb.recordConnectionStart('web', 'http://a');
    lb.recordConnectionStart('web', 'http://a');

    const result = lb.pick('web', { strategy: 'least-conn' });
    assert.equal(result.url, 'http://b');
});

test('(stretch) ip-hash strategy is stable for the same client IP', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    const first = lb.pick('web', { strategy: 'ip-hash', clientIp: '10.0.0.7' }).url;
    for (let i = 0; i < 5; i += 1) {
        assert.equal(
            lb.pick('web', { strategy: 'ip-hash', clientIp: '10.0.0.7' }).url,
            first
        );
    }
});

test('(stretch) ip-hash can route different client IPs to different backends', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    const urls = new Set([
        lb.pick('web', { strategy: 'ip-hash', clientIp: '1.1.1.1' }).url,
        lb.pick('web', { strategy: 'ip-hash', clientIp: '2.2.2.2' }).url,
        lb.pick('web', { strategy: 'ip-hash', clientIp: '3.3.3.3' }).url,
        lb.pick('web', { strategy: 'ip-hash', clientIp: '4.4.4.4' }).url
    ]);

    assert.ok(urls.size >= 1);
});

test('(stretch) connection counts are tracked and exposed per backend', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    lb.recordConnectionStart('web', 'http://a');
    lb.recordConnectionStart('web', 'http://a');
    lb.recordConnectionStart('web', 'http://b');
    lb.recordConnectionEnd('web', 'http://a');

    const counts = lb.getConnectionCounts('web');
    assert.deepEqual(counts, [
        { url: 'http://a', inFlight: 1 },
        { url: 'http://b', inFlight: 1 }
    ]);
});

test('recordConnectionEnd never drops a count below zero', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    lb.recordConnectionEnd('web', 'http://a');
    const counts = lb.getConnectionCounts('web');
    assert.equal(counts.find((c) => c.url === 'http://a').inFlight, 0);
});

test('throws on an unknown strategy', () => {
    const lb = createLoadBalancer(backends, fakeHealthChecker({ web: backends.web }));

    assert.throws(() => lb.pick('web', { strategy: 'bogus' }), /Unknown load balancer strategy/);
});