import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../../observability/logger.js';

function captureStdout() {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    }
  };
}

describe('createLogger - level gating', () => {
  test('logs info/warn/error by default, suppresses debug', () => {
    const capture = captureStdout();
    const logger = createLogger();

    logger.debug('should be hidden');
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');

    capture.restore();

    assert.equal(capture.lines.length, 3);
    assert.match(capture.lines[0], /\[INFO\] hello/);
    assert.match(capture.lines[1], /\[WARN\] careful/);
    assert.match(capture.lines[2], /\[ERROR\] boom/);
  });

  test('debug level shows debug lines when explicitly configured', () => {
    const capture = captureStdout();
    const logger = createLogger({ level: 'debug' });

    logger.debug('now visible');

    capture.restore();

    assert.equal(capture.lines.length, 1);
    assert.match(capture.lines[0], /\[DEBUG\] now visible/);
  });

  test('error level suppresses info and warn', () => {
    const capture = captureStdout();
    const logger = createLogger({ level: 'error' });

    logger.info('quiet please');
    logger.warn('still quiet');
    logger.error('this one gets through');

    capture.restore();

    assert.equal(capture.lines.length, 1);
    assert.match(capture.lines[0], /\[ERROR\] this one gets through/);
  });

  test('every line carries an ISO 8601 timestamp', () => {
    const capture = captureStdout();
    const logger = createLogger();

    logger.info('timestamped');

    capture.restore();

    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
    assert.match(capture.lines[0], isoPattern);
  });
});

describe('createLogger - request log line format', () => {
  test('logRequest writes a stable "combined" line by default', () => {
    const capture = captureStdout();
    const logger = createLogger();

    logger.logRequest({ method: 'GET', path: '/api/users', status: 200, durationMs: 12 });

    capture.restore();

    assert.equal(capture.lines.length, 1);
    assert.match(capture.lines[0], /\[INFO\] GET \/api\/users 200 12ms/);
  });

  test('"short" format preset drops the timestamp/level prefix', () => {
    const capture = captureStdout();
    const logger = createLogger({ format: 'short' });

    logger.logRequest({ method: 'POST', path: '/api', status: 404, durationMs: 3 });

    capture.restore();

    assert.equal(capture.lines[0].trim(), 'POST /api 404 3ms\n'.trim());
  });

  test('logRequest respects level gating like any other log call', () => {
    const capture = captureStdout();
    const logger = createLogger({ level: 'error' });

    logger.logRequest({ method: 'GET', path: '/', status: 200, durationMs: 1 });

    capture.restore();

    assert.equal(capture.lines.length, 0);
  });
});

describe('createLogger - file target', () => {
  test('writes to both stdout and a file when filePath is configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-logger-test-'));
    const filePath = path.join(dir, 'nested', 'nexus.log');
    const capture = captureStdout();

    const logger = createLogger({ filePath });
    logger.info('goes to both places');

    capture.restore();

    const fileContents = fs.readFileSync(filePath, 'utf8');
    assert.match(fileContents, /\[INFO\] goes to both places/);
    assert.equal(capture.lines.length, 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stdout can be disabled independently of the file target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-logger-test-'));
    const filePath = path.join(dir, 'nexus.log');
    const capture = captureStdout();

    const logger = createLogger({ filePath, stdout: false });
    logger.info('file only');

    capture.restore();

    assert.equal(capture.lines.length, 0);
    assert.match(fs.readFileSync(filePath, 'utf8'), /file only/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rotates the file once it exceeds maxFileSizeBytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-logger-test-'));
    const filePath = path.join(dir, 'nexus.log');
    const capture = captureStdout();

    const logger = createLogger({ filePath, maxFileSizeBytes: 10, stdout: false });
    logger.info('first line is already past ten bytes');
    logger.info('second line triggers rotation of the first');

    capture.restore();

    assert.ok(fs.existsSync(`${filePath}.1`), 'expected a rotated .1 file to exist');
    assert.ok(fs.existsSync(filePath), 'expected a fresh current log file to exist');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
