import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_PATH = '/nexus/dashboard';
const DEFAULT_PUSH_INTERVAL_MS = 2000;
const DEFAULT_INDEX_PATH = path.resolve(__dirname, '../public/index.html');

const EVENTS_SUFFIX = '/events';
const REST_METRICS_PATH = '/nexus/metrics';

export function diffSnapshot(prev, next) {
    if (prev === next) return undefined;

    const prevIsObject = typeof prev === 'object' && prev !== null;
    const nextIsObject = typeof next === 'object' && next !== null;

    if (!prevIsObject || !nextIsObject) {
        return next === prev ? undefined : next;
    }

    const changes = {};
    let hasChanges = false;

    for (const key of Object.keys(next)) {
        const sub = diffSnapshot(prev[key], next[key]);
        if (sub !== undefined) {
            changes[key] = sub;
            hasChanges = true;
        }
    }

    for (const key of Object.keys(prev)) {
        if (!(key in next)) {
            changes[key] = null;
            hasChanges = true;
        }
    }

    return hasChanges ? changes : undefined;
}

function sseFrame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function pathnameOf(req) {
    return new URL(req.url, 'http://placeholder').pathname;
}

export function createDashboard(dashboardConfig = {}, metrics, logger = console) {
    const basePath = dashboardConfig.path || DEFAULT_BASE_PATH;
    const eventsPath = `${basePath}${EVENTS_SUFFIX}`;
    const pushIntervalMs = dashboardConfig.pushIntervalMs || DEFAULT_PUSH_INTERVAL_MS;
   
    const indexPath = dashboardConfig.indexPath || DEFAULT_INDEX_PATH;

    function isEnabled() {
        return Boolean(dashboardConfig.enabled);
    }

    
    function matches(pathname) {
        if (!isEnabled()) return false;
        return pathname === basePath || pathname === eventsPath || pathname === REST_METRICS_PATH;
    }

    function serveStaticPage(res) {
        fs.readFile(indexPath, 'utf8', (err, html) => {
            if (err) {
                logger.error(`dashboard: failed to read ${indexPath}: ${err.message}`);
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/plain');
                res.end('dashboard UI unavailable');
                return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
        });
    }

    function serveMetricsSnapshot(res) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(metrics.snapshot()));
    }

   
    function serveEvents(req, res) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        let lastSent = null;

        function push() {
            const snapshot = metrics.snapshot();

            if (lastSent === null) {
                res.write(sseFrame('snapshot', { type: 'full', snapshot }));
            } else {
                const changes = diffSnapshot(lastSent, snapshot);
                if (changes === undefined) return; // nothing changed - skip the tick entirely
                res.write(sseFrame('snapshot', { type: 'diff', changes }));
            }

            lastSent = snapshot;
        }

        push(); // don't make a fresh connection wait a full interval for its first frame

        const timer = setInterval(push, pushIntervalMs);
        if (timer.unref) timer.unref();

        function cleanup() {
            clearInterval(timer);
        }

        req.on('close', cleanup);
        res.on('close', cleanup);
    }

    function handleRequest(req, res) {
        const pathname = pathnameOf(req);

        if (pathname === eventsPath) {
            serveEvents(req, res);
            return;
        }
        if (pathname === REST_METRICS_PATH) {
            serveMetricsSnapshot(res);
            return;
        }
        if (pathname === basePath) {
            serveStaticPage(res);
            return;
        }

        
        res.statusCode = 404;
        res.end();
    }

    return { matches, handleRequest };
}