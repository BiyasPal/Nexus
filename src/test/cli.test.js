import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs, main } from '../cli.js';

function validConfigFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-test-'));
  const file = path.join(dir, 'nexus.config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      listen: { http: 8080 },
      backends: { web: [{ url: 'http://localhost:9001', weight: 1 }] },
      routes: [{ path: '/', backend: 'web' }]
    })
  );
  return file;
}

function fakeLogger() {
  const logs = { info: [], error: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    error: (msg) => logs.error.push(msg)
  };
}

function fakeExit() {
  const calls = [];
  return { calls, exit: (code) => calls.push(code) };
}

describe('parseArgs', () => {
  test('defaults to DEFAULT_CONFIG_PATH with no flags', () => {
    const options = parseArgs(['node', 'cli.js']);
    assert.equal(options.configPath, './nexus.config.json');
    assert.equal(options.testOnly, false);
    assert.equal(options.reloadSignal, null);
  });

  test('accepts an explicit "start" command as a no-op', () => {
    const options = parseArgs(['node', 'cli.js', 'start']);
    assert.equal(options.testOnly, false);
  });

  test('reads --config <path>', () => {
    const options = parseArgs(['node', 'cli.js', '--config', './custom.json']);
    assert.equal(options.configPath, './custom.json');
  });

  test('reads the short -c alias', () => {
    const options = parseArgs(['node', 'cli.js', '-c', './custom.json']);
    assert.equal(options.configPath, './custom.json');
  });

  test('sets testOnly on -t and --test', () => {
    assert.equal(parseArgs(['node', 'cli.js', '-t']).testOnly, true);
    assert.equal(parseArgs(['node', 'cli.js', '--test']).testOnly, true);
  });

  test('reads a reload signal from -s', () => {
    const options = parseArgs(['node', 'cli.js', '-s', 'reload']);
    assert.equal(options.reloadSignal, 'reload');
  });

  test('throws a clear, non-stack-trace-shaped error on an unknown flag', () => {
    assert.throws(
      () => parseArgs(['node', 'cli.js', '--nope']),
      /Unknown argument: --nope/
    );
  });

  test('throws when --config is given with no value', () => {
    assert.throws(
      () => parseArgs(['node', 'cli.js', '--config']),
      /Missing value for --config/
    );
  });
});

describe('main - bad/missing config', () => {
  test('prints a clear error and exits 1 on a missing config file', async () => {
    const logger = fakeLogger();
    const { calls, exit } = fakeExit();

    await main(['node', 'cli.js', '--config', './does-not-exist.json'], { logger, exit });

    assert.equal(calls[0], 1);
    assert.match(logger.logs.error[0], /Config file not found/);
  });

  test('prints a clear error and exits 1 on invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-test-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not valid json');

    const logger = fakeLogger();
    const { calls, exit } = fakeExit();

    await main(['node', 'cli.js', '--config', file], { logger, exit });

    assert.equal(calls[0], 1);
    assert.match(logger.logs.error[0], /Invalid JSON/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exits 1 with the argv error message on an unknown flag, without a stack trace', async () => {
    const logger = fakeLogger();
    const { calls, exit } = fakeExit();

    await main(['node', 'cli.js', '--nope'], { logger, exit });

    assert.equal(calls[0], 1);
    assert.equal(logger.logs.error[0], 'Unknown argument: --nope');
  });
});

describe('main - test-only mode (-t / --test)', () => {
  test('validates config, logs OK, and exits 0 without starting a server', async () => {
    const file = validConfigFile();
    const logger = fakeLogger();
    const { calls, exit } = fakeExit();
    let startServerCalled = false;

    await main(['node', 'cli.js', '--test', '--config', file], {
      logger,
      exit,
      startServer: async () => {
        startServerCalled = true;
      }
    });

    assert.equal(startServerCalled, false);
    assert.equal(calls[0], 0);
    assert.match(logger.logs.info[0], /config OK/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('main - starting the server and wiring signals', () => {
  test('calls startServer with the loaded config once validation passes', async () => {
    const file = validConfigFile();
    const logger = fakeLogger();
    const { exit } = fakeExit();
    let receivedConfig = null;

    await main(['node', 'cli.js', '--config', file], {
      logger,
      exit,
      startServer: async (config) => {
        receivedConfig = config;
      },
      onSignal: () => {}
    });

    assert.equal(receivedConfig.listen.http, 8080);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  test('wires SIGINT and SIGTERM handlers that call shutdownServer() and exit 0', async () => {
    const file = validConfigFile();
    const logger = fakeLogger();
    const { calls, exit } = fakeExit();
    const registered = {};
    let shutdownCalled = false;

    await main(['node', 'cli.js', '--config', file], {
      logger,
      exit,
      startServer: async () => {},
      shutdownServer: async () => {
        shutdownCalled = true;
      },
      onSignal: (signal, handler) => {
        registered[signal] = handler;
      }
    });

    assert.ok(typeof registered.SIGINT === 'function');
    assert.ok(typeof registered.SIGTERM === 'function');

    await registered.SIGINT();

    assert.equal(shutdownCalled, true);
    assert.equal(calls.at(-1), 0);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  test('throws if asked to start without a startServer dependency', async () => {
    const file = validConfigFile();
    const logger = fakeLogger();
    const { exit } = fakeExit();

    await assert.rejects(
      () => main(['node', 'cli.js', '--config', file], { logger, exit }),
      /requires a startServer/
    );
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('main - reload signal (-s reload, stretch)', () => {
  test('acknowledges the signal and exits 0 without starting a server', async () => {
    const file = validConfigFile();
    const logger = fakeLogger();
    const { calls, exit } = fakeExit();
    let startServerCalled = false;

    await main(['node', 'cli.js', '-s', 'reload', '--config', file], {
      logger,
      exit,
      startServer: async () => {
        startServerCalled = true;
      }
    });

    assert.equal(startServerCalled, false);
    assert.equal(calls[0], 0);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
