import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import childProcess from 'node:child_process';

export function isOpensslAvailable() {
  try {
    childProcess.execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function opensslManualCommand(certPath, keyPath) {
  return `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 365 -subj "/CN=localhost"`;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function generateSelfSignedCert(certPath, keyPath) {
  if (!isOpensslAvailable()) {
    throw new Error(
      `openssl not found on PATH. Generate a certificate manually and re-run:\n${opensslManualCommand(certPath, keyPath)}`
    );
  }

  ensureDirForFile(certPath);
  ensureDirForFile(keyPath);

  const cmd = [
    'openssl req -x509 -newkey rsa:2048 -nodes',
    `-keyout "${keyPath}"`,
    `-out "${certPath}"`,
    '-days 365',
    '-subj "/CN=localhost"'
  ].join(' ');

  childProcess.execSync(cmd, { stdio: 'ignore' });
}

export function ensureCertificate(certPath, keyPath) {
  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);

  if (certExists && keyExists) {
    return { generated: false };
  }

  generateSelfSignedCert(certPath, keyPath);

  return { generated: true };
}

export function loadTlsContext(certPath, keyPath) {
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
}

export function getCertExpiry(certPath) {
  const output = childProcess
    .execFileSync('openssl', ['x509', '-enddate', '-noout', '-in', certPath])
    .toString();

  const match = output.match(/notAfter=(.+)/);

  if (!match) return null;

  const expiry = new Date(match[1].trim());

  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

export function warnIfExpiringSoon(certPath, warnDays, logger) {
  const log = logger || console;

  try {
    const expiry = getCertExpiry(certPath);

    if (!expiry) return null;

    const msRemaining = expiry.getTime() - Date.now();
    const daysRemaining = Math.floor(
      msRemaining / (1000 * 60 * 60 * 24)
    );

    if (daysRemaining <= warnDays) {
      log.warn(
        `TLS certificate ${certPath} expires in ${daysRemaining} day(s) (${expiry.toISOString()})`
      );
    }

    return daysRemaining;
  } catch {
    return null;
  }
}

function buildSniCallback(sniMap) {
  const contextCache = new Map();

  return function SNICallback(hostname, callback) {
    const entry = sniMap[hostname];

    if (!entry) {
      callback(
        new Error(`No TLS configuration for hostname: ${hostname}`)
      );
      return;
    }

    let ctx = contextCache.get(hostname);

    if (!ctx) {
      const { cert, key } = loadTlsContext(
        entry.certPath,
        entry.keyPath
      );

      ctx = tls.createSecureContext({ cert, key });

      contextCache.set(hostname, ctx);
    }

    callback(null, ctx);
  };
}

export function createHttpsServer(
  requestHandler,
  certPath,
  keyPath,
  options = {}
) {
  ensureCertificate(certPath, keyPath);

  const { cert, key } = loadTlsContext(certPath, keyPath);

  const httpsOptions = { cert, key };

  if (options.sni && Object.keys(options.sni).length > 0) {
    httpsOptions.SNICallback = buildSniCallback(options.sni);
  }

  return https.createServer(httpsOptions, requestHandler);
}