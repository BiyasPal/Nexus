import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, validateConfig, DEFAULT_CONFIG_PATH } from '../config.js';

function validRaw(overrides = {}) {
    return {
        listen: { http: 8080, https: 8443 },
        backends: {
            web: [{ url: 'http://localhost:9001', weight: 1 }]
        },
        routes: [{ path: '/', backend: 'web' }],
        ...overrides
    };
}

function writeTempConfig(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-config-test-'));
    const file = path.join(dir, 'nexus.config.json');
    fs.writeFileSync(file, contents);
    return file;
}

describe('config constants', () => {
    test('DEFAULT_CONFIG_PATH points at ./nexus.config.json', () => {
        assert.equal(DEFAULT_CONFIG_PATH, './nexus.config.json');
    });
});

describe('validateConfig - accepting valid input', () => {
    test('accepts a minimal valid config', () => {
        const config = validateConfig(validRaw());
        assert.equal(config.listen.http, 8080);
        assert.deepEqual(config.routes, [{ path: '/', backend: 'web' }]);
    });

    test('fills in defaults for every optional section', () => {
        const config = validateConfig(validRaw());

        assert.deepEqual(config.healthcheck, {
            path: '/health',
            intervalMs: 5000,
            unhealthyThreshold: 3,
            healthyThreshold: 2
        });
        assert.deepEqual(config.ratelimit, { windowMs: 60000, maxRequests: 100, burst: 0 });
        assert.equal(config.auth.headerName, 'X-API-Key');
        assert.equal(config.tls.certPath, './certs/cert.pem');
        assert.equal(config.logging.level, 'info');
        assert.equal(config.wal.retainFiles, 5);
        assert.equal(config.dashboard.pushIntervalMs, 2000);
    });

    test('merges partial optional sections instead of replacing them', () => {
        const config = validateConfig(
            validRaw({ healthcheck: { intervalMs: 9999 } })
        );

        assert.equal(config.healthcheck.intervalMs, 9999);
        assert.equal(config.healthcheck.path, '/health');
        assert.equal(config.healthcheck.unhealthyThreshold, 3);
    });
});

describe('validateConfig - rejecting invalid input', () => {
    test('rejects a config missing a required top-level key', () => {
        const raw = validRaw();
        delete raw.backends;

        assert.throws(() => validateConfig(raw), /missing required key "backends"/);
    });

    test('rejects listen with neither http nor https', () => {
        assert.throws(
            () => validateConfig(validRaw({ listen: {} })),
            /must define an "http" and\/or "https" port/
        );
    });

    test('rejects an empty backend pool', () => {
        assert.throws(
            () => validateConfig(validRaw({ backends: { web: [] } })),
            /must be a non-empty array/
        );
    });

    test('rejects a backend entry missing a url', () => {
        assert.throws(
            () => validateConfig(validRaw({ backends: { web: [{ weight: 1 }] } })),
            /missing "url"/
        );
    });

    test('rejects a route pointing at an unknown backend', () => {
        assert.throws(
            () => validateConfig(validRaw({ routes: [{ path: '/', backend: 'ghost' }] })),
            /references unknown backend "ghost"/
        );
    });

    test('rejects a non-object root', () => {
        assert.throws(() => validateConfig(null), /root must be a JSON object/);
        assert.throws(() => validateConfig('nope'), /root must be a JSON object/);
    });
});

describe('loadConfig', () => {
    test('reads, parses, and validates a real file from disk', () => {
        const file = writeTempConfig(JSON.stringify(validRaw()));
        const config = loadConfig(file);
        assert.equal(config.listen.http, 8080);
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    test('fails fast with a clear message on a missing file', () => {
        assert.throws(
            () => loadConfig('./does-not-exist.json'),
            /Config file not found: \.\/does-not-exist\.json/
        );
    });

    test('fails fast with a clear message on invalid JSON', () => {
        const file = writeTempConfig('{ not valid json');
        assert.throws(() => loadConfig(file), /Invalid JSON in config file/);
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });
});