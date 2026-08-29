import fs from 'node:fs';

export const DEFAULT_CONFIG_PATH = './nexus.config.json';

const REQUIRED_KEYS = ['listen', 'backends', 'routes'];

const DEFAULTS = {
    healthcheck: {
        path: '/health',
        intervalMs: 5000,
        unhealthyThreshold: 3,
        healthyThreshold: 2
    },
    ratelimit: {
        windowMs: 60000,
        maxRequests: 100,
        burst: 0
    },
    auth: {
        headerName: 'X-API-Key',
        keys: [],
        requiredByDefault: false
    },
    tls: {
        certPath: './certs/cert.pem',
        keyPath: './certs/key.pem'
    },
    logging: {
        level: 'info',
        format: 'combined'
    },
    wal: {
        enabled: false,
        path: './data/wal',
        flushIntervalMs: 1000,
        maxFileSizeBytes: 10485760,
        retainFiles: 5
    },
    dashboard: {
        enabled: false,
        path: '/nexus/dashboard',
        pushIntervalMs: 2000
    }
};

function mergeSection(userSection, defaultSection) {
    return { ...defaultSection, ...(userSection || {}) };
}

function assertRequiredKeys(raw) {
    for (const key of REQUIRED_KEYS) {
        if (raw[key] === undefined || raw[key] === null) {
            throw new Error(`Invalid nexus config: missing required key "${key}"`);
        }
    }
}

function assertListen(listen) {
    if (typeof listen !== 'object' || (!listen.http && !listen.https)) {
        throw new Error(
            'Invalid nexus config: "listen" must define an "http" and/or "https" port'
        );
    }
}

function assertBackends(backends) {
    if (typeof backends !== 'object' || Array.isArray(backends)) {
        throw new Error('Invalid nexus config: "backends" must be an object keyed by backend name');
    }

    for (const [name, pool] of Object.entries(backends)) {
        if (!Array.isArray(pool) || pool.length === 0) {
            throw new Error(`Invalid nexus config: backend "${name}" must be a non-empty array`);
        }

        for (const entry of pool) {
            if (!entry || typeof entry.url !== 'string') {
                throw new Error(`Invalid nexus config: backend "${name}" has an entry missing "url"`);
            }
        }
    }
}

function assertRoutes(routes, backends) {
    if (!Array.isArray(routes) || routes.length === 0) {
        throw new Error('Invalid nexus config: "routes" must be a non-empty array');
    }

    for (const route of routes) {
        if (!route || typeof route.path !== 'string') {
            throw new Error('Invalid nexus config: every route needs a "path"');
        }

        if (typeof route.backend !== 'string' || !(route.backend in backends)) {
            throw new Error(
                `Invalid nexus config: route "${route.path}" references unknown backend "${route.backend}"`
            );
        }
    }
}

/**
 * Validate a raw parsed config object and return a fully-defaulted config.
 * No downstream module should ever need to check `if (config.foo)` for an
 * optional section - every optional section is guaranteed to exist here.
 */
export function validateConfig(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid nexus config: root must be a JSON object');
    }

    assertRequiredKeys(raw);
    assertListen(raw.listen);
    assertBackends(raw.backends);
    assertRoutes(raw.routes, raw.backends);

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
}

/**
 * Load, parse, and validate the nexus config file from disk.
 * Fails fast with a clear, non-stack-trace-shaped message on a missing
 * file, invalid JSON, or a missing required key.
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    let contents;

    try {
        contents = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Config file not found: ${configPath}`);
        }
        throw new Error(`Unable to read config file ${configPath}: ${err.message}`);
    }

    let raw;

    try {
        raw = JSON.parse(contents);
    } catch (err) {
        throw new Error(`Invalid JSON in config file ${configPath}: ${err.message}`);
    }

    return validateConfig(raw);
}