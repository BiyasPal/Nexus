import http from 'node:http';
import https from 'node:https';

import { createPipeline } from './pipeline.js';
import { createHttpsServer } from '../security/tls.js';
import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { createRouter } from '../routing/router.js';
import { createLoadBalancer } from '../routing/loadbalancer.js';
import { createHealthChecker } from '../reliability/healthcheck.js';
import { createWal } from '../reliability/wal.js';
import { createRateLimiter } from '../security/ratelimiter.js';
import { createAuthenticator } from '../security/auth.js';
import { createDashboard } from '../observability/dashboard.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

let running = null;

function listen(server, port) {
    return new Promise((resolve, reject) => {
        function onError(err) {
            server.removeListener('listening', onListening);
            reject(err);
        }
        function onListening() {
            server.removeListener('error', onError);
            resolve();
        }
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
}

function closeWithTimeout(server, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;

        const forceTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            resolve();
        }, timeoutMs);
        if (forceTimer.unref) forceTimer.unref();

        server.close(() => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
        });
    });
}

export async function startServer(config, logger = console, options = {}) {
    if (running) {
        throw new Error('startServer was already called - call shutdownServer() first');
    }

    const shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const appLogger = createLogger(config.logging);

    const metrics = createMetrics();
    const router = createRouter(config);
    const healthChecker = createHealthChecker(config.backends, config.healthcheck, appLogger);
    const loadBalancer = createLoadBalancer(config.backends, healthChecker, appLogger);
    const rateLimiter = createRateLimiter(config.ratelimit, appLogger);
    const authenticator = createAuthenticator(config.auth, appLogger);
    const wal = config.wal.enabled ? createWal(config.wal, appLogger) : null;
    const dashboard = config.dashboard.enabled ? createDashboard(config.dashboard, metrics, appLogger) : null;

    const pipeline = createPipeline({
        config,
        metrics,
        router,
        loadBalancer,
        rateLimiter,
        authenticator,
        logger: appLogger,
        healthChecker,
        wal,
        dashboard
    });

    http.globalAgent.keepAlive = true;
    https.globalAgent.keepAlive = true;

    healthChecker.start();
    if (wal) wal.start();

    let httpServer = null;
    let httpsServer = null;

    try {
        if (config.listen.http != null) {
            httpServer = http.createServer(pipeline.handleRequest);
            await listen(httpServer, config.listen.http);
            logger.info(`Nexus HTTP listening on port ${config.listen.http}`);
        }

        if (config.listen.https != null) {
            httpsServer = createHttpsServer(
                pipeline.handleRequest,
                config.tls.certPath,
                config.tls.keyPath,
                { sni: config.tls.sni }
            );
            await listen(httpsServer, config.listen.https);
            logger.info(`Nexus HTTPS listening on port ${config.listen.https}`);
        }
    } catch (err) {
        healthChecker.stop();
        if (wal) await wal.stop();
        if (httpServer) await closeWithTimeout(httpServer, shutdownTimeoutMs);
        if (httpsServer) await closeWithTimeout(httpsServer, shutdownTimeoutMs);
        throw err;
    }

    running = { httpServer, httpsServer, healthChecker, wal, shutdownTimeoutMs };

    return {
        httpServer,
        httpsServer,
        pipeline,
        metrics,
        router,
        loadBalancer,
        rateLimiter,
        authenticator,
        healthChecker,
        wal,
        dashboard
    };
}

export async function shutdownServer() {
    if (!running) return;

    const { httpServer, httpsServer, healthChecker, wal, shutdownTimeoutMs } = running;
    running = null;

    healthChecker.stop();
    if (wal) await wal.flush();

    const servers = [httpServer, httpsServer].filter(Boolean);
    await Promise.all(servers.map((server) => closeWithTimeout(server, shutdownTimeoutMs)));

    if (wal) await wal.stop();
}