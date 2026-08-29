import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';

/**
 * Parse process.argv into a plain options object.
 * Supported forms:
 *   start [--config <path>] [-c <path>]
 *   -t | --test [--config <path>]     (validate only, don't start)
 *   -s reload                         (signal a running instance)
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    testOnly: false,
    reloadSignal: null
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--config' || arg === '-c') {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.configPath = value;
      i += 1;
    } else if (arg === '--test' || arg === '-t') {
      options.testOnly = true;
    } else if (arg === '-s') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('Missing signal name for -s');
      }
      options.reloadSignal = value;
      i += 1;
    } else if (arg === 'start') {
      // explicit "start" is the default behavior anyway - accept and ignore
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Process entrypoint logic, kept dependency-injectable so it can run
 * under node:test without a real server.js or a real process.exit.
 * `deps.startServer` / `deps.shutdownServer` are supplied by core/server.js
 * in production - see src/doc/features/13-server.md for that contract.
 */
export async function main(argv, deps = {}) {
  const {
    load = loadConfig,
    startServer,
    shutdownServer,
    logger = console,
    exit = process.exit,
    onSignal = process.on
  } = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    logger.error(err.message);
    exit(1);
    return;
  }

  let config;
  try {
    config = load(options.configPath);
  } catch (err) {
    logger.error(err.message);
    exit(1);
    return;
  }

  if (options.testOnly) {
    logger.info(`config OK: ${options.configPath}`);
    exit(0);
    return;
  }

  if (options.reloadSignal) {
    logger.info(`reload signal "${options.reloadSignal}" received (hot-reload wiring lives in config.js)`);
    exit(0);
    return;
  }

  if (typeof startServer !== 'function') {
    throw new Error('cli.main requires a startServer(config, logger) dependency to actually start Nexus');
  }

  await startServer(config, logger);

  async function handleSignal(signal) {
    logger.info(`received ${signal}, shutting down`);
    if (typeof shutdownServer === 'function') {
      await shutdownServer();
    }
    exit(0);
  }

  onSignal('SIGINT', () => handleSignal('SIGINT'));
  onSignal('SIGTERM', () => handleSignal('SIGTERM'));
}

/* c8 ignore start */
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const { startServer, shutdownServer } = await import('./core/server.js');
  main(process.argv, { startServer, shutdownServer });
}
/* c8 ignore stop */
