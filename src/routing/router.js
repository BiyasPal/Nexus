function stripPort(host) {
    return host ? host.split(':')[0].toLowerCase() : host;
}

function hostMatches(route, host) {
    if (!route.host) return true;
    return stripPort(host) === route.host.toLowerCase();
}

function pathMatches(route, pathname) {
    if (route.regex) {
        try {
            return new RegExp(route.regex).test(pathname);
        } catch {
            return false;
        }
    }

    if (route.path === '/') return true;
    if (pathname === route.path) return true;

    return pathname.startsWith(route.path.endsWith('/') ? route.path : `${route.path}/`);
}

function specificity(route) {
    // Host-specific routes always outrank host-agnostic ones. Within the same
    // host tier, the longest path prefix wins - this is the one nginx `location`
    // matching rule everyone half-remembers wrong.
    const hostBonus = route.host ? 1_000_000 : 0;
    const pathLength = route.path ? route.path.length : 0;

    return hostBonus + pathLength;
}

/**
 * Build a router from validated config. Depends only on config.js's shape -
 * config.routes is assumed to already reference real backends.
 */
export function createRouter(config) {
    const routes = config.routes;

    /**
     * Match an incoming path (+ optional host) to a route.
     * Returns null cleanly for unmatched paths - the pipeline turns that into
     * a 404, this module never does.
     */
    function match(pathname, host) {
        const candidates = routes.filter(
            (route) => hostMatches(route, host) && pathMatches(route, pathname)
        );

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => specificity(b) - specificity(a));
        const winner = candidates[0];

        return {
            path: winner.path,
            backend: winner.backend,
            host: winner.host || null,
            auth: winner.auth || null,
            rateLimit: winner.rateLimit || null
        };
    }

    return { match };
}