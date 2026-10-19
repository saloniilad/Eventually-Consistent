import { loadConfig } from './config';
import { startServer } from './server';
import { MemoryStore } from './store/memory';
import { PostgresStore } from './store/postgres';
import type { Store } from './store/types';
import { log, setLogLevel } from './util/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  let store: Store;
  if (config.databaseUrl) {
    store = new PostgresStore(config.databaseUrl);
  } else {
    log.warn('DATABASE_URL not set: using in-memory store, data will be lost on restart');
    store = new MemoryStore();
  }
  await store.init();

  const server = await startServer(config, store);
  log.info('listening', { port: server.port });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    await server.stop();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', { err: String(err) });
  process.exit(1);
});
