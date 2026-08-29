import fs from 'node:fs';
import path from 'node:path';

const WAL_FILENAME = 'wal.log';

export function createWal(walConfig, logger) {
  const log = logger || console;
  const walDir = path.normalize(walConfig.path);
  const flushIntervalMs = walConfig.flushIntervalMs;
  const maxFileSizeBytes = walConfig.maxFileSizeBytes;
  const retainFiles = walConfig.retainFiles;
  const enabled = walConfig.enabled !== false;

  const currentFilePath = path.join(walDir, WAL_FILENAME);

  let buffer = [];
  let timer = null;
  let flushing = Promise.resolve();

  function ensureDir() {
    fs.mkdirSync(walDir, { recursive: true });
  }

  function rotatedPath(index) {
    return path.join(walDir, `${WAL_FILENAME}.${index}`);
  }

  function rotate() {
    for (let i = retainFiles; i >= 1; i -= 1) {
      const src = rotatedPath(i);
      if (!fs.existsSync(src)) continue;
      if (i + 1 > retainFiles) {
        fs.unlinkSync(src);
      } else {
        fs.renameSync(src, rotatedPath(i + 1));
      }
    }
    if (fs.existsSync(currentFilePath)) {
      fs.renameSync(currentFilePath, rotatedPath(1));
    }
  }

  function rotateIfNeeded() {
    if (!fs.existsSync(currentFilePath)) return;
    const stats = fs.statSync(currentFilePath);
    if (stats.size >= maxFileSizeBytes) {
      rotate();
    }
  }

  function recordStart(requestId, meta = {}) {
    if (!enabled) return;
    buffer.push({ type: 'start', requestId, ts: Date.now(), ...meta });
  }

  function recordFinish(requestId, meta = {}) {
    if (!enabled) return;
    buffer.push({ type: 'finish', requestId, ts: Date.now(), ...meta });
  }

  async function flush() {
    if (!enabled) return;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const lines = `${batch.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    ensureDir();
    flushing = flushing
      .then(() => fs.promises.appendFile(currentFilePath, lines, 'utf8'))
      .then(() => {
        rotateIfNeeded();
      })
      .catch((err) => {
        buffer = batch.concat(buffer);
        log.error(`WAL flush failed: ${err.message}`);
      });
    await flushing;
  }

  function start() {
    if (!enabled || timer) return;
    ensureDir();
    timer = setInterval(() => {
      flush().catch((err) => log.error(`WAL flush interval failed: ${err.message}`));
    }, flushIntervalMs);
    if (timer.unref) timer.unref();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await flush();
  }

  function listRotatedFilesNewestFirst() {
    let names;
    try {
      names = fs.readdirSync(walDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith(`${WAL_FILENAME}.`))
      .sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
      .map((name) => path.join(walDir, name));
  }

  function readEntriesFromFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  }

  function replay(limit = 100) {
    const filesNewestFirst = [];
    if (fs.existsSync(currentFilePath)) {
      filesNewestFirst.push(currentFilePath);
    }
    filesNewestFirst.push(...listRotatedFilesNewestFirst());

    const collectedNewestFirst = [];
    for (const filePath of filesNewestFirst) {
      const fileEntries = readEntriesFromFile(filePath);
      for (let i = fileEntries.length - 1; i >= 0; i -= 1) {
        collectedNewestFirst.push(fileEntries[i]);
        if (collectedNewestFirst.length >= limit) break;
      }
      if (collectedNewestFirst.length >= limit) break;
    }

    const entries = collectedNewestFirst.reverse();
    const startedIds = new Set(entries.filter((e) => e.type === 'start').map((e) => e.requestId));
    const finishedIds = new Set(entries.filter((e) => e.type === 'finish').map((e) => e.requestId));
    const inFlightRequestIds = [...startedIds].filter((id) => !finishedIds.has(id));

    return {
      entries,
      uncleanShutdown: inFlightRequestIds.length > 0,
      inFlightRequestIds
    };
  }

  return {
    recordStart,
    recordFinish,
    flush,
    start,
    stop,
    rotateIfNeeded,
    replay
  };
}