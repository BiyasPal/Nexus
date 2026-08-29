function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

export function createLoadBalancer(backends, healthChecker, logger) {
    const log = logger || console;


    const weightedState = new Map();

    const inFlight = new Map();

    function poolBackends(poolName) {
        return backends[poolName] || [];
    }

    function healthyCandidates(poolName) {
        if (healthChecker) {
            return healthChecker.getHealthyBackends(poolName);
        }
        return poolBackends(poolName);
    }

    function inFlightMapFor(poolName) {
        let map = inFlight.get(poolName);
        if (!map) {
            map = new Map();
            inFlight.set(poolName, map);
        }
        return map;
    }

    function connectionCount(poolName, url) {
        return inFlightMapFor(poolName).get(url) || 0;
    }

    function pickRoundRobin(poolName, candidates) {
        let currentWeights = weightedState.get(poolName);
        if (!currentWeights) {
            currentWeights = new Map();
            weightedState.set(poolName, currentWeights);
        }

        const totalWeight = candidates.reduce((sum, b) => sum + (b.weight || 1), 0);
        let winner = null;
        let winnerWeight = -Infinity;

        for (const backend of candidates) {
            const weight = backend.weight || 1;
            const current = (currentWeights.get(backend.url) || 0) + weight;
            currentWeights.set(backend.url, current);

            if (current > winnerWeight) {
                winnerWeight = current;
                winner = backend;
            }
        }

        currentWeights.set(winner.url, winnerWeight - totalWeight);

        return winner;
    }

    function pickLeastConnections(poolName, candidates) {
        let winner = candidates[0];
        let winnerCount = connectionCount(poolName, winner.url);

        for (const backend of candidates.slice(1)) {
            const count = connectionCount(poolName, backend.url);
            if (count < winnerCount) {
                winner = backend;
                winnerCount = count;
            }
        }

        return winner;
    }

    function pickIpHash(candidates, clientIp) {
        if (!clientIp) return candidates[0];
        const index = hashString(clientIp) % candidates.length;
        return candidates[index];
    }

    function pick(poolName, options = {}) {
        const { strategy = 'round-robin', clientIp } = options;
        const candidates = healthyCandidates(poolName);

        if (candidates.length === 0) {
            log.warn(`no healthy backends available for pool "${poolName}"`);
            return null;
        }

        switch (strategy) {
            case 'least-conn':
                return pickLeastConnections(poolName, candidates);
            case 'ip-hash':
                return pickIpHash(candidates, clientIp);
            case 'round-robin':
            case 'weighted':
                return pickRoundRobin(poolName, candidates);
            default:
                throw new Error(`Unknown load balancer strategy: "${strategy}"`);
        }
    }

    function recordConnectionStart(poolName, url) {
        const map = inFlightMapFor(poolName);
        map.set(url, (map.get(url) || 0) + 1);
    }

    function recordConnectionEnd(poolName, url) {
        const map = inFlightMapFor(poolName);
        const next = (map.get(url) || 0) - 1;
        map.set(url, next < 0 ? 0 : next);
    }

    function getConnectionCounts(poolName) {
        const map = inFlightMapFor(poolName);
        return poolBackends(poolName).map((backend) => ({
            url: backend.url,
            inFlight: map.get(backend.url) || 0
        }));
    }

    return {
        pick,
        recordConnectionStart,
        recordConnectionEnd,
        getConnectionCounts
    };
}