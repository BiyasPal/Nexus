import fs from 'node:fs';
import path from 'node:path';

const LEVELS = ['debug', 'info', 'warn', 'error'];

const FORMATS = {
  combined: (entry) =>
    `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms`,
  short: (entry) => `${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms`
};

function levelRank(level) {
  return LEVELS.indexOf(level);
}

function isEnabled(configuredLevel, messageLevel) {
  const configuredIndex = levelRank(configuredLevel);
  const messageIndex = levelRank(messageLevel);
  if (configuredIndex === -1 || messageIndex === -1) return true;
  return messageIndex >= configuredIndex;
}

/**
 * Leveled logger used by every other module (passed around as `logger`).
 * Zero-dep swap for winston/pino: process.stdout.write + node:fs for the
 * optional file target, hand-rolled rotation reusing wal.js's approach.
 */
export function createLogger(loggingConfig = {}) {
  const level = LEVELS.includes(loggingConfig.level) ? loggingConfig.level : 'info';
  const format = FORMATS[loggingConfig.format] ? loggingConfig.format : 'combined';
  const filePath = loggingConfig.filePath || null;
  const toStdout = loggingConfig.stdout !== false;
  const maxFileSizeBytes = loggingConfig.maxFileSizeBytes || 10 * 1024 * 1024;
  const retainFiles = loggingConfig.retainFiles || 5;

  function timestamp() {
    return new Date().toISOString();
  }

  function rotatedPath(index) {
    return `${filePath}.${index}`;
  }

  function rotateIfNeeded() {
    if (!filePath || !fs.existsSync(filePath)) return;
    const { size } = fs.statSync(filePath);
    if (size < maxFileSizeBytes) return;

    for (let i = retainFiles; i >= 1; i -= 1) {
      const src = rotatedPath(i);
      if (!fs.existsSync(src)) continue;
      if (i + 1 > retainFiles) {
        fs.unlinkSync(src);
      } else {
        fs.renameSync(src, rotatedPath(i + 1));
      }
    }
    fs.renameSync(filePath, rotatedPath(1));
  }

  function writeLine(line) {
    if (toStdout) {
      process.stdout.write(`${line}\n`);
    }
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(filePath, `${line}\n`);
    }
  }

  function log(messageLevel, message) {
    if (!isEnabled(level, messageLevel)) return;
    writeLine(`${timestamp()} [${messageLevel.toUpperCase()}] ${message}`);
  }

  /**
   * Standard per-request log line: method, path, status, duration ms.
   * Format is stable on purpose - other modules' tests assert on it.
   */
  function logRequest({ method, path: requestPath, status, durationMs }) {
    if (!isEnabled(level, 'info')) return;
    const entry = {
      timestamp: timestamp(),
      level: 'info',
      method,
      path: requestPath,
      status,
      durationMs
    };
    writeLine(FORMATS[format](entry));
  }

  return {
    debug: (message) => log('debug', message),
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
    logRequest
  };
}
