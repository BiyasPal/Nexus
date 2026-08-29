import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWal } from '../../reliability/wal.js';

function fakeLogger() {
  const logs = { error: [] };
  return { logs, info: () => { }, warn: () => { }, error: (msg) => logs.error.push(msg) };
}

function installFakeFs(t, initialFiles = {}) {
  const files = { ...initialFiles };

  t.mock.method(fs, 'mkdirSync', () => undefined);

  t.mock.method(fs, 'existsSync', (filePath) => Object.prototype.hasOwnProperty.call(files, filePath));

  t.mock.method(fs, 'statSync', (filePath) => ({ size: Buffer.byteLength(files[filePath] || '', 'utf8') }));

  t.mock.method(fs, 'renameSync', (from, to) => {
    files[to] = files[from];
    delete files[from];
  });

  t.mock.method(fs, 'unlinkSync', (filePath) => {
    delete files[filePath];
  });

  t.mock.method(fs, 'readdirSync', (dir) => {
    return Object.keys(files)
      .filter((filePath) => path.dirname(filePath) === dir)
      .map((filePath) => path.basename(filePath));
  });

  t.mock.method(fs, 'readFileSync', (filePath) => files[filePath] || '');

  t.mock.method(fs.promises, 'appendFile', async (filePath, data) => {
    files[filePath] = (files[filePath] || '') + data;
  });

  return files;
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    path: './data/wal',
    flushIntervalMs: 1000,
    maxFileSizeBytes: 1024,
    retainFiles: 3,
    ...overrides
  };
}

describe('createWal - buffering', () => {
  test('recordStart and recordFinish buffer entries without writing to disk', (t) => {
    const files = installFakeFs(t);
    const wal = createWal(baseConfig(), fakeLogger());
    wal.recordStart('req-1', { method: 'GET', path: '/' });
    wal.recordFinish('req-1', { status: 200 });
    assert.deepEqual(files, {});
  });

  test('disabled wal never buffers, writes, or starts a timer', async (t) => {
    installFakeFs(t);
    const appendMock = t.mock.method(fs.promises, 'appendFile', async () => { });
    const wal = createWal(baseConfig({ enabled: false }), fakeLogger());
    wal.recordStart('req-1', {});
    wal.recordFinish('req-1', {});
    await wal.flush();
    wal.start();
    assert.equal(appendMock.mock.callCount(), 0);
    await wal.stop();
    assert.equal(appendMock.mock.callCount(), 0);
  });
});

describe('createWal - flush', () => {
  test('flush writes buffered entries as newline-delimited JSON', async (t) => {
    const files = installFakeFs(t);
    const wal = createWal(baseConfig(), fakeLogger());
    wal.recordStart('req-1', { method: 'GET', path: '/' });
    wal.recordFinish('req-1', { status: 200 });
    await wal.flush();

    const currentFile = path.join('./data/wal', 'wal.log');
    const lines = files[currentFile].trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, 'start');
    assert.equal(lines[0].requestId, 'req-1');
    assert.equal(lines[1].type, 'finish');
    assert.equal(lines[1].status, 200);
  });

  test('flush with an empty buffer does not touch the filesystem', async (t) => {
    installFakeFs(t);
    const appendMock = t.mock.method(fs.promises, 'appendFile', async () => { });
    const wal = createWal(baseConfig(), fakeLogger());
    await wal.flush();
    assert.equal(appendMock.mock.callCount(), 0);
  });

  test('flush ensures the wal directory exists before appending', async (t) => {
    installFakeFs(t);
    const mkdirMock = t.mock.method(fs, 'mkdirSync', () => undefined);
    const wal = createWal(baseConfig(), fakeLogger());
    wal.recordStart('req-1', {});
    await wal.flush();
    assert.ok(mkdirMock.mock.callCount() >= 1);
    assert.equal(mkdirMock.mock.calls[0].arguments[0], path.normalize('./data/wal'));
  });

  test('flush restores buffered entries and logs on write failure', async (t) => {
    installFakeFs(t);
    t.mock.method(fs.promises, 'appendFile', async () => {
      throw new Error('disk full');
    });
    const logger = fakeLogger();
    const wal = createWal(baseConfig(), logger);
    wal.recordStart('req-1', {});
    await wal.flush();
    assert.equal(logger.logs.error.length, 1);
    assert.match(logger.logs.error[0], /disk full/);

    wal.recordFinish('req-1', {});
    const appendCalls = [];
    t.mock.method(fs.promises, 'appendFile', async (filePath, data) => {
      appendCalls.push(data);
    });
    await wal.flush();
    const restored = appendCalls[0].trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(restored.length, 2);
    assert.equal(restored[0].type, 'start');
    assert.equal(restored[1].type, 'finish');
  });
});

describe('createWal - rotation', () => {
  test('rotateIfNeeded rotates the current file once it reaches the max size', async (t) => {
    const currentFile = path.join('./data/wal', 'wal.log');
    const files = installFakeFs(t, { [currentFile]: 'x'.repeat(2000) });
    const wal = createWal(baseConfig({ maxFileSizeBytes: 1024 }), fakeLogger());
    wal.rotateIfNeeded();
    assert.equal(files[currentFile], undefined);
    assert.equal(files[path.join('./data/wal', 'wal.log.1')], 'x'.repeat(2000));
  });

  test('rotate cascades existing rotated files and deletes the oldest beyond retention', async (t) => {
    const dir = './data/wal';
    const currentFile = path.join(dir, 'wal.log');
    const files = installFakeFs(t, {
      [currentFile]: 'current-data',
      [path.join(dir, 'wal.log.1')]: 'rotated-1',
      [path.join(dir, 'wal.log.2')]: 'rotated-2'
    });
    const wal = createWal(baseConfig({ maxFileSizeBytes: 1, retainFiles: 2 }), fakeLogger());
    wal.rotateIfNeeded();

    assert.equal(files[path.join(dir, 'wal.log.1')], 'current-data');
    assert.equal(files[path.join(dir, 'wal.log.2')], 'rotated-1');
    assert.equal(files[path.join(dir, 'wal.log.3')], undefined);
    assert.equal(files[currentFile], undefined);
  });
});

describe('createWal - start/stop', () => {
  test('start flushes on the configured interval and stop performs a final flush', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const files = installFakeFs(t);
    const wal = createWal(baseConfig({ flushIntervalMs: 500 }), fakeLogger());

    wal.start();
    wal.recordStart('req-1', {});
    t.mock.timers.tick(500);
    await Promise.resolve();
    await Promise.resolve();

    const currentFile = path.join('./data/wal', 'wal.log');
    assert.ok(files[currentFile].includes('req-1'));

    wal.recordFinish('req-1', {});
    await wal.stop();
    assert.ok(files[currentFile].includes('finish'));
  });

  test('start is idempotent and stop can be called safely when never started', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    installFakeFs(t);
    const wal = createWal(baseConfig(), fakeLogger());
    wal.start();
    wal.start();
    await assert.doesNotReject(() => wal.stop());
  });
});

describe('createWal - replay', () => {
  test('replay reconstructs chronological entries across the current and rotated files, newest first internally', async (t) => {
    const dir = './data/wal';
    const currentFile = path.join(dir, 'wal.log');
    const rotated1 = path.join(dir, 'wal.log.1');
    const older = [
      { type: 'start', requestId: 'req-1', ts: 1 },
      { type: 'finish', requestId: 'req-1', ts: 2 }
    ];
    const newer = [
      { type: 'start', requestId: 'req-2', ts: 3 },
      { type: 'finish', requestId: 'req-2', ts: 4 }
    ];
    installFakeFs(t, {
      [rotated1]: older.map((e) => JSON.stringify(e)).join('\n') + '\n',
      [currentFile]: newer.map((e) => JSON.stringify(e)).join('\n') + '\n'
    });
    const wal = createWal(baseConfig(), fakeLogger());
    const result = wal.replay(10);
    assert.deepEqual(
      result.entries.map((e) => e.requestId),
      ['req-1', 'req-1', 'req-2', 'req-2']
    );
    assert.equal(result.uncleanShutdown, false);
  });

  test('replay detects an unclean shutdown when a start has no matching finish', async (t) => {
    const dir = './data/wal';
    const currentFile = path.join(dir, 'wal.log');
    const entries = [
      { type: 'start', requestId: 'req-1', ts: 1 },
      { type: 'finish', requestId: 'req-1', ts: 2 },
      { type: 'start', requestId: 'req-2', ts: 3 }
    ];
    installFakeFs(t, {
      [currentFile]: entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    });
    const wal = createWal(baseConfig(), fakeLogger());
    const result = wal.replay(10);
    assert.equal(result.uncleanShutdown, true);
    assert.deepEqual(result.inFlightRequestIds, ['req-2']);
  });

  test('replay respects the limit and keeps only the most recent entries', async (t) => {
    const dir = './data/wal';
    const currentFile = path.join(dir, 'wal.log');
    const entries = [];
    for (let i = 1; i <= 5; i += 1) {
      entries.push({ type: 'start', requestId: `req-${i}`, ts: i });
      entries.push({ type: 'finish', requestId: `req-${i}`, ts: i });
    }
    installFakeFs(t, {
      [currentFile]: entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    });
    const wal = createWal(baseConfig(), fakeLogger());
    const result = wal.replay(4);
    assert.equal(result.entries.length, 4);
    assert.deepEqual(
      result.entries.map((e) => e.requestId),
      ['req-4', 'req-4', 'req-5', 'req-5']
    );
  });

  test('replay returns an empty result when no wal files exist yet', (t) => {
    installFakeFs(t);
    const wal = createWal(baseConfig(), fakeLogger());
    const result = wal.replay(10);
    assert.deepEqual(result.entries, []);
    assert.equal(result.uncleanShutdown, false);
  });
});